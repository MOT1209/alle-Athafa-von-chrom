import { AppError } from '../core/errors';
import type { KeyValueStore } from '../storage/kv';

/**
 * Explicit, versioned consent for data capture. Fail-closed: missing, corrupt
 * or outdated consent is treated as NOT granted. Capture features must check
 * this before touching page data.
 */

export const CONSENT_VERSION = 1;
export const CONSENT_KEY = 'videoking.consent.v1';

export type ConsentScope = 'youtubeCaptions';

export interface ConsentState {
  version: number;
  youtubeCaptions: boolean;
  grantedAt?: number;
}

export const NO_CONSENT: ConsentState = {
  version: CONSENT_VERSION,
  youtubeCaptions: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeConsent(raw: unknown): ConsentState {
  if (!isRecord(raw) || raw.version !== CONSENT_VERSION) {
    return { ...NO_CONSENT };
  }
  const state: ConsentState = {
    version: CONSENT_VERSION,
    youtubeCaptions: raw.youtubeCaptions === true,
  };
  if (typeof raw.grantedAt === 'number' && Number.isFinite(raw.grantedAt)) {
    state.grantedAt = raw.grantedAt;
  }
  return state;
}

export class ConsentStore {
  constructor(private kv: KeyValueStore) {}

  async get(): Promise<ConsentState> {
    const raw = await this.kv.get<unknown>(CONSENT_KEY);
    return sanitizeConsent(raw);
  }

  async grant(scope: ConsentScope, now: number = Date.now()): Promise<ConsentState> {
    if (scope !== 'youtubeCaptions') {
      throw new AppError('INVALID_INPUT', `Unknown consent scope: ${scope}`);
    }
    const state: ConsentState = {
      version: CONSENT_VERSION,
      youtubeCaptions: true,
      grantedAt: now,
    };
    await this.kv.set(CONSENT_KEY, state);
    return state;
  }

  async revoke(scope: ConsentScope): Promise<ConsentState> {
    if (scope !== 'youtubeCaptions') {
      throw new AppError('INVALID_INPUT', `Unknown consent scope: ${scope}`);
    }
    const current = await this.get();
    const state: ConsentState = { ...current, youtubeCaptions: false };
    delete state.grantedAt;
    await this.kv.set(CONSENT_KEY, state);
    return state;
  }
}

export function isGranted(state: ConsentState, scope: ConsentScope): boolean {
  return scope === 'youtubeCaptions' && state.youtubeCaptions === true;
}
