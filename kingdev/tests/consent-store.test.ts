/**
 * Consent store tests — the fail-closed guarantees that matter most:
 * corrupt reads deny everything, writes stamp the live version, and
 * grant/revoke never mutate the record they were handed.
 */

import {
  CONSENT_KEY,
  type KeyValueStore,
  createConsentStore,
  grantFeature,
  normalizeConsent,
  revokeFeature,
} from '@/security/consent-store';
import { CONSENT_VERSION, NO_CONSENT } from '@/security/permissions';
import { describe, expect, it, vi } from 'vitest';

function memoryStore(
  initial: Record<string, unknown> = {},
): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
  };
}

const FIXED_NOW = new Date('2026-09-29T12:00:00.000Z');

describe('normalizeConsent', () => {
  it('returns NO_CONSENT for non-object input', () => {
    expect(normalizeConsent(undefined)).toEqual(NO_CONSENT);
    expect(normalizeConsent(null)).toEqual(NO_CONSENT);
    expect(normalizeConsent('yes')).toEqual(NO_CONSENT);
    expect(normalizeConsent(42)).toEqual(NO_CONSENT);
  });

  it('returns NO_CONSENT when any required field is missing or mistyped', () => {
    expect(normalizeConsent({})).toEqual(NO_CONSENT);
    expect(
      normalizeConsent({ version: '1', grantedFeatures: [], recordedAt: '2026-01-01T00:00:00Z' }),
    ).toEqual(NO_CONSENT);
    expect(
      normalizeConsent({ version: 1, grantedFeatures: 'all', recordedAt: '2026-01-01T00:00:00Z' }),
    ).toEqual(NO_CONSENT);
    expect(normalizeConsent({ version: 1, grantedFeatures: [] })).toEqual(NO_CONSENT);
    expect(normalizeConsent({ version: 1, grantedFeatures: [], recordedAt: 'not-a-date' })).toEqual(
      NO_CONSENT,
    );
    expect(
      normalizeConsent({
        version: Number.NaN,
        grantedFeatures: [],
        recordedAt: '2026-01-01T00:00:00Z',
      }),
    ).toEqual(NO_CONSENT);
  });

  it('drops non-string and empty entries, dedupes the rest', () => {
    // Note: unknown *ids* are kept rather than dropped here. The consent
    // record outlives feature renames, and silently rewriting history would
    // hide what the user actually agreed to; `evaluateFeatureAccess` already
    // denies any id that no longer matches a live feature.
    const consent = normalizeConsent({
      version: 1,
      grantedFeatures: ['errorCapture', 'errorCapture', 'gone-feature', 7, null, ''],
      recordedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(consent).toEqual({
      version: 1,
      grantedFeatures: ['errorCapture', 'gone-feature'],
      recordedAt: '2026-01-02T03:04:05.000Z',
    });
  });
});

describe('createConsentStore', () => {
  it('returns NO_CONSENT when nothing was ever saved', async () => {
    const store = createConsentStore(memoryStore(), { now: () => FIXED_NOW });
    await expect(store.load()).resolves.toEqual(NO_CONSENT);
  });

  it('returns NO_CONSENT when storage read throws — never a granted state', async () => {
    const failing: KeyValueStore = {
      get: () => Promise.reject(new Error('storage gone')),
      set: () => Promise.reject(new Error('storage gone')),
    };
    const store = createConsentStore(failing, { now: () => FIXED_NOW });
    await expect(store.load()).resolves.toEqual(NO_CONSENT);
  });

  it('save stamps the live CONSENT_VERSION and the injected clock', async () => {
    const store = memoryStore();
    const consent = createConsentStore(store, { now: () => FIXED_NOW });

    await consent.save({
      version: 99,
      grantedFeatures: ['errorCapture'],
      recordedAt: '2000-01-01T00:00:00Z',
    });

    expect(store.data[CONSENT_KEY]).toEqual({
      version: CONSENT_VERSION,
      grantedFeatures: ['errorCapture'],
      recordedAt: FIXED_NOW.toISOString(),
    });
  });

  it('round-trips: save then load returns the granted feature', async () => {
    const store = memoryStore();
    const consent = createConsentStore(store, { now: () => FIXED_NOW });

    await consent.save({ ...NO_CONSENT, grantedFeatures: ['aiExplanation'] });
    const loaded = await consent.load();

    expect(loaded.grantedFeatures).toEqual(['aiExplanation']);
    expect(loaded.version).toBe(CONSENT_VERSION);
  });

  it('does not write when save rejects — and load still fails closed', async () => {
    const setSpy = vi.fn(() => Promise.reject(new Error('quota')));
    const store: KeyValueStore = { get: () => Promise.resolve(undefined), set: setSpy };
    const consent = createConsentStore(store, { now: () => FIXED_NOW });

    await expect(
      consent.save({
        version: CONSENT_VERSION,
        grantedFeatures: ['errorCapture'],
        recordedAt: 'x',
      }),
    ).rejects.toThrow('quota');
    expect(setSpy).toHaveBeenCalledOnce();
    await expect(consent.load()).resolves.toEqual(NO_CONSENT);
  });
});

describe('grantFeature / revokeFeature', () => {
  const base = {
    version: CONSENT_VERSION,
    grantedFeatures: ['errorCapture'],
    recordedAt: '2026-01-01T00:00:00Z',
  };

  it('grant appends without duplication and never mutates the input', () => {
    const granted = grantFeature(base, 'aiExplanation');
    expect(granted.grantedFeatures).toEqual(['errorCapture', 'aiExplanation']);
    expect(granted).not.toBe(base);
    expect(base.grantedFeatures).toEqual(['errorCapture']);
  });

  it('grant is idempotent', () => {
    const once = grantFeature(base, 'errorCapture');
    expect(once).toBe(base);
  });

  it('revoke removes only the named feature and never mutates the input', () => {
    const widened = { ...base, grantedFeatures: ['errorCapture', 'aiExplanation'] };
    const revoked = revokeFeature(widened, 'aiExplanation');
    expect(revoked.grantedFeatures).toEqual(['errorCapture']);
    expect(widened.grantedFeatures).toEqual(['errorCapture', 'aiExplanation']);
  });

  it('revoke of an absent feature returns the same record', () => {
    expect(revokeFeature(base, 'aiExplanation')).toBe(base);
  });
});
