import { AppError } from '../core/errors';
import { MIN_NUM_CTX } from '../ai/summary/chunking';
import {
  ensureNotAborted,
  summarizeTranscript,
} from '../ai/summary/summarizer';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { LlmProvider } from '../ai/types';
import type { VideoRecord } from '../capture/videos';
import type { Settings, SettingsStore } from '../storage/settings';
import type {
  SummaryListItem,
  SummaryRecord,
} from './repository';

/**
 * Summary orchestration. Generation runs through the shared sequential queue
 * (never a second model call in parallel), persists only validated output, and
 * deduplicates concurrent requests for the same video.
 */

export interface VideoSource {
  get(id: string): Promise<VideoRecord | undefined>;
}

export interface SummaryStore {
  save(record: SummaryRecord): Promise<SummaryRecord>;
  get(videoRecordId: string): Promise<SummaryRecord | undefined>;
  list(): Promise<SummaryListItem[]>;
  remove(videoRecordId: string): Promise<boolean>;
}

export interface SummaryServiceDeps {
  settings: SettingsStore;
  videos: VideoSource;
  summaries: SummaryStore;
  queue: TaskQueue;
  makeProvider: (settings: Settings) => LlmProvider;
  now?: () => number;
}

export interface GenerateSummaryResult {
  taskId: string;
  deduped: boolean;
}

export interface SummaryTaskResult {
  videoRecordId: string;
  createdAt: number;
  keyPointCount: number;
  chapterCount: number;
}

interface Inflight {
  taskId: string;
}

const TASK_KIND = 'video-summary';

export class SummaryService {
  private readonly settings: SettingsStore;
  private readonly videos: VideoSource;
  private readonly summaries: SummaryStore;
  private readonly queue: TaskQueue;
  private readonly makeProvider: SummaryServiceDeps['makeProvider'];
  private readonly now: () => number;
  private readonly inflight = new Map<string, Inflight>();

  constructor(deps: SummaryServiceDeps) {
    this.settings = deps.settings;
    this.videos = deps.videos;
    this.summaries = deps.summaries;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
    this.now = deps.now ?? Date.now;
  }

  async generate(videoRecordId: string): Promise<GenerateSummaryResult> {
    const recordId = this.requireRecordId(videoRecordId);

    const running = this.activeTask(recordId);
    if (running) return { taskId: running, deduped: true };

    const [settings, video] = await Promise.all([
      this.settings.load(),
      this.videos.get(recordId),
    ]);
    if (!video) {
      throw new AppError(
        'INVALID_INPUT',
        'The video was not found in the local library. Capture it first.',
      );
    }
    this.requireContext(settings.generation.numCtx);

    // Re-check after the awaits: a request may have started while we loaded.
    const raced = this.activeTask(recordId);
    if (raced) return { taskId: raced, deduped: true };

    const token: Inflight = { taskId: '' };
    this.inflight.set(recordId, token);
    let task: TaskView;
    try {
      task = this.queue.enqueue({
        kind: TASK_KIND,
        label: `Summarize: ${video.title}`,
        model: settings.generation.model,
        meta: { videoRecordId: recordId },
        run: async (ctx) => {
          try {
            const current = await this.settings.load();
            this.requireContext(current.generation.numCtx);
            const source = await this.videos.get(recordId);
            if (!source) {
              throw new AppError(
                'INVALID_INPUT',
                'The video was deleted before summarization started.',
              );
            }
            const provider = this.makeProvider(current);
            const result = await summarizeTranscript(
              {
                title: source.title,
                ...(source.durationMs === undefined
                  ? {}
                  : { durationMs: source.durationMs }),
                transcript: source.transcript,
              },
              {
                provider,
                model: current.generation.model,
                numCtx: current.generation.numCtx,
                numPredict: current.generation.numPredict,
                temperature: current.generation.temperature,
                keepAlive: current.memory.unloadAfterTask
                  ? '0'
                  : current.ollama.keepAlive,
                signal: ctx.signal,
                onProgress: (progress) => ctx.reportProgress(progress),
              },
            );
            ensureNotAborted(ctx.signal);

            const latest = await this.videos.get(recordId);
            if (!latest) {
              throw new AppError(
                'INVALID_INPUT',
                'The video was deleted while its summary was being generated, so the summary was not saved.',
              );
            }

            const record: SummaryRecord = {
              videoRecordId: recordId,
              videoTitle: latest.title,
              videoUrl: latest.url,
              model: current.generation.model,
              chunkCount: result.chunkCount,
              segmentCount: latest.segmentCount,
              createdAt: this.now(),
              overview: result.summary.overview,
              keyPoints: result.summary.keyPoints,
              chapters: result.summary.chapters,
            };
            if (latest.durationMs !== undefined) {
              record.durationMs = latest.durationMs;
            }
            await this.summaries.save(record);

            // Cancellation can arrive while the storage write is in flight.
            // Never leave a summary behind after an explicit cancel.
            if (ctx.signal.aborted) {
              await this.summaries.remove(recordId);
              throw new AppError(
                'CANCELLED',
                'Summary cancelled while it was being saved',
              );
            }

            const outcome: SummaryTaskResult = {
              videoRecordId: recordId,
              createdAt: record.createdAt,
              keyPointCount: record.keyPoints.length,
              chapterCount: record.chapters.length,
            };
            return outcome;
          } finally {
            if (this.inflight.get(recordId) === token) {
              this.inflight.delete(recordId);
            }
          }
        },
      });
    } catch (err) {
      if (this.inflight.get(recordId) === token) {
        this.inflight.delete(recordId);
      }
      throw err;
    }
    token.taskId = task.id;
    return { taskId: task.id, deduped: false };
  }

  async list(): Promise<SummaryListItem[]> {
    return this.summaries.list();
  }

  async get(videoRecordId: string): Promise<SummaryRecord | undefined> {
    return this.summaries.get(this.requireRecordId(videoRecordId));
  }

  /** Cancel any in-flight generation and delete the stored summary. */
  async remove(videoRecordId: string): Promise<{ removed: boolean }> {
    const recordId = this.requireRecordId(videoRecordId);
    const token = this.inflight.get(recordId);
    if (token) {
      if (token.taskId.length > 0) this.queue.cancel(token.taskId);
      if (this.inflight.get(recordId) === token) {
        this.inflight.delete(recordId);
      }
    }
    return { removed: await this.summaries.remove(recordId) };
  }

  async removeForVideo(videoRecordId: string): Promise<boolean> {
    return (await this.remove(videoRecordId)).removed;
  }

  private activeTask(recordId: string): string | undefined {
    const token = this.inflight.get(recordId);
    if (!token || token.taskId.length === 0) return undefined;
    const view = this.queue.get(token.taskId);
    if (view && (view.status === 'queued' || view.status === 'running')) {
      return view.id;
    }
    if (this.inflight.get(recordId) === token) {
      this.inflight.delete(recordId);
    }
    return undefined;
  }

  private requireRecordId(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError(
        'INVALID_INPUT',
        'A local video record id is required',
      );
    }
    return value.trim();
  }

  private requireContext(numCtx: number): void {
    if (!Number.isFinite(numCtx) || numCtx < MIN_NUM_CTX) {
      throw new AppError(
        'INVALID_INPUT',
        `Summarization needs a context window (num_ctx) of at least ${MIN_NUM_CTX} tokens; current value: ${String(numCtx)}.`,
        {
          hint: `Raise the context window in Settings to at least ${MIN_NUM_CTX}. 4096 is recommended for the default model.`,
        },
      );
    }
  }
}
