/**
 * Analyzer tests — consent gate first, prompt from deterministic evidence,
 * one provider call, structured parse, reconciliation. All provider IO goes
 * through the injected HttpLike stub; no test touches the network.
 */

import { aiAccessDecision, analyzeIssue, modelSpecFor } from '@/core/analysis/analyzer';
import type { HttpLike } from '@/core/providers/client';
import { type KeyValueStore, KeyVault } from '@/core/providers/key-vault';
import type { CapturedError, ErrorGroup, NetworkRequest, RootCause, Settings } from '@/core/types';
import { CONSENT_VERSION, type ConsentState } from '@/security/permissions';
import { describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function error(overrides: Partial<CapturedError> = {}): CapturedError {
  return {
    id: 'err_1',
    kind: 'javascript',
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'userId')",
    stack: 'TypeError: boom\n    at render (app.js:10:5)',
    frames: [
      { functionName: 'render', url: 'https://app.dev/app.js', lineNumber: 10, columnNumber: 5 },
    ],
    timestamp: '2026-09-29T10:00:00.000Z',
    fingerprint: 'fp-1',
    occurrences: 2,
    origin: 'content-script',
    relatedConsoleIds: [],
    relatedRequestIds: ['req_1'],
    pageUrl: 'https://app.dev/orders',
    pageTitle: 'Orders',
    ...overrides,
  };
}

function rootCause(overrides: Partial<RootCause> = {}): RootCause {
  return {
    category: 'network-failure',
    statement: 'The orders API returned 500.',
    confidence: 'high',
    confidenceSignals: [{ signal: 'rule network/server-error fired', weight: 0.9 }],
    supportingEvidenceIds: ['rule-server-req_1'],
    contradictingEvidenceIds: [],
    alternatives: [],
    ruleIds: ['network/server-error'],
    ...overrides,
  };
}

function group(overrides: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    id: 'grp_fp-1',
    fingerprint: 'fp-1',
    representativeErrorId: 'err_1',
    errorIds: ['err_1', 'err_2'],
    duplicateCount: 2,
    title: 'TypeError: boom (2 occurrences)',
    severity: 'high',
    severityJustification: [],
    rootCause: rootCause(),
    firstSeenAt: '2026-09-29T10:00:00.000Z',
    lastSeenAt: '2026-09-29T10:05:00.000Z',
    relatedRequestIds: ['req_1'],
    relatedConsoleIds: [],
    ...overrides,
  };
}

function request(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
  return {
    id: 'req_1',
    url: 'https://app.dev/api/orders',
    method: 'GET',
    statusCode: 500,
    outcome: 'server-error',
    startedAt: '2026-09-29T09:59:59.000Z',
    fromCache: false,
    requestHeaderNames: [],
    responseHeaderNames: [],
    isThirdParty: false,
    ...overrides,
  };
}

const SETTINGS: Settings = {
  version: 1,
  activeProviderId: 'openai',
  activeModelId: 'gpt-test-1',
  providers: [],
  tierModels: { fast: '', balanced: '', powerful: '', local: '', custom: '' },
  routing: 'manual',
  routingRules: [],
  contextDefaults: {},
  promptBudgetChars: 12_000,
  redactSecrets: true,
  redactPii: true,
  theme: 'dark',
  shortcuts: [],
  telemetry: false,
  retainHistory: true,
  maxSessions: 100,
  autoCapture: true,
  requestTimeoutMs: 5_000,
  maxRetries: 0,
};

function consent(granted = true): ConsentState {
  return {
    version: CONSENT_VERSION,
    grantedFeatures: granted ? ['aiExplanation'] : [],
    recordedAt: '2026-09-29T00:00:00.000Z',
  };
}

function memoryKv(keys: Record<string, string> = {}): KeyValueStore {
  const data: Record<string, unknown> = { providerKeys: keys };
  return {
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
  };
}

function httpStub(body: unknown): HttpLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    },
  };
}

const MODEL_REPLY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: 'Orders API 500',
          summary: 'The API failed and the page threw.',
          severity: 'high',
          severityReason: 'Uncaught on primary flow.',
          confidence: 'high',
          confidenceReason: 'Rule backed.',
          rootCause: 'The orders API returns 500.',
          rootCauseCategory: 'network-failure',
          alternatives: [],
          fixes: [],
          unknowns: [],
          referencedEvidenceIds: ['rule-server-req_1'],
        }),
      },
    },
  ],
};

/* ------------------------------------------------------------------ *
 * modelSpecFor
 * ------------------------------------------------------------------ */

