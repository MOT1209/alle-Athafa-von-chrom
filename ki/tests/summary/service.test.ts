import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors';
import { TaskQueue } from '../../src/ai/queue';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
} from '../../src/ai/types';
import { SettingsStore } from '../../src/storage/settings';
import { MemoryStore } from '../../src/storage/kv';
import {
  VideoRepository,
  videoIdFor,
  type VideoRecord,
} from '../../src/capture/videos';
import { segmentsToTranscript } from '../../src/youtube/transcript';
import {
  SummaryRepository,
  type SummaryListItem,
  type SummaryRecord,
} from '../../src/summary/repository';
import {
  SummaryService,
  type SummaryStore,
} from '../../src/summary/service';

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
      throw new AppError('INTERNAL', 'chatStream is not used by summarization');
    },
  };
  return { provider, calls };
}

function mapReply(): string {
  return JSON.stringify({
    summary: 'A factual summary of this part.',
    keyPoints: [{ timestampMs: 1000, text: 'A factual point.' }],
  });
}

function finalReply(): string {
  return JSON.stringify({
    overview: 'A factual overview of the whole video.',
    keyPoints: [
      { timestampMs: 0, text: 'Opening point.' },
      { timestampMs: 2000, text: 'Second point.' },
    ],
    chapters: [
      {
        startMs: 0,
        title: 'Introduction',
        summary: 'The host introduces the topic.',
      },
      {
        startMs: 2000,
        title: 'Details',
        summary: 'The guest explains the details.',
      },
    ],
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
    durationMs: 4000,
    language: 'en',
    segmentCount: 2,
    capturedAt: 0,
    transcript: segmentsToTranscript(
      [
        { startMs: 0, endMs: 2000, text: 'The host introduces the topic.' },
        { startMs: 2000, endMs: 4000, text: 'The guest explains the details.' },
      ],
      'en',
    ),
  };
}

function makeSummaryRecord(id = 'yt_a', createdAt = 1000): SummaryRecord {
  return {
    videoRecordId: id,
    videoTitle: 'Test video',
    videoUrl: 'https://www.youtube.com/watch?v=a',
    model: 'qwen2.5:1.5b',
    chunkCount: 1,
    segmentCount: 2,
    createdAt,
    durationMs: 4000,
    overview: 'A clear overview of the video.',
    keyPoints: [{ timestampMs: 1000, text: 'First point' }],
    chapters: [{ startMs: 0, title: 'Intro' }],
  };
}

class GatedSummaryStore implements SummaryStore {
  saved?: SummaryRecord;
  saveStarted = false;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async save(record: SummaryRecord): Promise<SummaryRecord> {
    this.saveStarted = true;
    this.saved = record;
    await this.gate;
    return record;
  }

  async get(videoRecordId: string): Promise<SummaryRecord | undefined> {
    return this.saved?.videoRecordId === videoRecordId ? this.saved : undefined;
  }

  async list(): Promise<SummaryListItem[]> {
    return [];
  }

  async remove(videoRecordId: string): Promise<boolean> {
    const had = this.saved?.videoRecordId === videoRecordId;
    if (had) this.saved = undefined;
    return had;
  }

  releaseSave(): void {
    this.release();
  }
}

async function makeHarness(options: {
  script: Reply[];
  numCtx?: number;
  summaries?: SummaryStore;
} = { script: [] }) {
  let clock = 1000;
  const kv = new MemoryStore();
  const settings = new SettingsStore(kv);
  if (options.numCtx !== undefined) {
    await settings.update({ generation: { numCtx: options.numCtx } });
  }
  const videos = new VideoRepository(kv);
  await videos.save(makeVideo('a'), 500);
  const defaultSummaries = new SummaryRepository(kv);
  const summaries = options.summaries ?? defaultSummaries;
  const queue = new TaskQueue({
    maxRetries: 0,
    wait: async () => {},
    now: () => clock++,
  });
  const { provider, calls } = fakeProvider(options.script);
  const service = new SummaryService({
    settings,
    videos,
    summaries,
    queue,
    makeProvider: () => provider,
    now: () => clock++,
  });
  return {
    service,
    queue,
    summaries,
    defaultSummaries,
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

describe('SummaryService.generate', () => {
  it('runs the task on the queue and persists only the validated summary', async () => {
    const harness = await makeHarness({
      script: [mapReply(), finalReply()],
    });
    const { taskId, deduped } = await harness.service.generate('yt_a');
    expect(deduped).toBe(false);

    await waitForStatus(harness.queue, taskId, 'succeeded');
    const view = harness.queue.get(taskId);
    expect(view?.kind).toBe('video-summary');
    expect(view?.label).toBe('Summarize: Test video');
    expect(view?.model).toBe('qwen2.5:1.5b');
    expect(view?.meta).toEqual({ videoRecordId: 'yt_a' });
    expect(view?.result).toMatchObject({
      videoRecordId: 'yt_a',
      keyPointCount: 2,
      chapterCount: 2,
    });

    const stored = await harness.service.get('yt_a');
    expect(stored).toMatchObject({
      videoRecordId: 'yt_a',
      videoTitle: 'Test video',
      model: 'qwen2.5:1.5b',
      chunkCount: 1,
      segmentCount: 2,
      durationMs: 4000,
    });
    const list = await harness.service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.chunkCount).toBe(1);
    expect(harness.calls).toHaveLength(2);
  });

  it('deduplicates concurrent generation for the same video', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await makeHarness({
      script: [async () => {
        await gate;
        return mapReply();
      }, finalReply()],
    });
    const first = await harness.service.generate('yt_a');
    const second = await harness.service.generate('yt_a');
    expect(second).toEqual({ taskId: first.taskId, deduped: true });
    expect(harness.queue.list()).toHaveLength(1);

    release();
    await waitForStatus(harness.queue, first.taskId, 'succeeded');
    const third = await harness.service.generate('yt_a');
    expect(third.deduped).toBe(false);
    expect(third.taskId).not.toBe(first.taskId);
  });

  it('rejects unknown videos and invalid ids before enqueueing', async () => {
    const harness = await makeHarness({ script: [] });
    await expect(harness.service.generate('yt_missing')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(harness.service.generate('   ')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(harness.queue.list()).toHaveLength(0);
  });

  it('rejects a context window below the summarization minimum', async () => {
    const harness = await makeHarness({ script: [], numCtx: 512 });
    await expect(harness.service.generate('yt_a')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringContaining('context window'),
    });
    expect(harness.queue.list()).toHaveLength(0);
  });

  it('re-checks settings at task start and fails without calling the model', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await makeHarness({ script: [] });
    const blocker = harness.queue.enqueue({
      kind: 'block',
      label: 'block',
      run: () => gate,
    });
    await waitForStatus(harness.queue, blocker.id, 'running');

    const { taskId } = await harness.service.generate('yt_a');
    await harness.settings.update({ generation: { numCtx: 512 } });
    release();

    await waitForStatus(harness.queue, taskId, 'failed');
    expect(harness.queue.get(taskId)?.error?.code).toBe('INVALID_INPUT');
    expect(harness.calls).toHaveLength(0);
    expect(await harness.service.get('yt_a')).toBeUndefined();
  });

  it('fails honestly when the video is deleted before the task starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await makeHarness({
      script: [mapReply(), finalReply()],
    });
    const blocker = harness.queue.enqueue({
      kind: 'block',
      label: 'block',
      run: () => gate,
    });
    await waitForStatus(harness.queue, blocker.id, 'running');

    const { taskId } = await harness.service.generate('yt_a');
    await harness.videos.remove('yt_a');
    release();

    await waitForStatus(harness.queue, taskId, 'failed');
    expect(harness.queue.get(taskId)?.error?.code).toBe('INVALID_INPUT');
    expect(harness.calls).toHaveLength(0);
    expect(await harness.service.get('yt_a')).toBeUndefined();
  });

  it('does not save a summary when the video is deleted mid-run', async () => {
    const harness = await makeHarness({
      script: [
        async () => {
          await harness.videos.remove('yt_a');
          return mapReply();
        },
        finalReply(),
      ],
    });
    const { taskId } = await harness.service.generate('yt_a');
    await waitForStatus(harness.queue, taskId, 'failed');
    expect(harness.queue.get(taskId)?.error?.code).toBe('INVALID_INPUT');
    expect(harness.calls).toHaveLength(2);
    expect(await harness.service.get('yt_a')).toBeUndefined();
  });

  it('cancels a running generation at the user request and saves nothing', async () => {
    const harness = await makeHarness({
      script: [
        (call) =>
          new Promise<string>((_resolve, reject) => {
            const signal = call.options?.signal;
            if (!signal) {
              reject(new AppError('INTERNAL', 'missing abort signal'));
              return;
            }
            signal.addEventListener('abort', () => {
              reject(new AppError('CANCELLED', 'cancelled'));
            });
          }),
        finalReply(),
      ],
    });
    const { taskId } = await harness.service.generate('yt_a');
    await waitForStatus(harness.queue, taskId, 'running');
    expect(harness.queue.cancel(taskId)).toBe(true);
    await waitForStatus(harness.queue, taskId, 'cancelled');
    expect(await harness.service.get('yt_a')).toBeUndefined();
  });

  it('removes a summary written after a cancel arrived during the save', async () => {
    const store = new GatedSummaryStore();
    const harness = await makeHarness({
      script: [mapReply(), finalReply()],
      summaries: store,
    });
    const { taskId } = await harness.service.generate('yt_a');
    await vi.waitFor(() => {
      expect(store.saveStarted).toBe(true);
    });
    expect(store.saved).toBeDefined();

    harness.queue.cancel(taskId);
    store.releaseSave();
    await waitForStatus(harness.queue, taskId, 'cancelled');
    expect(store.saved).toBeUndefined();
  });

  it('regenerating replaces the current summary', async () => {
    const harness = await makeHarness({
      script: [mapReply(), finalReply(), mapReply(), finalReply()],
    });
    const first = await harness.service.generate('yt_a');
    await waitForStatus(harness.queue, first.taskId, 'succeeded');
    const firstRecord = await harness.service.get('yt_a');

    const second = await harness.service.generate('yt_a');
    await waitForStatus(harness.queue, second.taskId, 'succeeded');
    const secondRecord = await harness.service.get('yt_a');

    expect(secondRecord?.createdAt).toBeGreaterThan(firstRecord?.createdAt ?? 0);
    expect(await harness.service.list()).toHaveLength(1);
  });
});

