import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors';
import { TaskQueue } from '../../src/ai/queue';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
} from '../../src/ai/types';
import { VideoRepository, videoIdFor, type VideoRecord } from '../../src/capture/videos';
import {
  ChatRepository,
  type AppendExchangeInput,
  type ChatExchange,
  type ChatListItem,
  type ChatRecord,
} from '../../src/chat/repository';
import { ChatService, type ChatStore } from '../../src/chat/service';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { segmentsToTranscript } from '../../src/youtube/transcript';

interface ChatCall {
  messages: ChatMessage[];
  options?: GenerationOptions;
}

type Reply =
  | string
  | Error
  | ((call: ChatCall) => string | Promise<string>);

function fakeProvider(script: Reply[]): {
  provider: LlmProvider;
  calls: ChatCall[];
} {
  const calls: ChatCall[] = [];
  const remaining = [...script];
  const provider: LlmProvider = {
    id: 'fake',
    async health() {
      return { ok: true };
    },
    async listModels() {
      return [];
    },
    async loadedModels() {
      return [];
    },
    async chat(messages, options): Promise<ChatResult> {
      const call: ChatCall = { messages };
      if (options !== undefined) call.options = options;
      calls.push(call);
      const next = remaining.shift();
      if (next === undefined) {
        throw new AppError('INTERNAL', 'The test script has no reply left');
      }
      if (next instanceof Error) throw next;
      const content = typeof next === 'function' ? await next(call) : next;
      return { content, model: 'fake', done: true };
    },
    async chatStream(): Promise<ChatResult> {
      throw new AppError('INTERNAL', 'chatStream is not used by chat');
    },
  };
  return { provider, calls };
}

function grounded(): string {
  return JSON.stringify({
    found: true,
    answer: 'Tomatoes need six hours of sunlight.',
    usedSources: [1],
  });
}

function notFound(): string {
  return JSON.stringify({ found: false, answer: '', usedSources: [] });
}

function blockingReply(call: ChatCall): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const signal = call.options?.signal;
    if (!signal) {
      reject(new AppError('INTERNAL', 'missing abort signal'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new AppError('CANCELLED', 'cancelled'));
    });
  });
}

function makeVideo(id = 'a'): VideoRecord {
  return {
    id: videoIdFor(id),
    platform: 'youtube',
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: 'Test video',
    channel: 'Chan',
    durationMs: 15_000,
    language: 'en',
    segmentCount: 3,
    capturedAt: 0,
    transcript: segmentsToTranscript(
      [
        { startMs: 0, endMs: 5000, text: 'Welcome to the show.' },
        {
          startMs: 5000,
          endMs: 10_000,
          text: 'Tomatoes need six hours of sunlight and regular watering.',
        },
        {
          startMs: 10_000,
          endMs: 15_000,
          text: 'The harvest happens in late summer.',
        },
      ],
      'en',
    ),
  };
}

class GatedChatStore implements ChatStore {
  private readonly inner = new ChatRepository(new MemoryStore());
  saveStarted = false;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async appendExchange(input: AppendExchangeInput): Promise<ChatExchange> {
    this.saveStarted = true;
    await this.gate;
    return this.inner.appendExchange(input);
  }

  get(videoRecordId: string): Promise<ChatRecord | undefined> {
    return this.inner.get(videoRecordId);
  }

  removeMessages(videoRecordId: string, ids: readonly string[]): Promise<number> {
    return this.inner.removeMessages(videoRecordId, ids);
  }

  list(): Promise<ChatListItem[]> {
    return this.inner.list();
  }

  remove(videoRecordId: string): Promise<boolean> {
    return this.inner.remove(videoRecordId);
  }

  releaseSave(): void {
    this.release();
  }
}