describe('modelSpecFor', () => {
  it('builds a spec from a free-text model id', () => {
    const spec = modelSpecFor('openai', '  gpt-test-1 ');
    expect(spec.ok).toBe(true);
    if (spec.ok) expect(spec.value.modelId).toBe('gpt-test-1');
  });

  it('rejects an empty model id before any network call', () => {
    const spec = modelSpecFor('openai', '   ');
    expect(spec.ok).toBe(false);
    if (!spec.ok) expect(spec.error.code).toBe('INVALID_INPUT');
  });

  it('rejects malformed ids (newlines, overlong)', () => {
    expect(modelSpecFor('openai', 'a\nb').ok).toBe(false);
    expect(modelSpecFor('openai', 'x'.repeat(201)).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * aiAccessDecision — the logical egress permission gate
 * ------------------------------------------------------------------ */

describe('aiAccessDecision', () => {
  it('allows when consented at the current version with storage granted', () => {
    const decision = aiAccessDecision({
      consent: consent(),
      grantedPermissions: ['storage'],
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies when not consented even with grants present', () => {
    const decision = aiAccessDecision({
      consent: consent(false),
      grantedPermissions: ['storage'],
    });
    expect(decision.allowed).toBe(false);
  });

  it('denies stale consent (fail-closed)', () => {
    const stale = { ...consent(), version: CONSENT_VERSION - 1 };
    expect(aiAccessDecision({ consent: stale, grantedPermissions: ['storage'] }).allowed).toBe(
      false,
    );
  });

  it('denies when even storage is missing', () => {
    const decision = aiAccessDecision({ consent: consent(), grantedPermissions: [] });
    expect(decision.allowed).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * analyzeIssue — end to end over the injected transport
 * ------------------------------------------------------------------ */

describe('analyzeIssue', () => {
  function input(
    overrides: {
      consent?: ConsentState;
      grantedPermissions?: string[];
      settings?: Partial<Settings>;
      http?: HttpLike & { calls: { url: string; init: RequestInit }[] };
      vault?: KeyVault;
    } = {},
  ) {
    const http = overrides.http ?? httpStub(MODEL_REPLY);
    return {
      http,
      input: {
        group: group(),
        representative: error(),
        groupErrors: [error(), error({ id: 'err_2', fingerprint: 'fp-1' })],
        correlatedRequests: [request()],
        pageUrl: 'https://app.dev/orders',
        settings: { ...SETTINGS, ...overrides.settings },
        consent: overrides.consent ?? consent(),
        grantedPermissions: overrides.grantedPermissions ?? ['storage'],
        ports: {
          keyVault: overrides.vault ?? new KeyVault(memoryKv({ openai: 'sk-test-12345678' })),
          http,
        },
      },
    };
  }

  it('refuses before anything else when consent is missing', async () => {
    const { http, input: payload } = input({ consent: consent(false) });
    const result = await analyzeIssue(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONSENT_REQUIRED');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses an unset model id before any network call', async () => {
    const { http, input: payload } = input({ settings: { activeModelId: '' } });
    const result = await analyzeIssue(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    expect(http.calls).toHaveLength(0);
  });

  it('runs the full pipeline and returns a reconciled outcome', async () => {
    const { http, input: payload } = input();
    const result = await analyzeIssue(payload);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(http.calls).toHaveLength(1);
    expect(result.value.groupId).toBe('grp_fp-1');
    expect(result.value.modelId).toBe('gpt-test-1');
    expect(result.value.analysis.rootCauseCategory).toBe('network-failure');
    expect(result.value.deterministicContradicted).toBe(false);
    expect(result.value.modelAsserted).toBe(false);
    expect(result.value.promptChars).toBeGreaterThan(0);
    // Evidence, not free text, went over the wire.
    const body = String(http.calls[0]?.init.body);
    expect(body).toContain('network/server-error');
    expect(body).toContain('BINDING DETERMINISTIC FINDING');
  });

  it('surfaces a contradiction when the model overrides a rule-backed cause', async () => {
    const contradictoryReply = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...(JSON.parse(
                (MODEL_REPLY.choices[0]?.message?.content ?? '{}') as string,
              ) as object),
              rootCauseCategory: 'undefined-access',
            }),
          },
        },
      ],
    };
    const { input: payload } = input({ http: httpStub(contradictoryReply) });
    const result = await analyzeIssue(payload);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deterministicContradicted).toBe(true);
    expect(result.value.contradictionNotes.join(' ')).toContain('deterministic finding');
  });

  it('maps malformed model output to PROVIDER_BAD_RESPONSE', async () => {
    const { input: payload } = input({
      http: httpStub({ choices: [{ message: { content: 'It is probably DNS.' } }] }),
    });
    const result = await analyzeIssue(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_BAD_RESPONSE');
  });

  it('propagates provider auth failures as-is', async () => {
    const authFail: HttpLike = {
      fetch: () => Promise.resolve(new Response('denied', { status: 401 })),
    };
    const { input: payload } = input({ http: { ...authFail, calls: [] } });
    const result = await analyzeIssue(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_AUTH');
  });

  it('reads the key from the vault and never includes it in the outcome', async () => {
    const { input: payload } = input();
    const result = await analyzeIssue(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain('sk-test-12345678');
  });

  it('fails closed when the vault cannot be read', async () => {
    const failing: KeyValueStore = {
      get: () => Promise.reject(new Error('gone')),
      set: () => Promise.reject(new Error('gone')),
    };
    const { input: payload } = input({ vault: new KeyVault(failing) });
    const result = await analyzeIssue(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('STORAGE_FAILURE');
  });
});
