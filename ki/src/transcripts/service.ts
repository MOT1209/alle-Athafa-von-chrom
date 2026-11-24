import { AppError } from '../core/errors';
import type { VideoRecord } from '../capture/videos';
import { updateSegmentText, transcriptSignature, type EditSegmentResult } from './editor';
import { searchTranscripts, type TranscriptSearchHit } from './search';

export interface TranscriptVideoSource {
  get(id: string): Promise<VideoRecord | undefined>;
  listRecords(): Promise<VideoRecord[]>;
  updateTranscript(
    id: string,
    transcript: VideoRecord['transcript'],
    editedAt?: number,
  ): Promise<VideoRecord | undefined>;
}

export interface TranscriptServiceDeps {
  videos: TranscriptVideoSource;
  now?: () => number;
}

export interface UpdateSegmentResult {
  record: VideoRecord;
  changed: boolean;
  transcript: VideoRecord['transcript'];
}

export class TranscriptService {
  private readonly videos: TranscriptVideoSource;
  private readonly now: () => number;

  constructor(deps: TranscriptServiceDeps) {
    this.videos = deps.videos;
    this.now = deps.now ?? Date.now;
  }

  async get(videoRecordId: string): Promise<VideoRecord | undefined> {
    return this.videos.get(this.requireId(videoRecordId));
  }

  async updateSegment(
    videoRecordId: string,
    index: number,
    text: string,
  ): Promise<UpdateSegmentResult> {
    const recordId = this.requireId(videoRecordId);
    const record = await this.videos.get(recordId);
    if (!record) {
      throw new AppError(
        'INVALID_INPUT',
        'The video was not found in the local library. Capture it first.',
      );
    }
    const result: EditSegmentResult = updateSegmentText(
      record.transcript,
      index,
      text,
    );
    if (!result.changed) {
      return { record, changed: false, transcript: record.transcript };
    }
    const editedAt = this.now();
    const updated = await this.videos.updateTranscript(recordId, result.transcript, editedAt);
    if (!updated) {
      throw new AppError('STORAGE', 'The transcript could not be saved.');
    }
    return { record: updated, changed: true, transcript: updated.transcript };
  }

  async search(query: string, limit?: number): Promise<TranscriptSearchHit[]> {
    const records = await this.videos.listRecords();
    return searchTranscripts(records, query, limit);
  }

  signature(record: VideoRecord): string {
    return transcriptSignature(record.transcript);
  }

  private requireId(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'A local video record id is required');
    }
    return value.trim();
  }
}