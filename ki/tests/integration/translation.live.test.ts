/**
 * LIVE Phase 5 acceptance: local-LLM translation keeps segment alignment.
 *
 * Skipped by default. Run with: npm run test:live:translation
 * Requires `ollama serve` and a real model (qwen2.5:1.5b preferred).
 */
import { describe, expect, it } from 'vitest';
import { nodeFetch } from '../helpers/node-fetch';
import { OllamaProvider } from '../../src/ai/providers/ollama';
import { TaskQueue } from '../../src/ai/queue';
import type { LlmProvider, TranscriptSegment } from '../../src/ai/types';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { TranslationRepository } from '../../src/transcripts/translations';
import { TranslationService } from '../../src/transcripts/translation-service';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { segmentsToTranscript } from '../../src/youtube/transcript';
import { exportTranscript } from '../../src/transcripts/export';

const live =
  process.env.VM_LIVE_OLLAMA === '1' && process.env.VM_LIVE_TRANSLATION === '1';
const baseUrl = process.env.VM_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const provider = live
  ? new OllamaProvider({ baseUrl, requestTimeoutMs: 1_800_000, fetchImpl: nodeFetch })
  : undefined;

const installed = live ? await provider!.listModels().catch(() => []) : [];
const targetModel =
  process.env.VM_LIVE_TRANSLATION_MODEL?.trim() ||
  installed.find((m) => m.name === 'qwen2.5:1.5b')?.name ||
  installed[0]?.name;

const EN_SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 2000, text: 'Welcome to the balcony garden series.' },
  { startMs: 2000, endMs: 4500, text: 'Each tomato plant needs at least twenty liters of soil.' },
  { startMs: 4500, endMs: 7000, text: 'They need six hours of direct sunlight every day.' },
];

const AR_SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 2000, text: 'مرحبا بكم في سلسلة حديقة الشرفة.' },
  { startMs: 2000, endMs: 4500, text: 'كل نبتة طماطم تحتاج إلى عشرين لتراً على الأقل من التربة.' },
  { startMs: 4500, endMs: 7000, text: 'تحتاج إلى ست ساعات من أشعة الشمس المباشرة كل يوم.' },
];

async function runTranslation(
  sourceSegments: TranscriptSegment[],
  sourceLanguage: string,
  targetLanguage: string,
  model: string,
): Promise<{ segments: TranscriptSegment[]; count: number }> {
  const kv = new MemoryStore();
  const settings = new SettingsStore(kv);
  await settings.update({
    generation: { model, numCtx: 4096, numPredict: 512, temperature: 0.2 },
    memory: { unloadAfterTask: false },
  });
  const videoId = `live-tr-${sourceLanguage}-${targetLanguage}`;
  const recordId = videoIdFor(videoId);
  const videos = new VideoRepository(kv);
  await videos.save({
    id: recordId,
    platform: 'youtube',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: 'Live translation fixture',
    language: sourceLanguage,
    segmentCount: sourceSegments.length,
    capturedAt: Date.now(),
    transcript: segmentsToTranscript(sourceSegments, sourceLanguage),
  });
  const translations = new TranslationRepository(kv);
  const queue = new TaskQueue({ maxRetries: 1, retryBaseDelayMs: 1000 });
  const wrappedProvider: LlmProvider = {
    id: provider!.id,
    health: () => provider!.health(),
    listModels: () => provider!.listModels(),
    loadedModels: () => provider!.loadedModels(),
    chat: (messages, options) => provider!.chat(messages, options),
    chatStream: (messages, options, onToken) => provider!.chatStream(messages, options, onToken),
  };
  const service = new TranslationService({
    settings,
    videos,
    translations,
    queue,
    makeProvider: () => wrappedProvider,
  });

  const { taskId, deduped } = await service.generate(recordId, targetLanguage);
  expect(deduped).toBe(false);

  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const view = queue.get(taskId);
      if (!view) return setTimeout(check, 500);
      if (view.status === 'succeeded') return resolve();
      if (view.status === 'failed' || view.status === 'cancelled') {
        return reject(new Error(`${view.status}: ${JSON.stringify(view.error)}`));
      }
      if (Date.now() - started > 1_500_000) return reject(new Error('timeout'));
      setTimeout(check, 500);
    };
    check();
  });

  const result = await service.get(recordId);
  if (!result.bundle) throw new Error('no bundle');
  const tr = result.bundle.translations[targetLanguage];
  if (!tr) throw new Error('no translation');
  return { segments: tr.segments, count: tr.segments.length };
}

describe.skipIf(!live || !targetModel)('Translation LIVE acceptance', () => {
  it('EN -> AR keeps segment count and timestamps', async () => {
    const model = targetModel!;
    const { segments, count } = await runTranslation(EN_SEGMENTS, 'en', 'ar', model);
    expect(count).toBe(EN_SEGMENTS.length);
    segments.forEach((segment, index) => {
      expect(segment.startMs).toBe(EN_SEGMENTS[index]!.startMs);
      expect(segment.endMs).toBe(EN_SEGMENTS[index]!.endMs);
      expect(segment.text.trim().length).toBeGreaterThan(0);
    });
    // Export check: VTT starts with WEBVTT
    const vtt = exportTranscript('vtt', { title: 't', segments, language: 'ar' });
    expect(vtt.startsWith('WEBVTT')).toBe(true);
  }, 1_800_000);

  it('AR -> EN keeps segment count and timestamps', async () => {
    const model = targetModel!;
    const { segments, count } = await runTranslation(AR_SEGMENTS, 'ar', 'en', model);
    expect(count).toBe(AR_SEGMENTS.length);
    segments.forEach((segment, index) => {
      expect(segment.startMs).toBe(AR_SEGMENTS[index]!.startMs);
      expect(segment.endMs).toBe(AR_SEGMENTS[index]!.endMs);
      expect(segment.text.trim().length).toBeGreaterThan(0);
    });
    const srt = exportTranscript('srt', { title: 't', segments, language: 'en' });
    expect(srt).toContain('-->');
  }, 1_800_000);
});