/**
 * ConsentState persistence (plan Phase 2).
 *
 * The consent record is the only thing standing between a feature and the
 * user's data, so its storage rules are deliberately boring and strict:
 *
 *   - One JSON document under one key in `chrome.storage.local`. Read-modify-
 *     write with whole-document replacement — no field-level merges that could
 *     resurrect a revoked feature.
 *   - Everything unknown on read is **dropped**, never coerced: a feature id
 *     that no longer exists, a version that is not a number, an entry that is
 *     not a string. Corrupt or foreign data resolves to `NO_CONSENT`, which
 *     denies every feature. Fail-closed, same as `permissions.ts`.
 *   - `version` is rewritten to the live `CONSENT_VERSION` on every write, so
 *     a stale record can only ever come from a read, never from our own write.
 *
 * Like the rest of `src/security`, this module never imports `chrome` types at
 * runtime — storage is reached through the injected `KeyValueStore` port, which
 * keeps the module unit-testable in node and honest about its one dependency.
 */

import type { ConsentState } from '@/security/permissions';
import { CONSENT_VERSION, NO_CONSENT } from '@/security/permissions';

/** Minimal asynchronous key/value port implemented by chrome.storage.local. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const CONSENT_KEY = 'consent';

/** Normalises anything read from storage into a valid ConsentState. */
export function normalizeConsent(raw: unknown): ConsentState {
  if (typeof raw !== 'object' || raw === null) return NO_CONSENT;

  const record = raw as {
    version?: unknown;
    grantedFeatures?: unknown;
    recordedAt?: unknown;
  };

  if (typeof record.version !== 'number' || !Number.isFinite(record.version)) {
    return NO_CONSENT;
  }
  if (!Array.isArray(record.grantedFeatures)) return NO_CONSENT;
  if (typeof record.recordedAt !== 'string' || record.recordedAt === '') {
    return NO_CONSENT;
  }
  // ISO or bust: `Date.parse('hello')` is NaN, and a date we cannot parse is a
  // date we cannot audit.
  if (Number.isNaN(Date.parse(record.recordedAt))) return NO_CONSENT;

  const seen = new Set<string>();
  for (const entry of record.grantedFeatures) {
    if (typeof entry === 'string' && entry !== '') seen.add(entry);
  }

  return {
    version: record.version,
    grantedFeatures: [...seen],
    recordedAt: record.recordedAt,
  };
}

export interface ConsentStore {
  load(): Promise<ConsentState>;
  save(next: ConsentState): Promise<void>;
}

export function createConsentStore(
  store: KeyValueStore,
  options: { now?: () => Date } = {},
): ConsentStore {
  const now = options.now ?? (() => new Date());

  return {
    async load(): Promise<ConsentState> {
      try {
        return normalizeConsent(await store.get(CONSENT_KEY));
      } catch {
        // A storage failure must never read as "consent granted".
        return NO_CONSENT;
      }
    },

    async save(next: ConsentState): Promise<void> {
      // Stamp the live version and time at the boundary, so callers cannot
      // accidentally persist a stale-version record from a closed dialog.
      const stamped: ConsentState = {
        version: CONSENT_VERSION,
        grantedFeatures: [...next.grantedFeatures],
        recordedAt: now().toISOString(),
      };
      await store.set(CONSENT_KEY, stamped);
    },
  };
}

/** Grants a feature, preserving unrelated grants. Pure — returns a new record. */
export function grantFeature(consent: ConsentState, featureId: string): ConsentState {
  if (consent.grantedFeatures.includes(featureId)) return consent;
  return {
    ...consent,
    grantedFeatures: [...consent.grantedFeatures, featureId],
  };
}

/** Revokes a feature. Pure. */
export function revokeFeature(consent: ConsentState, featureId: string): ConsentState {
  if (!consent.grantedFeatures.includes(featureId)) return consent;
  return {
    ...consent,
    grantedFeatures: consent.grantedFeatures.filter((id) => id !== featureId),
  };
}
