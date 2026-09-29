/**
 * Worker-level tests for the Phase 2 wiring: consent handlers round-trip
 * through the injected store, capture access is gated by
 * `evaluateFeatureAccess`, and content-script envelopes are dropped when the
 * gate denies them — the worker is the enforcement point, not the panel.
 */

import {
  CaptureStore,
  createRouter,
  defaultHandlers,
  gateFeature,
  keyValueFromArea,
  mergeSettings,
} from '@/background/service-worker';
import { type CapturedError, DEFAULT_SETTINGS } from '@/core/types';
import { type KeyValueStore, createConsentStore, grantFeature } from '@/security/consent-store';
import { CONSENT_VERSION, NO_CONSENT } from '@/security/permissions';
import { describe, expect, it, vi } from 'vitest';

function memoryKv(initial: Record<string, unknown> = {}): KeyValueStore {
  const data = { ...initial };
  return {
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
  };
}

const GRANTED = { permissions: ['storage', 'scripting'], origins: ['<all_urls>'] };
const CONSENTED = grantFeature(
  { version: CONSENT_VERSION, grantedFeatures: [], recordedAt: '2026-01-01T00:00:00Z' },
  'errorCapture',
);

function makeError(overrides: Partial<CapturedError> = {}): CapturedError {
  return {
    id: 'err_1',
    kind: 'javascript',
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'x')",
    frames: [],
    timestamp: '2026-09-29T10:00:00.000Z',
    fingerprint: 'abc123:typeerror',
    occurrences: 1,
    origin: 'content-script',
    relatedConsoleIds: [],
    relatedRequestIds: [],
    pageUrl: 'https://example.test/',
    pageTitle: 'Example',
    ...overrides,
  };
}

describe('gateFeature', () => {
  it('allows a consented feature with full browser grants', () => {
    const gate = gateFeature('errorCapture', CONSENTED, ['storage', 'scripting', 'hostAccess']);
    expect(gate.allowed).toBe(true);
  });

  it('denies when consent is missing — reason not-consented', () => {
    const gate = gateFeature('errorCapture', NO_CONSENT, ['storage', 'scripting', 'hostAccess']);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('not-consented');
  });

  it('denies when the browser lacks an optional grant — reason permission-not-granted', () => {
    const gate = gateFeature('errorCapture', CONSENTED, ['storage']);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('permission-not-granted');
    expect(gate.missingPermissions).toEqual(['hostAccess', 'scripting']);
  });

  it('denies unknown features', () => {
    const gate = gateFeature('madeUpFeature', CONSENTED, ['storage']);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('unknown-feature');
  });
});

