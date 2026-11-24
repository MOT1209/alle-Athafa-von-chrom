import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/kv';
import {
  TranslationRepository,
  staleLanguages,
  normalizeLanguageCode,
} from '../../src/transcripts/translations';
import { segmentsToTranscript } from '../../src/youtube/transcript';

describe('transcripts/translations', () => {
  it('normalizes language codes', () => {
    expect(normalizeLanguageCode('AR')).toBe('ar');
    expect(normalizeLanguageCode('en-US')).toBe('en-us');
    expect(normalizeLanguageCode('1')).toBeUndefined();
    expect(normalizeLanguageCode('')).toBeUndefined();
  });

  it('saves and reads a bundle', async () => {
    const kv = new MemoryStore();
    const repo = new TranslationRepository(kv);
    const segments = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'hello' }],
      'en',
    ).segments;
    const bundle = await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      translation: {
        targetLanguage: 'ar',
        model: 'm',
        createdAt: 1,
        sourceSignature: 'sig1',
        segments,
      },
    });
    expect(bundle.translations.ar).toBeDefined();
    const read = await repo.get('v1');
    expect(read?.translations.ar?.targetLanguage).toBe('ar');
    const one = await repo.getTranslation('v1', 'ar');
    expect(one?.segments).toHaveLength(1);
    const list = await repo.list();
    expect(list).toHaveLength(1);
  });

  it('removeLanguage deletes the bundle when empty', async () => {
    const kv = new MemoryStore();
    const repo = new TranslationRepository(kv);
    const segments = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'hello' }],
      'en',
    ).segments;
    await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      translation: {
        targetLanguage: 'ar',
        model: 'm',
        createdAt: 1,
        sourceSignature: 'sig1',
        segments,
      },
    });
    const removed = await repo.removeLanguage('v1', 'ar');
    expect(removed).toBe(true);
    expect(await repo.get('v1')).toBeUndefined();
  });

  it('staleLanguages flags changed signatures', () => {
    const bundle = {
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      updatedAt: 1,
      translations: {
        ar: {
          targetLanguage: 'ar',
          model: 'm',
          createdAt: 1,
          sourceSignature: 'old',
          segments: [{ startMs: 0, endMs: 1000, text: 'x' }],
        },
      },
    };
    expect(staleLanguages(bundle, 'new')).toEqual(['ar']);
    expect(staleLanguages(bundle, 'old')).toEqual([]);
  });

  it('remove returns true when present', async () => {
    const kv = new MemoryStore();
    const repo = new TranslationRepository(kv);
    const segments = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'hello' }],
      'en',
    ).segments;
    await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      translation: {
        targetLanguage: 'ar',
        model: 'm',
        createdAt: 1,
        sourceSignature: 'sig1',
        segments,
      },
    });
    expect(await repo.remove('v1')).toBe(true);
    expect(await repo.remove('v1')).toBe(false);
  });
});