import { AppError } from '../core/errors';
import { MIN_NUM_CTX } from '../ai/summary/chunking';
import { generateLearning } from '../ai/learning/generator';
import { ensureNotAborted } from '../ai/summary/summarizer';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { LlmProvider } from '../ai/types';
import type { VideoRecord } from '../capture/videos';
import type { Settings, SettingsStore } from '../storage/settings';
import type { LearningListItem, LearningRecord } from './repository';

export interface LearningVideoSource {
  get(id: string): Promise<VideoRecord | undefined>;
}

export interface LearningStore {
  save(input: {
    videoRecordId: string;
    videoTitle: string;
    videoUrl: string;
    model: string;
    flashcards: Array<{ front: string; back: string; timestampMs?: number }>;
    quizzes: Array<{
      type: 'mcq' | 'open';
      question: string;
      options?: string[];
      answer: string;
      explanation?: string;
      timestampMs?: number;
    }>;
    now?: number;
  }): Promise<LearningRecord>;
  get(videoRecordId: string): Promise<LearningRecord | undefined>;
  list(now?: number): Promise<LearningListItem[]>;
  listWithDue(now?: number): Promise<LearningListItem[]>;
  remove(videoRecordId: string): Promise<boolean>;
  reviewCard(
    videoRecordId: string,
    cardId: string,
    rating: 'again' | 'hard' | 'good' | 'easy',
    now?: number,
  ): Promise<boolean>;
  dueCards(videoRecordId: string, now?: number): Promise<Array<{ id: string }>>;
}

export interface LearningServiceDeps {
  settings: SettingsStore;
  videos: LearningVideoSource;
  learning: LearningStore;
  queue: TaskQueue;
  makeProvider: (settings: Settings) => LlmProvider;
  now?: () => number;
}

export interface GenerateLearningResult {
  taskId: string;
  deduped: boolean;
}

export interface LearningTaskResult {
  videoRecordId: string;
  cardCount: number;
  quizCount: number;
}

interface Inflight {
  taskId: string;
}

const TASK_KIND = 'video-learning';

export class LearningService {
  private readonly settings: SettingsStore;
  private readonly videos: LearningVideoSource;
  private readonly learning: LearningStore;
  private readonly queue: TaskQueue;
  private readonly makeProvider: LearningServiceDeps['makeProvider'];
  private readonly now: () => number;
  private readonly inflight = new Map<string, Inflight>();

  constructor(deps: LearningServiceDeps) {
    this.settings = deps.settings;
    this.videos = deps.videos;
    this.learning = deps.learning;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
    this.now = deps.now ?? Date.now;
  }

  async generate(videoRecordId: string): Promise<GenerateLearningResult> {
    const recordId = this.requireId(videoRecordId);
    const running = this.activeTask(recordId);
    if (running) return { taskId: running, deduped: true };

    const [settings, video] = await Promise.all([
      this.settings.load(),
      this.videos.get(recordId),
    ]);
    if (!video) {
      throw new AppError('INVALID_INPUT', 'The video was not found in the local library. Capture it first.');
    }
    this.requireContext(settings.generation.numCtx);

    const raced = this.activeTask(recordId);
    if (raced) return { taskId: raced, deduped: true };

    const token: Inflight = { taskId: '' };
    this.inflight.set(recordId, token);
    let task: TaskView;
    try {
      task = this.queue.enqueue({
        kind: TASK_KIND,
        label: `Study material: ${video.title}`,
        model: settings.generation.model,
        meta: { videoRecordId: recordId },
        run: async (ctx) => {
          try {
            const current = await this.settings.load();
            this.requireContext(current.generation.numCtx);
            const source = await this.videos.get(recordId);
            if (!source) {
              throw new AppError('INVALID_INPUT', 'The video was deleted before study material was generated.');
            }
            const provider = this.makeProvider(current);
            const result = await generateLearning(
              {
                title: source.title,
                transcript: source.transcript,
              },
              {
                provider,
                model: current.generation.model,
                numCtx: current.generation.numCtx,
                numPredict: current.generation.numPredict,
                temperature: current.generation.temperature,
                keepAlive: current.memory.unloadAfterTask ? '0' : current.ollama.keepAlive,
                signal: ctx.signal,
                onProgress: (progress) => ctx.reportProgress(progress),
              },
            );
            ensureNotAborted(ctx.signal);

            const latest = await this.videos.get(recordId);
            if (!latest) {
              throw new AppError('INVALID_INPUT', 'The video was deleted while study material was being generated, so it was not saved.');
            }

            const record = await this.learning.save({
              videoRecordId: recordId,
              videoTitle: latest.title,
              videoUrl: latest.url,
              model: current.generation.model,
              flashcards: result.material.flashcards,
              quizzes: result.material.quizzes,
              now: this.now(),
            });

            if (ctx.signal.aborted) {
              await this.learning.remove(recordId);
              throw new AppError('CANCELLED', 'Study material cancelled while it was being saved');
            }

            const outcome: LearningTaskResult = {
              videoRecordId: recordId,
              cardCount: record.flashcards.length,
              quizCount: record.quizzes.length,
            };
            return outcome;
          } finally {
            if (this.inflight.get(recordId) === token) this.inflight.delete(recordId);
          }
        },
      });
    } catch (err) {
      if (this.inflight.get(recordId) === token) this.inflight.delete(recordId);
      throw err;
    }
    token.taskId = task.id;
    return { taskId: task.id, deduped: false };
  }

  async get(videoRecordId: string): Promise<LearningRecord | undefined> {
    return this.learning.get(this.requireId(videoRecordId));
  }

  async list(now?: number) {
    return this.learning.list(now);
  }

  async listWithDue(now?: number) {
    return this.learning.listWithDue
      ? this.learning.listWithDue(now)
      : this.learning.list(now);
  }

  async remove(videoRecordId: string): Promise<{ removed: boolean }> {
    const recordId = this.requireId(videoRecordId);
    const token = this.inflight.get(recordId);
    if (token) {
      if (token.taskId.length > 0) this.queue.cancel(token.taskId);
      if (this.inflight.get(recordId) === token) this.inflight.delete(recordId);
    }
    return { removed: await this.learning.remove(recordId) };
  }

  async removeForVideo(videoRecordId: string): Promise<boolean> {
    return (await this.remove(videoRecordId)).removed;
  }

  async reviewCard(videoRecordId: string, cardId: string, rating: 'again' | 'hard' | 'good' | 'easy') {
    return { reviewed: await this.learning.reviewCard(videoRecordId, cardId, rating, this.now()) };
  }

  private activeTask(recordId: string): string | undefined {
    const token = this.inflight.get(recordId);
    if (!token || token.taskId.length === 0) return undefined;
    const view = this.queue.get(token.taskId);
    if (view && (view.status === 'queued' || view.status === 'running')) return view.id;
    if (this.inflight.get(recordId) === token) this.inflight.delete(recordId);
    return undefined;
  }

  private requireId(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'A local video record id is required');
    }
    return value.trim();
  }

  private requireContext(numCtx: number): void {
    if (!Number.isFinite(numCtx) || numCtx < MIN_NUM_CTX) {
      throw new AppError('INVALID_INPUT', `Learning needs a context window (num_ctx) of at least ${MIN_NUM_CTX} tokens; current value: ${String(numCtx)}.`, {
        hint: `Raise the context window in Settings to at least ${MIN_NUM_CTX}. 4096 is recommended.`,
      });
    }
  }
}

