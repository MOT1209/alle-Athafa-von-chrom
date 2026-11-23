import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  SETTINGS_KEY,
  SettingsStore,
} from '../../src/storage/settings';
import { MemoryStore } from '../../src/storage/kv';

describe('sanitizeSettings', () => {
  it('returns defaults for non-object input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('junk')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values', () => {
    const result = sanitizeSettings({
      language: 'ar',
      ollama: { baseUrl: 'http://localhost:11434/', keepAlive: '0' },
      generation: { model: 'qwen2.5:3b', numCtx: 8192, temperature: 0.7, numPredict: 256 },
      queue: { maxRetries: 3, retryBaseDelayMs: 2000, maxQueueSize: 10 },
      memory: { reserveMb: 4096, enforceBudget: false, unloadAfterTask: true },
    });
    expect(result.language).toBe('ar');
    expect(result.ollama.baseUrl).toBe('http://localhost:11434');
    expect(result.ollama.keepAlive).toBe('0');
    expect(result.generation.model).toBe('qwen2.5:3b');
    expect(result.generation.numCtx).toBe(8192);
    expect(result.queue.maxRetries).toBe(3);
    expect(result.memory.enforceBudget).toBe(false);
    expect(result.memory.unloadAfterTask).toBe(true);
  });

  it('clamps out-of-range numbers', () => {
    const result = sanitizeSettings({
      generation: { numCtx: 999_999, temperature: 9, numPredict: -5 },
      queue: { maxRetries: 99, retryBaseDelayMs: 1, maxQueueSize: 0 },
      memory: { reserveMb: 100 },
      ollama: { requestTimeoutMs: 10 },
    });
    expect(result.generation.numCtx).toBe(131_072);
    expect(result.generation.temperature).toBe(2);
    expect(result.generation.numPredict).toBe(1);
    expect(result.queue.maxRetries).toBe(5);
    expect(result.queue.retryBaseDelayMs).toBe(100);
    expect(result.queue.maxQueueSize).toBe(1);
    expect(result.memory.reserveMb).toBe(512);
    expect(result.ollama.requestTimeoutMs).toBe(1000);
  });

  it('rejects invalid URLs and keepAlive patterns', () => {
    const result = sanitizeSettings({
      ollama: { baseUrl: 'ftp://x', keepAlive: 'banana' },
    });
    expect(result.ollama.baseUrl).toBe(DEFAULT_SETTINGS.ollama.baseUrl);
    expect(result.ollama.keepAlive).toBe('5m');
    expect(sanitizeSettings({ ollama: { baseUrl: 'not a url' } }).ollama.baseUrl).toBe(
      DEFAULT_SETTINGS.ollama.baseUrl,
    );
    expect(sanitizeSettings({ ollama: { keepAlive: '-1' } }).ollama.keepAlive).toBe('-1');
    expect(sanitizeSettings({ ollama: { keepAlive: '30s' } }).ollama.keepAlive).toBe('30s');
  });

  it('falls back for invalid language, model and booleans', () => {
    const result = sanitizeSettings({
      language: 'fr',
      generation: { model: '   ' },
      memory: { enforceBudget: 'yes' },
    });
    expect(result.language).toBe('en');
    expect(result.generation.model).toBe(DEFAULT_SETTINGS.generation.model);
    expect(result.memory.enforceBudget).toBe(true);
  });

  it('ignores unknown keys', () => {
    const result = sanitizeSettings({ evil: true, ollama: { evil: 1 } });
    expect('evil' in result).toBe(false);
    expect('evil' in result.ollama).toBe(false);
  });
});

describe('SettingsStore', () => {
  it('loads defaults when nothing persisted', async () => {
    const store = new SettingsStore(new MemoryStore());
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists updates and merges sections', async () => {
    const kv = new MemoryStore();
    const store = new SettingsStore(kv);
    const next = await store.update({
      generation: { model: 'llama3.2:latest' },
      language: 'ar',
    });
    expect(next.generation.model).toBe('llama3.2:latest');
    expect(next.generation.numCtx).toBe(DEFAULT_SETTINGS.generation.numCtx);
    expect(next.language).toBe('ar');
    expect(await kv.get(SETTINGS_KEY)).toEqual(next);
    expect((await store.load()).language).toBe('ar');
  });

  it('sanitizes hostile patches', async () => {
    const store = new SettingsStore(new MemoryStore());
    const next = await store.update({
      generation: { numCtx: -100 },
      ollama: { baseUrl: 'javascript:alert(1)' },
    });
    expect(next.generation.numCtx).toBe(512);
    expect(next.ollama.baseUrl).toBe(DEFAULT_SETTINGS.ollama.baseUrl);
  });

  it('degrades corrupt persisted data to defaults', async () => {
    const kv = new MemoryStore();
    await kv.set(SETTINGS_KEY, 'corrupted');
    const store = new SettingsStore(kv);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('reset restores defaults', async () => {
    const store = new SettingsStore(new MemoryStore());
    await store.update({ language: 'ar' });
    const next = await store.reset();
    expect(next).toEqual(DEFAULT_SETTINGS);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('propagates storage failures as typed errors', async () => {
    const kv = new MemoryStore();
    kv.set = () => Promise.reject(new Error('disk full'));
    const store = new SettingsStore(kv);
    await expect(store.update({ language: 'ar' })).rejects.toThrow('disk full');
  });
});
