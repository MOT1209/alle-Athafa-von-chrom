import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { LearningRepository } from '../../src/learning/repository';
import { LearningService } from '../../src/learning/service';
import { TaskQueue } from '../../src/ai/queue';
import type { LlmProvider, ChatResult, GenerationOptions, ChatMessage } from '../../src/ai/types';
import { segmentsToTranscript } from '../../src/youtube/transcript';

function fakeProvider(reply: string): LlmProvider {
  return {
    id: 'fake',
    async health() { return { ok: true }; },
    async listModels() { return []; },
    async loadedModels() { return []; },
    async chat(_m: ChatMessage[], _o?: GenerationOptions): Promise<ChatResult> {
      return { content: reply, model: 'fake', done: true };
    },
    async chatStream() { throw new Error('no'); },
  };
}

async function makeHarness() {
  const kv = new MemoryStore();
  const settings = new SettingsStore(kv);
  await settings.update({ generation: { model: 'm', numCtx: 4096, numPredict: 256 } });
  const videos = new VideoRepository(kv);
  await videos.save(
    {
      id: videoIdFor('a'),
      platform: 'youtube',
      videoId: 'a',
      url: 'https://www.youtube.com/watch?v=a',
      title: 'Video a',
      language: 'en',
      segmentCount: 2,
      capturedAt: 0,
      transcript: segmentsToTranscript(
        [
          { startMs: 0, endMs: 1000, text: 'hello world' },
          { startMs: 1000, endMs: 2000, text: 'foo bar' },
        ],
        'en',
      ),
    },
    0,
  );
  const learning = new LearningRepository(kv);
  const queue = new TaskQueue({ maxRetries: 0 });
  const reply = JSON.stringify({
    flashcards: [{ front: 'Q', back: 'A' }],
    quizzes: [{ type: 'open', question: 'Q?', answer: 'A' }],
  });
  const service = new LearningService({
    settings,
    videos,
    learning,
    queue,
    makeProvider: () => fakeProvider(reply),
  });
  return { service, queue, learning, videos };
}

describe('learning/service', () => {
  it('generates and stores', async () => {
    const { service, queue } = await makeHarness();
    const { taskId, deduped } = await service.generate('yt_a');
    expect(deduped).toBe(false);
    await new Promise<void>((resolve) => {
      const check = () => {
        const v = queue.get(taskId);
        if (v && ['succeeded', 'failed', 'cancelled'].includes(v.status)) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    const view = queue.get(taskId);
    expect(view?.status).toBe('succeeded');
    const got = await service.get('yt_a');
    expect(got?.flashcards).toHaveLength(1);
    expect(got?.quizzes).toHaveLength(1);
    const list = await service.list();
    expect(list).toHaveLength(1);
  });

  it('rejects unknown video', async () => {
    const { service } = await makeHarness();
    await expect(service.generate('yt_missing')).rejects.toThrow();
  });

  it('remove works', async () => {
    const { service, queue } = await makeHarness();
    const { taskId } = await service.generate('yt_a');
    await new Promise<void>((resolve) => {
      const check = () => {
        const v = queue.get(taskId);
        if (v && ['succeeded', 'failed', 'cancelled'].includes(v.status)) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    const res = await service.remove('yt_a');
    expect(res.removed).toBe(true);
  });

  it('reviewCard works', async () => {
    const { service, queue } = await makeHarness();
    const { taskId } = await service.generate('yt_a');
    await new Promise<void>((resolve) => {
      const check = () => {
        const v = queue.get(taskId);
        if (v && ['succeeded', 'failed', 'cancelled'].includes(v.status)) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    const got = await service.get('yt_a');
    const cardId = got!.flashcards[0]!.id;
    const res = await service.reviewCard('yt_a', cardId, 'good');
    expect(res.reviewed).toBe(true);
  });
});