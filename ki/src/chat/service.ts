import { answerQuestion } from '../ai/chat/answerer';
import { MIN_NUM_CTX } from '../ai/summary/chunking';
import type { ChatHistoryTurn } from '../ai/chat/prompts';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { LlmProvider } from '../ai/types';
import { AppError } from '../core/errors';
import type { VideoRecord } from '../capture/videos';
import type { Settings, SettingsStore } from '../storage/settings';
import type {
  AppendExchangeInput,
  ChatExchange,
  ChatListItem,
  ChatRecord,
} from './repository';

/**
 * Chat orchestration. Questions run through the shared sequential queue (one
 * model call at a time), are answered only from the stored transcript, and are
 * persisted only after the answer passed schema validation. A cancelled or
 * failed turn leaves no messages behind.
 */

export interface VideoSource {
  get(id: string): Promise<VideoRecord | undefined>;
}

export interface ChatStore {
  get(videoRecordId: string): Promise<ChatRecord | undefined>;
  appendExchange(input: AppendExchangeInput): Promise<ChatExchange>;
  removeMessages(
    videoRecordId: string,
    ids: readonly string[],
  ): Promise<number>;
  list(): Promise<ChatListItem[]>;
  remove(videoRecordId: string): Promise<boolean>;
}

export interface ChatServiceDeps {
  settings: SettingsStore;
  videos: VideoSource;
  chats: ChatStore;
  queue: TaskQueue;
  makeProvider: (settings: Settings) => LlmProvider;
}

export interface AskResult {
  taskId: string;
  deduped: boolean;
}

export interface ChatTaskResult {
  videoRecordId: string;
  answered: boolean;
  citationCount: number;
}

interface Inflight {
  taskId: string;
}

const TASK_KIND = 'video-chat';
const MAX_QUESTION_CHARS = 1000;

export class ChatService {
  private readonly settings: SettingsStore;
  private readonly videos: VideoSource;
  private readonly chats: ChatStore;
  private readonly queue: TaskQueue;
  private readonly makeProvider: ChatServiceDeps['makeProvider'];
  private readonly inflight = new Map<string, Inflight>();

  constructor(deps: ChatServiceDeps) {
    this.settings = deps.settings;
    this.videos = deps.videos;
    this.chats = deps.chats;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
  }

  async ask(input: {
    videoRecordId: string;
    question: string;
  }): Promise<AskResult> {
    const recordId = this.requireRecordId(input.videoRecordId);
    const question = this.requireQuestion(input.question);

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

    // Re-check after the awaits: a question may have started while we loaded.
    const raced = this.activeTask(recordId);
    if (raced) return { taskId: raced, deduped: true };

    const token: Inflight = { taskId: '' };
    this.inflight.set(recordId, token);
    let task: TaskView;
    try {
      task = this.queue.enqueue({
        kind: TASK_KIND,
        label: `Chat: ${video.title}`,
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
                'The video was deleted before the question could be answered.',
              );
            }
            const history = await this.promptHistory(recordId);
            const provider = this.makeProvider(current);
            const result = await answerQuestion(
              {
                title: source.title,
                question,
                transcript: source.transcript,
                ...(history.length === 0 ? {} : { history }),
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
            if (ctx.signal.aborted) {
              throw new AppError('CANCELLED', 'Question cancelled');
            }

            const latest = await this.videos.get(recordId);
            if (!latest) {
              throw new AppError(
                'INVALID_INPUT',
                'The video was deleted while the question was being answered, so the answer was not saved.',
              );
            }

            const exchange = await this.chats.appendExchange({
              videoRecordId: recordId,
              videoTitle: latest.title,
              videoUrl: latest.url,
              question,
              answer: result.found
                ? {
                    kind: 'answer',
                    text: result.answer,
                    citations: result.citations,
                  }
                : { kind: 'notInVideo' },
            });

            // Cancellation can arrive while the storage write is in flight.
            // Never leave a turn behind after an explicit cancel.
            if (ctx.signal.aborted) {
              await this.chats.removeMessages(recordId, exchange.messageIds);
              throw new AppError(
                'CANCELLED',
                'Question cancelled while the answer was being saved',
              );
            }

            const outcome: ChatTaskResult = {
              videoRecordId: recordId,
              answered: result.found,
              citationCount: result.citations.length,
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

  async history(videoRecordId: string): Promise<ChatRecord | undefined> {
    return this.chats.get(this.requireRecordId(videoRecordId));
  }

  async list(): Promise<ChatListItem[]> {
    return this.chats.list();
  }

  /** Cancel any in-flight question and delete the stored conversation. */
  async clear(videoRecordId: string): Promise<{ cleared: boolean }> {
    const recordId = this.requireRecordId(videoRecordId);
    const token = this.inflight.get(recordId);
    if (token) {
      if (token.taskId.length > 0) this.queue.cancel(token.taskId);
      if (this.inflight.get(recordId) === token) {
        this.inflight.delete(recordId);
      }
    }
    return { cleared: await this.chats.remove(recordId) };
  }

  async removeForVideo(videoRecordId: string): Promise<boolean> {
    return (await this.clear(videoRecordId)).cleared;
  }

  private async promptHistory(recordId: string): Promise<ChatHistoryTurn[]> {
    const record = await this.chats.get(recordId);
    if (!record) return [];
    const turns: ChatHistoryTurn[] = [];
    for (const message of record.messages.slice(-10)) {
      if (message.role === 'user') {
        turns.push({ role: 'user', text: message.text });
      } else if (!message.notInVideo && message.text.length > 0) {
        turns.push({ role: 'assistant', text: message.text });
      }
    }
    return turns;
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

  private requireQuestion(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'A question is required');
    }
    const question = value.replace(/\s+/g, ' ').trim();
    if (question.length > MAX_QUESTION_CHARS) {
      throw new AppError(
        'INVALID_INPUT',
        `The question is longer than ${MAX_QUESTION_CHARS} characters`,
      );
    }
    return question;
  }

  private requireContext(numCtx: number): void {
    if (!Number.isFinite(numCtx) || numCtx < MIN_NUM_CTX) {
      throw new AppError(
        'INVALID_INPUT',
        `Chat needs a context window (num_ctx) of at least ${MIN_NUM_CTX} tokens; current value: ${String(numCtx)}.`,
        {
          hint: `Raise the context window in Settings to at least ${MIN_NUM_CTX}. 4096 is recommended for the default model.`,
        },
      );
    }
  }
}
