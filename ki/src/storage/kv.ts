import { AppError } from '../core/errors';

/**
 * Storage abstraction. Business logic depends on KeyValueStore, never on
 * chrome.* directly, so every module is unit-testable with MemoryStore.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory store for tests. Values are cloned to preserve immutability. */
export class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/** chrome.storage adapter. Storage failures become typed STORAGE errors. */
export class ChromeStore implements KeyValueStore {
  constructor(private area: chrome.storage.StorageArea) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const record = await this.area.get(key);
      return record[key] as T | undefined;
    } catch (err) {
      throw AppError.wrap(err, 'STORAGE');
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await this.area.set({ [key]: value });
    } catch (err) {
      throw AppError.wrap(err, 'STORAGE');
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.area.remove(key);
    } catch (err) {
      throw AppError.wrap(err, 'STORAGE');
    }
  }
}
