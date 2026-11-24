import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { TranslationRepository } from '../../src/transcripts/translations';
import { TranslationService } from '../../src/transcripts/translation-service';
import { TaskQueue } from '../../src/ai/queue';
import type { LlmProvider, ChatResult, GenerationOptions, ChatMessage } from '../../src/ai/types';
import { segmentsToTranscript } from '../../src/youtube/transcript';

function fakeProvider(reply: string): LlmProvider {
  return {
    id: 'fake',
    async health() { return { ok: true }; },
    async listModels() { return []; },
    async loadedModels() { return []; },
    async chat(_messages: ChatMessage[], _options?: GenerationOptions): Promise<ChatResult> {
      return { content: reply, model: 'fake', done: true };
    },
    async chatStream() { throw new Error('no'); },
  };
}

async function makeHarness(targetLanguage = 'ar') {
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
  const translations = new TranslationRepository(kv);
  const queue = new TaskQueue({ maxRetries: 0 });
  const reply = JSON.stringify({
    segments: [
      { key: '0', text: 'مرحبا بالعالم' },
      { key: '1', text: 'فوب بار' },
    ],
  });
  const service = new TranslationService({
    settings,
    videos,
    translations,
    queue,
    makeProvider: () => fakeProvider(reply),
  });
  return { service, queue, translations, videos };
}

describe('transcripts/translation-service', () => {
  it('generates and stores a translation', async () => {
    const { service, queue, translations } = await makeHarness();
    const { taskId, deduped } = await service.generate('yt_a', 'ar');
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
    expect(got.bundle).not.toBeNull();
    expect(got.bundle?.translations.ar?.segments).toHaveLength(2);
    expect(got.bundle?.translations.ar?.segments[0]?.startMs).toBe(0);
    const tlist = await service.list();
    expect(tlist).toHaveLength(1);
  });

  it('rejects target equal to source language', async () => {
    const { service } = await makeHarness();
    await expect(service.generate('yt_a', 'en')).rejects.toThrow();
  });

  it('rejects unknown video', async () => {
    const { service } = await makeHarness();
    await expect(service.generate('yt_missing', 'ar')).rejects.toThrow();
  });

  it('removeLanguage works', async () => {
    const { service, queue } = await makeHarness();
    const { taskId } = await service.generate('yt_a', 'ar');
    await new Promise<void>((resolve) => {
      const check = () => {
        const v = queue.get(taskId) as { status: string } | undefined;
        if (v && ['succeeded', 'failed', 'cancelled'].includes(v.status)) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    const res = await service.removeLanguage('yt_a', 'ar');
    expect(res.removed).toBe(true);
    const got = await service.get('yt_a');
    expect(got.bundle).toBeNull();
  });

  it('stale detection flags edited source', async () => {
    const { service, videos, queue } = await makeHarness();
    const { taskId } = await service.generate('yt_a', 'ar');
    await new Promise<void>((resolve) => {
      const check = () => {
        const v = queue.get(taskId) as { status: string } | undefined;
        if (v && ['succeeded', 'failed', 'cancelled'].includes(v.status)) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    // edit transcript
    const rec = await videos.get('yt_a');
    if (rec) {
      rec.transcript.segments[0]!.text = 'changed';
      await videos.updateTranscript('yt_a', rec.transcript);
    }
    const got = await service.get('yt_a');
    expect(got.staleLanguages).toContain('ar');
  });
});