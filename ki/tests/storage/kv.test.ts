import { describe, expect, it } from 'vitest';
import { ChromeStore, MemoryStore } from '../../src/storage/kv';
import { AppError } from '../../src/core/errors';

describe('MemoryStore', () => {
  it('round-trips values', async () => {
    const store = new MemoryStore();
    await store.set('k', { a: 1 });
    expect(await store.get('k')).toEqual({ a: 1 });
  });

  it('returns undefined for missing keys', async () => {
    const store = new MemoryStore();
    expect(await store.get('missing')).toBeUndefined();
  });

  it('clones values so callers cannot mutate the store', async () => {
    const store = new MemoryStore();
    const input = { nested: { value: 1 } };
    await store.set('k', input);
    input.nested.value = 99;
    const read = await store.get<{ nested: { value: number } }>('k');
    expect(read?.nested.value).toBe(1);
    if (read) read.nested.value = 50;
    expect((await store.get<{ nested: { value: number } }>('k'))?.nested.value).toBe(1);
  });

  it('removes keys', async () => {
    const store = new MemoryStore();
    await store.set('k', 1);
    await store.remove('k');
    expect(await store.get('k')).toBeUndefined();
  });
});

function fakeArea(behavior: {
  get?: () => Promise<Record<string, unknown>>;
  set?: () => Promise<void>;
  remove?: () => Promise<void>;
} = {}) {
  const data: Record<string, unknown> = {};
  return {
    async get(key: string) {
      if (behavior.get) return behavior.get();
      return { [key]: data[key] };
    },
    async set(items: Record<string, unknown>) {
      if (behavior.set) return behavior.set();
      Object.assign(data, items);
    },
    async remove(key: string) {
      if (behavior.remove) return behavior.remove();
      delete data[key];
    },
  } as unknown as chrome.storage.StorageArea;
}

describe('ChromeStore', () => {
  it('reads and writes through the storage area', async () => {
    const store = new ChromeStore(fakeArea());
    await store.set('k', { v: 2 });
    expect(await store.get('k')).toEqual({ v: 2 });
    await store.remove('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('wraps get failures as STORAGE errors', async () => {
    const store = new ChromeStore(
      fakeArea({ get: () => Promise.reject(new Error('quota')) }),
    );
    await expect(store.get('k')).rejects.toMatchObject({ code: 'STORAGE' });
  });

  it('wraps set failures as STORAGE errors', async () => {
    const store = new ChromeStore(
      fakeArea({ set: () => Promise.reject(new Error('quota')) }),
    );
    await expect(store.set('k', 1)).rejects.toBeInstanceOf(AppError);
  });

  it('wraps remove failures as STORAGE errors', async () => {
    const store = new ChromeStore(
      fakeArea({ remove: () => Promise.reject(new Error('quota')) }),
    );
    await expect(store.remove('k')).rejects.toMatchObject({ code: 'STORAGE' });
  });
});
