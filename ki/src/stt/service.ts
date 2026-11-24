import { AppError } from '../core/errors';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { SttProvider, Transcript } from '../ai/types';
import type { VideoRecord } from '../capture/videos';

export interface SttVideoStore {
  save(record: VideoRecord, now?: number): Promise<unknown>;
  get(id: string): Promise<VideoRecord | undefined>;
}

export interface SttServiceDeps {
  videos: SttVideoStore;
  queue: TaskQueue;
  makeProvider: () => SttProvider;
  now?: () => number;
}

export interface TranscribeInput {
  name: string;
  mimeType?: string;
  data: string; // base64
  language?: string;
}

export interface TranscribeResult {
  taskId: string;
  deduped: boolean;
}

const TASK_KIND = 'audio-transcribe';

function slugify(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'audio';
}

export class SttService {
  private readonly videos: SttVideoStore;
  private readonly queue: TaskQueue;
  private readonly makeProvider: () => SttProvider;
  private readonly now: () => number;
  private readonly inflight = new Map<string, string>();

  constructor(deps: SttServiceDeps) {
    this.videos = deps.videos;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
    this.now = deps.now ?? Date.now;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (typeof input?.data !== 'string' || input.data.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'Audio data is required');
    }
    const name = (input.name || 'audio').trim();
    const id = `file_${slugify(name)}`;

    const running = this.inflight.get(id);
    if (running) {
      const view = this.queue.get(running);
      if (view && (view.status === 'queued' || view.status === 'running')) {
        return { taskId: running, deduped: true };
      }
      this.inflight.delete(id);
    }

    let audioBlob: Blob;
    try {
      const binary = atob(input.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      audioBlob = new Blob([bytes], { type: input.mimeType || 'audio/*' });
    } catch {
      throw new AppError('INVALID_INPUT', 'Audio data is not valid base64');
    }

    const token = { id: '' };
    let task: TaskView;
    try {
      task = this.queue.enqueue({
        kind: TASK_KIND,
        label: `Transcribe: ${name}`,
        meta: { fileName: name },
        run: async (ctx) => {
          const provider = this.makeProvider();
          const transcript: Transcript = await provider.transcribe(audioBlob, {
            ...(input.language ? { language: input.language } : {}),
            signal: ctx.signal,
          });
          if (ctx.signal.aborted) throw new AppError('CANCELLED', 'Transcription cancelled');

          const record: VideoRecord = {
            id,
            platform: 'file',
            videoId: id,
            url: `file://${name}`,
            title: name,
            segmentCount: transcript.segments.length,
            capturedAt: this.now(),
            transcript,
          };
          if (input.language) record.language = input.language;
          await this.videos.save(record, this.now());
          if (ctx.signal.aborted) throw new AppError('CANCELLED', 'Transcription cancelled');
          return { videoRecordId: id, segmentCount: transcript.segments.length };
        },
      });
    } catch (err) {
      throw err;
    }
    token.id = task.id;
    this.inflight.set(id, task.id);
    return { taskId: task.id, deduped: false };
  }

  async health() {
    const provider = this.makeProvider();
    const h = (await provider.health?.()) ?? { ok: false };
    return { available: h.ok === true, error: h.ok ? undefined : 'Whisper server not reachable' };
  }
}