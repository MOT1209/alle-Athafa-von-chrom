import {
  isSummaryChapter,
  isSummaryKeyPoint,
  type StructuredSummary,
} from '../ai/summary/schema';
import { AppError } from '../core/errors';
import type { KeyValueStore } from '../storage/kv';

/**
 * Local summary records. One current summary per captured video, keyed by the
 * video record id; regenerating replaces it. A small metadata index powers the
 * summary list without reading every transcript-sized record.
 */

export interface SummaryRecord extends StructuredSummary {
  /** Local video record id (`yt_<videoId>`), not the raw YouTube id. */
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  model: string;
  chunkCount: number;
  segmentCount: number;
  createdAt: number;
  durationMs?: number;
}

export interface SummaryListItem {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  model: string;
  chunkCount: number;
  keyPointCount: number;
  chapterCount: number;
  createdAt: number;
  durationMs?: number;
  overviewPreview: string;
}

export const SUMMARIES_INDEX_KEY = 'videoking.summaries.index.v1';
export const summaryRecordKey = (videoRecordId: string): string =>
  `videoking.summary.${videoRecordId}`;

const INDEX_LIMIT = 200;
const PREVIEW_CHARS = 220;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasValidContent(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.overview) &&
    Array.isArray(value.keyPoints) &&
    value.keyPoints.length > 0 &&
    value.keyPoints.every(isSummaryKeyPoint) &&
    Array.isArray(value.chapters) &&
    value.chapters.length > 0 &&
    value.chapters.every(isSummaryChapter)
  );
}

function isSummaryRecord(value: unknown): value is SummaryRecord {
  if (!isRecord(value) || !hasValidContent(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonEmptyString(value.model) &&
    isNonNegativeNumber(value.chunkCount) &&
    isNonNegativeNumber(value.segmentCount) &&
    isNonNegativeNumber(value.createdAt) &&
    (value.durationMs === undefined || isNonNegativeNumber(value.durationMs))
  );
}

function isSummaryListItem(value: unknown): value is SummaryListItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonEmptyString(value.model) &&
    isNonNegativeNumber(value.chunkCount) &&
    isNonNegativeNumber(value.keyPointCount) &&
    isNonNegativeNumber(value.chapterCount) &&
    isNonNegativeNumber(value.createdAt) &&
    (value.durationMs === undefined || isNonNegativeNumber(value.durationMs)) &&
    typeof value.overviewPreview === 'string'
  );
}

function toListItem(record: SummaryRecord): SummaryListItem {
  const overview = record.overview.trim();
  const preview =
    overview.length > PREVIEW_CHARS
      ? `${overview.slice(0, PREVIEW_CHARS).trimEnd()}…`
      : overview;
  const item: SummaryListItem = {
    videoRecordId: record.videoRecordId,
    videoTitle: record.videoTitle,
    videoUrl: record.videoUrl,
    model: record.model,
    chunkCount: record.chunkCount,
    keyPointCount: record.keyPoints.length,
    chapterCount: record.chapters.length,
    createdAt: record.createdAt,
    overviewPreview: preview,
  };
  if (record.durationMs !== undefined) item.durationMs = record.durationMs;
  return item;
}

export class SummaryRepository {
  constructor(private kv: KeyValueStore) {}

  async save(record: SummaryRecord): Promise<SummaryRecord> {
    if (!isSummaryRecord(record)) {
      throw new AppError(
        'INVALID_INPUT',
        'Refusing to store an invalid summary record',
      );
    }
    const stored: SummaryRecord = {
      ...record,
      videoRecordId: record.videoRecordId.trim(),
    };
    await this.kv.set(summaryRecordKey(stored.videoRecordId), stored);
    const index = await this.readIndex();
    const next = [
      toListItem(stored),
      ...index.filter((entry) => entry.videoRecordId !== stored.videoRecordId),
    ].slice(0, INDEX_LIMIT);
    await this.kv.set(SUMMARIES_INDEX_KEY, next);
    return stored;
  }

  async get(videoRecordId: string): Promise<SummaryRecord | undefined> {
    const raw = await this.kv.get<unknown>(summaryRecordKey(videoRecordId));
    if (raw === undefined) return undefined;
    if (!isSummaryRecord(raw)) {
      throw new AppError(
        'STORAGE',
        `Stored summary is corrupt: ${videoRecordId}`,
      );
    }
    return raw;
  }

  async list(): Promise<SummaryListItem[]> {
    return this.readIndex();
  }

  async remove(videoRecordId: string): Promise<boolean> {
    const key = summaryRecordKey(videoRecordId);
    const [current, index] = await Promise.all([
      this.kv.get<unknown>(key),
      this.readIndex(),
    ]);
    const inIndex = index.some(
      (entry) => entry.videoRecordId === videoRecordId,
    );
    await this.kv.remove(key);
    await this.kv.set(
      SUMMARIES_INDEX_KEY,
      index.filter((entry) => entry.videoRecordId !== videoRecordId),
    );
    return current !== undefined || inIndex;
  }

  private async readIndex(): Promise<SummaryListItem[]> {
    const raw = await this.kv.get<unknown>(SUMMARIES_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const items: SummaryListItem[] = [];
    for (const entry of raw) {
      if (!isSummaryListItem(entry) || seen.has(entry.videoRecordId)) continue;
      seen.add(entry.videoRecordId);
      items.push(entry);
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }
}