describe('SummaryService.remove', () => {
  it('cancels an in-flight generation and deletes the stored summary', async () => {
    const harness = await makeHarness({
      script: [
        (call) =>
          new Promise<string>((_resolve, reject) => {
            const signal = call.options?.signal;
            if (!signal) {
              reject(new AppError('INTERNAL', 'missing abort signal'));
              return;
            }
            signal.addEventListener('abort', () => {
              reject(new AppError('CANCELLED', 'cancelled'));
            });
          }),
        finalReply(),
      ],
    });
    await harness.defaultSummaries.save(makeSummaryRecord('yt_a', 1000));
    const { taskId } = await harness.service.generate('yt_a');
    await waitForStatus(harness.queue, taskId, 'running');

    expect(await harness.service.remove('yt_a')).toEqual({ removed: true });
    await waitForStatus(harness.queue, taskId, 'cancelled');
    expect(await harness.service.get('yt_a')).toBeUndefined();
    expect(await harness.service.list()).toEqual([]);
  });

  it('removeForVideo reports whether a summary existed', async () => {
    const harness = await makeHarness({ script: [] });
    await harness.defaultSummaries.save(makeSummaryRecord('yt_a', 1000));
    expect(await harness.service.removeForVideo('yt_a')).toBe(true);
    expect(await harness.service.removeForVideo('yt_a')).toBe(false);
  });

  it('validates the record id on get and remove', async () => {
    const harness = await makeHarness({ script: [] });
    await expect(harness.service.get('  ')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(harness.service.remove('')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