async function makeHarness(
  options: {
    script: Reply[];
    numCtx?: number;
    chats?: ChatStore;
  } = { script: [] },
) {
  let clock = 1000;
  const kv = new MemoryStore();
  const settings = new SettingsStore(kv);
  if (options.numCtx !== undefined) {
    await settings.update({ generation: { numCtx: options.numCtx } });
  }
  const videos = new VideoRepository(kv);
  await videos.save(makeVideo('a'), 500);
  const defaultChats = new ChatRepository(kv);
  const chats = options.chats ?? defaultChats;
  const queue = new TaskQueue({
    maxRetries: 0,
    wait: async () => {},
    now: () => clock++,
  });
  const { provider, calls } = fakeProvider(options.script);
  const service = new ChatService({
    settings,
    videos,
    chats,
    queue,
    makeProvider: () => provider,
  });
  return {
    service,
    queue,
    chats,
    defaultChats,
    videos,
    settings,
    calls,
  };
}

async function waitForStatus(
  queue: TaskQueue,
  taskId: string,
  status: 'succeeded' | 'failed' | 'cancelled' | 'running',
): Promise<void> {
  await vi.waitFor(() => {
    expect(queue.get(taskId)?.status).toBe(status);
  });
}

describe('ChatService.ask', () => {
  it('answers through the queue and persists the validated exchange', async () => {
    const harness = await makeHarness({ script: [grounded()] });
    const { taskId, deduped } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: '  How much sunlight do tomatoes need?  ',
    });
    expect(deduped).toBe(false);

    await waitForStatus(harness.queue, taskId, 'succeeded');
    const view = harness.queue.get(taskId);
    expect(view?.kind).toBe('video-chat');
    expect(view?.label).toBe('Chat: Test video');
    expect(view?.model).toBe('qwen2.5:1.5b');
    expect(view?.meta).toEqual({ videoRecordId: 'yt_a' });
    expect(view?.result).toMatchObject({
      videoRecordId: 'yt_a',
      answered: true,
      citationCount: 1,
    });

    const record = await harness.service.history('yt_a');
    expect(record?.messages).toHaveLength(2);
    expect(record?.messages[0]).toMatchObject({
      role: 'user',
      text: 'How much sunlight do tomatoes need?',
    });
    expect(record?.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Tomatoes need six hours of sunlight.',
    });
    expect(record?.messages[1]?.citations?.[0]).toMatchObject({
      startMs: 5000,
      endMs: 10_000,
    });

    const list = await harness.service.list();
    expect(list).toHaveLength(1);
    expect(harness.calls).toHaveLength(1);
  });

  it('records an honest not-in-video answer without calling the model', async () => {
    const harness = await makeHarness({ script: [] });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'What is the capital of France?',
    });
    await waitForStatus(harness.queue, taskId, 'succeeded');
    expect(harness.queue.get(taskId)?.result).toMatchObject({
      answered: false,
      citationCount: 0,
    });
    const record = await harness.service.history('yt_a');
    expect(record?.messages[1]).toMatchObject({
      role: 'assistant',
      notInVideo: true,
    });
    expect(harness.calls).toHaveLength(0);
  });

  it('turns a model refusal into a not-in-video answer', async () => {
    const harness = await makeHarness({ script: [notFound()] });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await waitForStatus(harness.queue, taskId, 'succeeded');
    const record = await harness.service.history('yt_a');
    expect(record?.messages[1]?.notInVideo).toBe(true);
    expect(harness.calls).toHaveLength(1);
  });

  it('deduplicates concurrent questions for the same video', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await makeHarness({
      script: [
        async () => {
          await gate;
          return grounded();
        },
      ],
    });
    const first = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    const second = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'What about watering?',
    });
    expect(second).toEqual({ taskId: first.taskId, deduped: true });
    expect(harness.queue.list()).toHaveLength(1);

    release();
    await waitForStatus(harness.queue, first.taskId, 'succeeded');
    const third = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'What about watering?',
    });
    expect(third.deduped).toBe(false);
    expect(third.taskId).not.toBe(first.taskId);
  });

  it('rejects invalid ids, questions and unknown videos before enqueueing', async () => {
    const harness = await makeHarness({ script: [] });
    await expect(
      harness.service.ask({ videoRecordId: '   ', question: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      harness.service.ask({ videoRecordId: 'yt_a', question: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      harness.service.ask({
        videoRecordId: 'yt_a',
        question: 'x'.repeat(1001),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      harness.service.ask({ videoRecordId: 'yt_missing', question: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(harness.queue.list()).toHaveLength(0);
  });

  it('rejects a context window below the chat minimum', async () => {
    const harness = await makeHarness({ script: [], numCtx: 512 });
    await expect(
      harness.service.ask({ videoRecordId: 'yt_a', question: 'x' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringContaining('context window'),
    });
    expect(harness.queue.list()).toHaveLength(0);
  });

  it('cancels a running question and saves nothing', async () => {
    const harness = await makeHarness({ script: [blockingReply] });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await waitForStatus(harness.queue, taskId, 'running');
    expect(harness.queue.cancel(taskId)).toBe(true);
    await waitForStatus(harness.queue, taskId, 'cancelled');
    expect(await harness.service.history('yt_a')).toBeUndefined();
    expect(await harness.service.list()).toEqual([]);
  });

  it('removes a turn written after a cancel arrived during the save', async () => {
    const store = new GatedChatStore();
    const harness = await makeHarness({
      script: [grounded()],
      chats: store,
    });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await vi.waitFor(() => {
      expect(store.saveStarted).toBe(true);
    });

    harness.queue.cancel(taskId);
    store.releaseSave();
    await waitForStatus(harness.queue, taskId, 'cancelled');
    expect(await harness.service.history('yt_a')).toBeUndefined();
    expect(await harness.service.list()).toEqual([]);
  });

  it('fails without saving when the video is deleted mid-run', async () => {
    const harness = await makeHarness({
      script: [
        async () => {
          await harness.videos.remove('yt_a');
          return grounded();
        },
      ],
    });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await waitForStatus(harness.queue, taskId, 'failed');
    expect(harness.queue.get(taskId)?.error?.code).toBe('INVALID_INPUT');
    expect(await harness.service.history('yt_a')).toBeUndefined();
  });

  it('fails without saving when the model provider fails', async () => {
    const harness = await makeHarness({
      script: [new AppError('NETWORK', 'offline')],
    });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await waitForStatus(harness.queue, taskId, 'failed');
    expect(harness.queue.get(taskId)?.error?.code).toBe('NETWORK');
    expect(await harness.service.history('yt_a')).toBeUndefined();
  });
});

describe('ChatService.clear', () => {
  it('cancels an in-flight question and deletes the stored conversation', async () => {
    const harness = await makeHarness({
      script: [grounded(), blockingReply],
    });
    const first = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await waitForStatus(harness.queue, first.taskId, 'succeeded');

    const second = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'What about watering?',
    });
    await waitForStatus(harness.queue, second.taskId, 'running');

    expect(await harness.service.clear('yt_a')).toEqual({ cleared: true });
    await waitForStatus(harness.queue, second.taskId, 'cancelled');
    expect(await harness.service.history('yt_a')).toBeUndefined();
    expect(await harness.service.list()).toEqual([]);
  });

  it('removeForVideo reports whether a conversation existed', async () => {
    const harness = await makeHarness({ script: [grounded()] });
    const { taskId } = await harness.service.ask({
      videoRecordId: 'yt_a',
      question: 'How much sunlight do tomatoes need?',
    });
    await waitForStatus(harness.queue, taskId, 'succeeded');
    expect(await harness.service.removeForVideo('yt_a')).toBe(true);
    expect(await harness.service.removeForVideo('yt_a')).toBe(false);
  });

  it('validates the record id on history and clear', async () => {
    const harness = await makeHarness({ script: [] });
    await expect(harness.service.history('  ')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(harness.service.clear('')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
