/**
 * Provider key vault (plan Phase 3).
 *
 * Storage rules, restated from the worker's implementation so the panel and
 * the worker agree on one format:
 *
 *   - Keys live under one key in `chrome.storage.local`, never in session or
 *     sync (`sync` would leave the device — the one place keys must never go).
 *   - The panel may only ever see *presence*, never values. Every read path
 *     here projects to `{ providerId: boolean }`.
 *   - Writing replaces whole provider entries; there is no partial key.
 *
 * The vault is pure logic over a `KeyValueStore` port, so the worker can back
 * it with chrome.storage while tests use an in-memory map.
 */

import type { ProviderId } from '@/core/types';

/** Must match the worker's KEYS_KEY. Single source enforced by e2e naming. */
export const PROVIDER_KEYS_STORAGE_KEY = 'providerKeys';

/** Minimal async KV port (mirrors consent-store's port on purpose). */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** providerId -> key. Only this module may hold materialised keys. */
export type KeyMap = Readonly<Record<string, string>>;

/** providerId -> has key. The only shape that may cross to the UI. */
export type KeyPresence = Readonly<Record<string, boolean>>;

export function toKeyPresence(keys: KeyMap): KeyPresence {
  const out: Record<string, boolean> = {};
  for (const [id, key] of Object.entries(keys)) out[id] = key.length > 0;
  return out;
}

export class KeyVault {
  constructor(private readonly store: KeyValueStore) {}

  async loadAll(): Promise<KeyMap> {
    try {
      const raw = await this.store.get(PROVIDER_KEYS_STORAGE_KEY);
      if (typeof raw !== 'object' || raw === null) return {};
      const out: Record<string, string> = {};
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) out[id] = value;
      }
      return out;
    } catch {
      // Fail closed: an unreadable vault reads as "no keys", not as an error
      // the UI would render as "configured".
      return {};
    }
  }

  async presence(): Promise<KeyPresence> {
    return toKeyPresence(await this.loadAll());
  }

  async set(providerId: ProviderId, key: string | null): Promise<KeyPresence> {
    const current = { ...(await this.loadAll()) };
    if (key === null || key.trim() === '') delete current[providerId];
    else current[providerId] = key.trim();
    await this.store.set(PROVIDER_KEYS_STORAGE_KEY, current);
    return toKeyPresence(current);
  }

  async hasKey(providerId: ProviderId): Promise<boolean> {
    const keys = await this.loadAll();
    return (keys[providerId]?.length ?? 0) > 0;
  }
}

/**
 * Cheap structural validation performed *before* a network call, so an
 * obviously malformed key fails fast locally instead of burning a provider
 * round-trip. Not a real format check — providers change formats; this only
 * catches paste errors (trailing newlines, JSON dumps, empty strings).
 */
export function looksLikePlausibleKey(providerId: ProviderId, key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length < 8) return false;
  if (/[\r\n]/.test(trimmed)) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;

  // Provider prefixes are a strong signal but not universal (OpenRouter, for
  // example, forwards keys that do not start with `sk-or-`), so a failure to
  // match a known prefix is advisory only and returns true.
  void providerId;
  return true;
}
