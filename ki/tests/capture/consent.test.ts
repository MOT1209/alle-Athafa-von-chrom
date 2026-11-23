import { describe, expect, it } from 'vitest';
import {
  CONSENT_KEY,
  CONSENT_VERSION,
  ConsentStore,
  isGranted,
  sanitizeConsent,
} from '../../src/capture/consent';
import { MemoryStore } from '../../src/storage/kv';

describe('sanitizeConsent (fail-closed)', () => {
  it('treats missing/corrupt/outdated data as no consent', () => {
    expect(sanitizeConsent(undefined).youtubeCaptions).toBe(false);
    expect(sanitizeConsent('junk').youtubeCaptions).toBe(false);
    expect(sanitizeConsent({ version: 999, youtubeCaptions: true }).youtubeCaptions).toBe(false);
    expect(sanitizeConsent({ version: CONSENT_VERSION, youtubeCaptions: 'yes' }).youtubeCaptions).toBe(false);
  });

  it('accepts a valid current-version grant', () => {
    const state = sanitizeConsent({ version: CONSENT_VERSION, youtubeCaptions: true, grantedAt: 123 });
    expect(state.youtubeCaptions).toBe(true);
    expect(state.grantedAt).toBe(123);
  });
});

describe('ConsentStore', () => {
  it('starts without consent', async () => {
    const store = new ConsentStore(new MemoryStore());
    const state = await store.get();
    expect(isGranted(state, 'youtubeCaptions')).toBe(false);
  });

  it('grant persists and is readable', async () => {
    const kv = new MemoryStore();
    const store = new ConsentStore(kv);
    const granted = await store.grant('youtubeCaptions', 1000);
    expect(granted.youtubeCaptions).toBe(true);
    expect(granted.grantedAt).toBe(1000);
    expect(await kv.get(CONSENT_KEY)).toEqual(granted);
    expect(isGranted(await store.get(), 'youtubeCaptions')).toBe(true);
  });

  it('revoke removes the grant', async () => {
    const store = new ConsentStore(new MemoryStore());
    await store.grant('youtubeCaptions');
    const revoked = await store.revoke('youtubeCaptions');
    expect(revoked.youtubeCaptions).toBe(false);
    expect(revoked.grantedAt).toBeUndefined();
    expect(isGranted(await store.get(), 'youtubeCaptions')).toBe(false);
  });

  it('rejects unknown scopes', async () => {
    const store = new ConsentStore(new MemoryStore());
    await expect(store.grant('everything' as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.revoke('everything' as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
