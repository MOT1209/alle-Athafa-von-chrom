import { AppError } from '../core/errors';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { LlmProvider } from '../ai/types';
import type { VideoRecord } from '../capture/videos';
import type { Settings, SettingsStore } from '../storage/settings';
import { baseLanguageCode, isTranslationLanguage } from '../ai/translate/languages';
import { translateTranscript } from '../ai/translate/translator';
import {
  staleLanguages,
  type TranslationBundle,
  type TranslationRecord,
} from './translations';
import { transcriptSignature } from './editor';
import { MIN_NUM_CTX } from '../ai/summary/chunking';

export interface TranslationVideoSource {
  get(id: string): Promise<VideoRecord | undefined>;
}

export interface TranslationStore {
  save(input: {
    videoRecordId: string;
    videoTitle: string;
    videoUrl: string;
    translation: TranslationRecord;
  }): Promise<TranslationBundle>;
  get(videoRecordId: string): Promise<TranslationBundle | undefined>;
  getTranslation(
    videoRecordId: string,
    targetLanguage: string,
  ): Promise<TranslationRecord | undefined>;
  list(): Promise<import('./translations').TranslationListItem[]>;
  removeLanguage(videoRecordId: string, targetLanguage: string): Promise<boolean>;
  remove(videoRecordId: string): Promise<boolean>;
}

export interface TranslationServiceDeps {
  settings: SettingsStore;
  videos: TranslationVideoSource;
  translations: TranslationStore;
  queue: TaskQueue;
  makeProvider: (settings: Settings) => LlmProvider;
  now?: () => number;
}

export interface GenerateTranslationResult {
  taskId: string;
  deduped: boolean;
}

export interface TranslationTaskResult {
  videoRecordId: string;
  targetLanguage: string;
  segmentCount: number;
}

export interface TranslationGetResult {
  bundle: TranslationBundle | null;
  staleLanguages: string[];
}

interface Inflight {
  taskId: string;
}

const TASK_KIND = 'video-translation';

export class TranslationService {
  private readonly settings: SettingsStore;
  private readonly videos: TranslationVideoSource;
  private readonly translations: TranslationStore;
  private readonly queue: TaskQueue;
  private readonly makeProvider: TranslationServiceDeps['makeProvider'];
  private readonly now: () => number;
  private readonly inflight = new Map<string, Inflight>();

  constructor(deps: TranslationServiceDeps) {
    this.settings = deps.settings;
    this.videos = deps.videos;
    this.translations = deps.translations;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
    this.now = deps.now ?? Date.now;
  }

  private inflightKey(recordId: string, targetLanguage: string): string {
    return `${recordId}|${targetLanguage}`;
  }