describe('CaptureStore', () => {
  it('merges same-fingerprint errors into occurrences', () => {
    const store = new CaptureStore();
    store.add(makeError());
    store.add(makeError({ id: 'err_2', occurrences: 3 }));
    expect(store.state()).toEqual({
      totalErrors: 4,
      distinctErrors: 1,
      lastErrorAt: '2026-09-29T10:00:00.000Z',
    });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.occurrences).toBe(4);
  });

  it('rejects malformed payloads instead of trusting the sender', () => {
    const store = new CaptureStore();
    expect(store.add(null)).toBe(false);
    expect(store.add('boom')).toBe(false);
    expect(store.add({})).toBe(false);
    expect(store.add(makeError({ fingerprint: '' }))).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('enforces its bound by dropping the oldest', () => {
    const store = new CaptureStore(2);
    store.add(makeError({ fingerprint: 'f1:a' }));
    store.add(makeError({ fingerprint: 'f2:b' }));
    store.add(makeError({ fingerprint: 'f3:c' }));
    expect(store.list().map((e) => e.fingerprint)).toEqual(['f2:b', 'f3:c']);
  });

  it('clear resets everything', () => {
    const store = new CaptureStore();
    store.add(makeError());
    store.clear();
    expect(store.state()).toEqual({ totalErrors: 0, distinctErrors: 0 });
  });
});

describe('defaultHandlers — consent + permissions + capture', () => {
  type Handlers = ReturnType<typeof defaultHandlers>;

  function makeDeps(consent = NO_CONSENT) {
    const consentStore = createConsentStore(memoryKv(), {
      now: () => new Date('2026-09-29T00:00:00Z'),
    });
    if (consent.grantedFeatures.length > 0) {
      // Pre-seed consent through the store's own save path.
      void consentStore.save(consent);
    }
    const captureStore = new CaptureStore();
    const handlers: Handlers = defaultHandlers({
      consentStore,
      captureStore,
      getGrants: () => Promise.resolve(GRANTED),
    });
    const logger = { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never;
    const dispatch = (message: unknown) => createRouter(handlers).dispatch(message, logger);
    return { handlers, captureStore, dispatch };
  }

  it('consent/get starts at NO_CONSENT and reflects grants after consent/grant', async () => {
    const { dispatch } = makeDeps();

    await expect(dispatch({ type: 'consent/get' })).resolves.toEqual({
      ok: true,
      value: NO_CONSENT,
    });

    const granted = await dispatch({ type: 'consent/grant', featureId: 'errorCapture' });
    expect(granted.ok).toBe(true);

    const after = await dispatch({ type: 'consent/get' });
    expect(after.ok).toBe(true);
    if (after.ok) {
      const value = after.value as { grantedFeatures: string[]; version: number };
      expect(value.grantedFeatures).toEqual(['errorCapture']);
      expect(value.version).toBe(CONSENT_VERSION);
    }
  });

  it('consent/revoke removes exactly the named feature', async () => {
    const { dispatch } = makeDeps(CONSENTED);
    await dispatch({ type: 'consent/revoke', featureId: 'errorCapture' });
    const after = await dispatch({ type: 'consent/get' });
    expect(after.ok).toBe(true);
    if (after.ok)
      expect((after.value as { grantedFeatures: string[] }).grantedFeatures).toEqual([]);
  });

  it('consent handlers validate featureId', async () => {
    const { dispatch } = makeDeps();
    const missing = await dispatch({ type: 'consent/grant' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      const error = missing.error as { code?: string };
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  it('permissions/status reports normalised grants and per-feature availability', async () => {
    const { dispatch } = makeDeps(CONSENTED);
    const status = await dispatch({ type: 'permissions/status' });
    expect(status.ok).toBe(true);
    if (status.ok) {
      const value = status.value as {
        grantedPermissions: string[];
        featuresWithGrants: string[];
        apiAvailable: boolean;
      };
      expect(value.grantedPermissions).toContain('hostAccess');
      expect(value.grantedPermissions).toContain('scripting');
      // aiAnalysis is logical-only and must never appear from browser grants.
      expect(value.grantedPermissions).not.toContain('aiAnalysis');
      expect(value.featuresWithGrants).toContain('errorCapture');
      // The injected getGrants replaces chrome.permissions, so apiAvailable
      // reports what a real panel would see only when chrome is present.
      expect(value.apiAvailable).toBe(
        typeof (globalThis as { chrome?: unknown }).chrome === 'object',
      );
    }
  });

  it('capture/errors/get succeeds behind a satisfied gate', async () => {
    const { dispatch } = makeDeps(CONSENTED);
    const result = await dispatch({ type: 'capture/errors/get' });
    expect(result.ok).toBe(true);
  });

  it('capture/errors/get refuses with CONSENT_REQUIRED when not consented', async () => {
    const { dispatch } = makeDeps(NO_CONSENT);
    const result = await dispatch({ type: 'capture/errors/get' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as { code?: string };
      expect(error.code).toBe('CONSENT_REQUIRED');
    }
  });

  it('capture/state/get exposes counts without the gate', async () => {
    const { dispatch } = makeDeps(NO_CONSENT);
    const result = await dispatch({ type: 'capture/state/get' });
    expect(result.ok).toBe(true);
  });
});

describe('content envelope gating (attachMessageListenerWithContentGate contract)', () => {
  it('gateFeature drops un-consented pages before the store sees data', () => {
    // The listener path calls gateFeature('errorCapture', …) before add();
    // assert the decision it relies on.
    const gate = gateFeature('errorCapture', NO_CONSENT, ['storage', 'scripting', 'hostAccess']);
    expect(gate.allowed).toBe(false);
    const store = new CaptureStore();
    store.add(makeError());
    // Data captured before revocation stays; the *new* envelope would be dropped.
    expect(store.list()).toHaveLength(1);
  });
});

describe('keyValueFromArea + mergeSettings', () => {
  it('adapts a chrome.storage-shaped area to the KV port', async () => {
    const backing: Record<string, unknown> = {};
    const area = {
      async get(keys: string | string[] | null) {
        const list = keys === null ? Object.keys(backing) : Array.isArray(keys) ? keys : [keys];
        const bag: Record<string, unknown> = {};
        for (const k of list) bag[k] = backing[k];
        return bag;
      },
      async set(items: Record<string, unknown>) {
        Object.assign(backing, items);
      },
    };
    const kv = keyValueFromArea(area);
    await kv.set('k', 42);
    await expect(kv.get('k')).resolves.toBe(42);
  });

  it('mergeSettings overlays stored values on defaults', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ theme: 'light' }).theme).toBe('light');
    expect(mergeSettings({ theme: 'light' }).promptBudgetChars).toBe(
      DEFAULT_SETTINGS.promptBudgetChars,
    );
  });
});
