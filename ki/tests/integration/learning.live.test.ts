import { describe, expect, it } from 'vitest';
import { nodeFetch } from '../helpers/node-fetch';
import { OllamaProvider } from '../../src/ai/providers/ollama';
import { TaskQueue } from '../../src/ai/queue';
import type { LlmProvider } from '../../src/ai/types';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { LearningRepository } from '../../src/learning/repository';
import { LearningService } from '../../src/learning/service';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { segmentsToTranscript } from '../../src/youtube/transcript';

const live = process.env.VM_LIVE_OLLAMA === '1' && process.env.VM_LIVE_LEARNING === '1';
const baseUrl = process.env.VM_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const provider = live ? new OllamaProvider({ baseUrl, requestTimeoutMs: 1_800_000, fetchImpl: nodeFetch }) : undefined;
const installed = live ? await provider!.listModels().catch(() => []) : [];
const targetModel = process.env.VM_LIVE_LEARNING_MODEL?.trim() || installed.find((m) => m.name === 'qwen2.5:1.5b')?.name || installed[0]?.name;

const SEGMENTS = [
  { startMs: 0, endMs: 2000, text: 'Tomato plants need six hours of direct sunlight every day.' },
  { startMs: 2000, endMs: 4000, text: 'Water deeply twice a week until water runs out of the bottom.' },
  { startMs: 4000, endMs: 6000, text: 'Use a tomato fertilizer once every ten days.' },
];

describe.skipIf(!live || !targetModel)('Learning LIVE acceptance', () => {
  it('generates study material and review state persists', async () => {
    const model = targetModel!;
    const kv = new MemoryStore();
    const settings = new SettingsStore(kv);
    await settings.update({ generation: { model, numCtx: 4096, numPredict: 512, temperature: 0.2 }, memory: { unloadAfterTask: false } });
    const videoId = 'live-learning-fixture';
    const recordId = videoIdFor(videoId);
    const videos = new VideoRepository(kv);
    await videos.save({
      id: recordId,
      platform: 'youtube',
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: 'Live learning fixture',
      language: 'en',
      segmentCount: SEGMENTS.length,
      capturedAt: Date.now(),
      transcript: segmentsToTranscript(SEGMENTS, 'en'),
    });
    const learning = new LearningRepository(kv);
    const queue = new TaskQueue({ maxRetries: 1, retryBaseDelayMs: 1000 });
    const wrapped: LlmProvider = {
      id: provider!.id,
      health: () => provider!.health(),
      listModels: () => provider!.listModels(),
      loadedModels: () => provider!.loadedModels(),
      chat: (m, o) => provider!.chat(m, o),
      chatStream: (m, o, t) => provider!.chatStream(m, o, t),
    };
    const service = new LearningService({ settings, videos, learning, queue, makeProvider: () => wrapped });

    const { taskId, deduped } = await service.generate(recordId);
    expect(deduped).toBe(false);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const v = queue.get(taskId);
        if (!v) return setTimeout(check, 500);
        if (v.status === 'succeeded') return resolve();
        if (v.status === 'failed' || v.status === 'cancelled') return reject(new Error(`${v.status}: ${JSON.stringify(v.error)}`));
        if (Date.now() - started > 1_500_000) return reject(new Error('timeout'));
        setTimeout(check, 500);
      };
      check();
    });

    const record = await service.get(recordId);
    if (!record) throw new Error('no record');
    expect(record.flashcards.length).toBeGreaterThan(0);
    expect(record.quizzes.length).toBeGreaterThanOrEqual(0);

    // review state persists
    const cardId = record.flashcards[0]!.id;
    await service.reviewCard(recordId, cardId, 'good');
    const after = await service.get(recordId);
    expect(after?.flashcards[0]?.review.repetitions).toBe(1);
  }, 1_800_000);
});