  async generate(
    videoRecordId: string,
    targetLanguage: string,
  ): Promise<GenerateTranslationResult> {
    const recordId = this.requireId(videoRecordId);
    const target = this.requireLanguage(targetLanguage);

    const running = this.activeTask(recordId, target);
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
    const sourceLanguage = baseLanguageCode(video.language);
    if (sourceLanguage !== undefined && sourceLanguage === target) {
      throw new AppError(
        'INVALID_INPUT',
        'The target language matches the transcript language.',
      );
    }
    this.requireContext(settings.generation.numCtx);

    const raced = this.activeTask(recordId, target);
    if (raced) return { taskId: raced, deduped: true };

    const token: Inflight = { taskId: '' };
    this.inflight.set(this.inflightKey(recordId, target), token);
    let task: TaskView;
    try {
      task = this.queue.enqueue({
        kind: TASK_KIND,
        label: `Translate: ${video.title} → ${target}`,
        model: settings.generation.model,
        meta: { videoRecordId: recordId, targetLanguage: target },
        run: async (ctx) => {
          try {
            const current = await this.settings.load();
            this.requireContext(current.generation.numCtx);
            const source = await this.videos.get(recordId);
            if (!source) {
              throw new AppError(
                'INVALID_INPUT',
                'The video was deleted before translation started.',
              );
            }
            const srcLang = baseLanguageCode(source.language);
            if (srcLang !== undefined && srcLang === target) {
              throw new AppError(
                'INVALID_INPUT',
                'The target language matches the transcript language.',
              );
            }

            const previous = await this.translations.getTranslation(recordId, target);

            const provider = this.makeProvider(current);
            const result = await translateTranscript(
              {
                ...(srcLang === undefined ? {} : { sourceLanguage: srcLang }),
                targetLanguage: target,
                segments: source.transcript.segments,
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
                'The video was deleted while its translation was being generated, so the translation was not saved.',
              );
            }

            const translation: TranslationRecord = {
              targetLanguage: target,
              ...(srcLang === undefined ? {} : { sourceLanguage: srcLang }),
              model: current.generation.model,
              createdAt: this.now(),
              sourceSignature: transcriptSignature(source.transcript),
              segments: result.segments,
            };

            await this.translations.save({
              videoRecordId: recordId,
              videoTitle: latest.title,
              videoUrl: latest.url,
              translation,
            });

            // Cancellation can arrive while the storage write is in flight.
            if (ctx.signal.aborted) {
              if (previous) {
                await this.translations.save({
                  videoRecordId: recordId,
                  videoTitle: latest.title,
                  videoUrl: latest.url,
                  translation: previous,
                });
              } else {
                await this.translations.removeLanguage(recordId, target);
              }
              throw new AppError('CANCELLED', 'Translation cancelled while it was being saved');
            }

            const outcome: TranslationTaskResult = {
              videoRecordId: recordId,
              targetLanguage: target,
              segmentCount: result.segments.length,
            };
            return outcome;
          } finally {
            if (this.inflight.get(this.inflightKey(recordId, target)) === token) {
              this.inflight.delete(this.inflightKey(recordId, target));
            }
          }
        },
      });
    } catch (err) {
      if (this.inflight.get(this.inflightKey(recordId, target)) === token) {
        this.inflight.delete(this.inflightKey(recordId, target));
      }
      throw err;
    }
    token.taskId = task.id;
    return { taskId: task.id, deduped: false };
  }

  async get(videoRecordId: string): Promise<TranslationGetResult> {
    const recordId = this.requireId(videoRecordId);
    const bundle = await this.translations.get(recordId);
    if (!bundle) {
      return { bundle: null, staleLanguages: [] };
    }
    const video = await this.videos.get(recordId);
    const currentSignature = video ? transcriptSignature(video.transcript) : '';
    return {
      bundle,
      staleLanguages: staleLanguages(bundle, currentSignature),
    };
  }

  async list() {
    return this.translations.list();
  }

  async removeLanguage(
    videoRecordId: string,
    targetLanguage: string,
  ): Promise<{ removed: boolean }> {
    const recordId = this.requireId(videoRecordId);
    const target = this.requireLanguage(targetLanguage, false);
    return { removed: await this.translations.removeLanguage(recordId, target) };
  }

  async removeForVideo(videoRecordId: string): Promise<boolean> {
    return this.translations.remove(this.requireId(videoRecordId));
  }

  private activeTask(recordId: string, targetLanguage: string): string | undefined {
    const token = this.inflight.get(this.inflightKey(recordId, targetLanguage));
    if (!token || token.taskId.length === 0) return undefined;
    const view = this.queue.get(token.taskId);
    if (view && (view.status === 'queued' || view.status === 'running')) {
      return view.id;
    }
    if (this.inflight.get(this.inflightKey(recordId, targetLanguage)) === token) {
      this.inflight.delete(this.inflightKey(recordId, targetLanguage));
    }
    return undefined;
  }

  private requireId(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'A local video record id is required');
    }
    return value.trim();
  }

  private requireLanguage(value: string, mustBeCurated = true): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'A target language is required');
    }
    const code = value.trim().toLowerCase();
    if (mustBeCurated && !isTranslationLanguage(code)) {
      throw new AppError('INVALID_INPUT', `Unsupported target language: ${code}`);
    }
    return code;
  }

  private requireContext(numCtx: number): void {
    if (!Number.isFinite(numCtx) || numCtx < MIN_NUM_CTX) {
      throw new AppError(
        'INVALID_INPUT',
        `Translation needs a context window (num_ctx) of at least ${MIN_NUM_CTX} tokens; current value: ${String(numCtx)}.`,
        {
          hint: `Raise the context window in Settings to at least ${MIN_NUM_CTX}. 4096 is recommended for the default model.`,
        },
      );
    }
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('CANCELLED', 'Translation cancelled');
  }
}

// Re-export for convenience.
export { transcriptSignature } from './editor';