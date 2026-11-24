import type { Transcript } from '../ai/types';
import { AppError } from '../core/errors';
import type { KeyValueStore } from '../storage/kv';

/**
 * Local knowledge records for captured videos. Each record lives under its
 * own key; a lightweight index (metadata only) powers the library list.
 * Everything stays on-device in chrome.storage.local.
 */

export interface VideoSummary {
  id: string;
  platform: 'youtube' | 'file';
  videoId: string;
  url: string;
  title: string;
  channel?: string;
  durationMs?: number;
  language?: string;
  captionKind?: 'manual' | 'asr';
  segmentCount: number;
  capturedAt: number;
  editedAt?: number;
}

export interface VideoRecord extends VideoSummary {
  transcript: Transcript;
}

export const VIDEOS_INDEX_KEY = 'videoking.videos.index.v1';
export const videoRecordKey = (id: string): string => `videoking.video.${id}`;
export const videoIdFor = (platformVideoId: string): string =>
  `yt_${platformVideoId}`;

const INDEX_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVideoSummary(value: unknown): value is VideoSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.platform === 'youtube' || value.platform === 'file') &&
    typeof value.videoId === 'string' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.segmentCount === 'number' &&
    typeof value.capturedAt === 'number'
  );
}

export class VideoRepository {
  constructor(private kv: KeyValueStore) {}

  async save(record: VideoRecord, now: number = Date.now()): Promise<VideoSummary> {
    if (!isVideoSummary(record) || !isRecord((record as VideoRecord).transcript)) {
      throw new AppError('INVALID_INPUT', 'Invalid video record');
    }
    const stored: VideoRecord = { ...record, capturedAt: now };
    await this.kv.set(videoRecordKey(record.id), stored);
    const index = await this.readIndex();
    const summary = toSummary(stored);
    const next = [summary, ...index.filter((entry) => entry.id !== record.id)]
      .slice(0, INDEX_LIMIT);
    await this.kv.set(VIDEOS_INDEX_KEY, next);
    return summary;
  }

  async get(id: string): Promise<VideoRecord | undefined> {
    const raw = await this.kv.get<unknown>(videoRecordKey(id));
    if (raw === undefined) return undefined;
    if (!isVideoSummary(raw) || !isRecord((raw as VideoRecord).transcript)) {
      throw new AppError('STORAGE', `Stored video record is corrupt: ${id}`);
    }
    return raw as unknown as VideoRecord;
  }

  async list(): Promise<VideoSummary[]> {
    return this.readIndex();
  }

  async listRecords(): Promise<VideoRecord[]> {
    const index = await this.readIndex();
    const records: VideoRecord[] = [];
    for (const summary of index) {
      const record = await this.get(summary.id);
      if (record) records.push(record);
    }
    return records;
  }

  async updateTranscript(
    id: string,
    transcript: Transcript,
    editedAt: number = Date.now(),
  ): Promise<VideoRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const updated: VideoRecord = {
      ...existing,
      transcript,
      segmentCount: transcript.segments.length,
      editedAt,
    };
    await this.kv.set(videoRecordKey(id), updated);
    const index = await this.readIndex();
    const summary = toSummary(updated);
    await this.kv.set(
      VIDEOS_INDEX_KEY,
      [summary, ...index.filter((entry) => entry.id !== id)].slice(0, INDEX_LIMIT),
    );
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const index = await this.readIndex();
    const existed = index.some((entry) => entry.id === id);
    await this.kv.remove(videoRecordKey(id));
    await this.kv.set(
      VIDEOS_INDEX_KEY,
      index.filter((entry) => entry.id !== id),
    );
    return existed;
  }

  private async readIndex(): Promise<VideoSummary[]> {
    const raw = await this.kv.get<unknown>(VIDEOS_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    // Corrupt entries are dropped from display (fail-safe), never "repaired".
    return raw.filter(isVideoSummary);
  }
}

function toSummary(record: VideoRecord): VideoSummary {
  const summary: VideoSummary = {
    id: record.id,
    platform: record.platform,
    videoId: record.videoId,
    url: record.url,
    title: record.title,
    segmentCount: record.segmentCount,
    capturedAt: record.capturedAt,
  };
  if (record.channel !== undefined) summary.channel = record.channel;
  if (record.durationMs !== undefined) summary.durationMs = record.durationMs;
  if (record.language !== undefined) summary.language = record.language;
  if (record.captionKind !== undefined) summary.captionKind = record.captionKind;
  return summary;
}
