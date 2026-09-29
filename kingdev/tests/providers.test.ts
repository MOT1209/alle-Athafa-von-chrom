/**
 * Provider layer tests: protocol bodies/urls, error mapping stability, key
 * enforcement, and the vault's presence-only UI projection.
 */

import { PROVIDERS, modelsForProvider, providerById } from '@/core/providers/catalog';
import {
  type HttpLike,
  complete,
  keyResolverFromMap,
  mapProviderFailure,
} from '@/core/providers/client';
import { type KeyValueStore, KeyVault, looksLikePlausibleKey } from '@/core/providers/key-vault';
import type { CompletionRequest, ModelSpec, ProviderId } from '@/core/types';
import { describe, expect, it } from 'vitest';

function spec(providerId: ProviderId, modelId = 'test-model'): ModelSpec {
  return {
    providerId,
    modelId,
    displayName: modelId,
    tier: 'balanced',
    contextWindow: 128_000,
    supportsTools: false,
    supportsVision: false,
  };
}

function baseRequest(providerId: ProviderId, modelId?: string): CompletionRequest {
  return {
    model: spec(providerId, modelId),
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Say hi.' },
    ],
  };
}

function httpStub(
  respond: (url: string, init: RequestInit) => { status: number; body: unknown },
): HttpLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const { status, body } = respond(url, init);
      return Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      );
    },
  };
}

describe('catalog', () => {
  it('describes all six providers with correct protocols', () => {
    const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
    expect(byId.openai?.protocol).toBe('openai');
    expect(byId.openrouter?.protocol).toBe('openai');
    expect(byId.anthropic?.protocol).toBe('anthropic');
    expect(byId.google?.protocol).toBe('google');
    expect(byId.ollama?.protocol).toBe('ollama');
    expect(byId.ollama?.local).toBe(true);
    expect(byId.ollama?.keyRequired).toBe(false);
  });

  it('providerById and modelsForProvider resolve', () => {
    expect(providerById('anthropic')?.displayName).toBe('Anthropic');
    expect(modelsForProvider('ollama').every((m) => m.providerId === 'ollama')).toBe(true);
  });
});

describe('complete — per-protocol requests', () => {
  const keyResolver = keyResolverFromMap({
    openai: 'sk-openai-key-123',
    anthropic: 'sk-ant-key-123',
    google: 'g-key-12345',
  });

  it('openai protocol hits chat/completions with a bearer key', async () => {
    const http = httpStub(() => ({
      status: 200,
      body: { choices: [{ message: { content: 'Hi!' } }], model: 'test-model' },
    }));
    const result = await complete(baseRequest('openai'), { http, keyResolver });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('Hi!');
    expect(http.calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = http.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-openai-key-123');
    expect(result.value.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('anthropic protocol uses x-api-key and hoists system message', async () => {
    const http = httpStub(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: 'Hello' }] },
    }));
    const result = await complete(
      { ...baseRequest('anthropic'), maxOutputTokens: 77 },
      { http, keyResolver },
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(http.calls[0]?.init.body)) as {
      system?: string;
      messages: { role: string }[];
      max_tokens: number;
    };
    expect(http.calls[0]?.url).toContain('https://api.anthropic.com/v1/messages');
    const headers = http.calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-key-123');
    expect(body.system).toBe('You are terse.');
    expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
    expect(body.max_tokens).toBe(77);
  });

  it('google protocol puts the key in the query and maps roles', async () => {
    const http = httpStub(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'Salve' }] } }] },
    }));
    const result = await complete(baseRequest('google'), { http, keyResolver });

    expect(result.ok).toBe(true);
    expect(http.calls[0]?.url).toContain('models/test-model:generateContent?key=g-key-12345');
    const body = JSON.parse(String(http.calls[0]?.init.body)) as {
      contents: { role: string }[];
      systemInstruction?: { parts: { text: string }[] };
    };
    expect(body.contents[0]?.role).toBe('user');
    expect(body.systemInstruction?.parts[0]?.text).toBe('You are terse.');
  });

  it('ollama needs no key and posts to /api/chat', async () => {
    const http = httpStub(() => ({
      status: 200,
      body: { message: { content: 'Local answer' } },
    }));
    const result = await complete(baseRequest('ollama', 'llama3.1:8b'), {
      http,
      keyResolver: keyResolverFromMap({}),
    });

    expect(result.ok).toBe(true);
    expect(http.calls[0]?.url).toBe('http://localhost:11434/api/chat');
    if (result.ok) expect(result.value.text).toBe('Local answer');
  });

  it('openrouter reuses the openai protocol with its base url', async () => {
    const http = httpStub(() => ({
      status: 200,
      body: { choices: [{ message: { content: 'x' } }] },
    }));
    await complete(baseRequest('openrouter'), {
      http,
      keyResolver: keyResolverFromMap({ openrouter: 'sk-or-abc12345' }),
    });
    expect(http.calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
});

describe('complete — key enforcement', () => {
  it('fails with PROVIDER_AUTH before any network call when the key is missing', async () => {
    const http = httpStub(() => ({ status: 200, body: {} }));
    const result = await complete(baseRequest('openai'), {
      http,
      keyResolver: keyResolverFromMap({}),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_AUTH');
    expect(http.calls).toHaveLength(0);
  });

  it('does not require a key for ollama', async () => {
    const http = httpStub(() => ({ status: 200, body: { message: { content: 'ok' } } }));
    const result = await complete(baseRequest('ollama'), {
      http,
      keyResolver: keyResolverFromMap({}),
    });
    expect(result.ok).toBe(true);
  });

  it('fails with PROVIDER_UNSUPPORTED for an unknown provider id', async () => {
    const http = httpStub(() => ({ status: 200, body: {} }));
    const result = await complete(
      { ...baseRequest('openai'), model: spec('made-up' as ProviderId) },
      { http, keyResolver: keyResolverFromMap({}) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('PROVIDER_UNSUPPORTED');
  });
});

describe('complete — error mapping', () => {
  const keyResolver = keyResolverFromMap({ openai: 'sk-test-12345678' });

  it.each([
    [401, 'PROVIDER_AUTH'],
    [402, 'PROVIDER_QUOTA'],
    [403, 'PROVIDER_AUTH'],
    [422, 'INVALID_INPUT'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_BAD_RESPONSE'],
    [503, 'PROVIDER_BAD_RESPONSE'],
  ] as const)('maps HTTP %i to %s', async (status, expectedCode) => {
    const http = httpStub(() => ({ status, body: { error: { message: 'nope' } } }));
    const result = await complete(baseRequest('openai'), { http, keyResolver });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(expectedCode);
      expect(result.error.detail).toContain('nope');
    }
  });

  it('maps retryability consistently', () => {
    expect(mapProviderFailure(429, '').retryable).toBe(true);
    expect(mapProviderFailure(500, '').retryable).toBe(true);
    expect(mapProviderFailure(401, '').retryable).toBe(false);
  });

  it('maps fetch throws to PROVIDER_NETWORK', async () => {
    const http: HttpLike = {
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    };
    const result = await complete(baseRequest('openai'), { http, keyResolver });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_NETWORK');
  });
});

/* ------------------------------------------------------------------ *
 * Key vault
 * ------------------------------------------------------------------ */

function memoryKv(): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
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

describe('KeyVault', () => {
  it('stores and reports presence without leaking values', async () => {
    const vault = new KeyVault(memoryKv());
    const presence = await vault.set('openai', 'sk-secret-value-123');

    expect(presence).toEqual({ openai: true });
    expect(await vault.hasKey('openai')).toBe(true);
    expect(JSON.stringify(await vault.presence())).not.toContain('sk-secret-value-123');
  });

  it('removes a key with null and treats blank as removal', async () => {
    const vault = new KeyVault(memoryKv());
    await vault.set('openai', 'sk-something-1');
    expect((await vault.set('openai', null)).openai).toBeUndefined();
    await vault.set('anthropic', '   ');
    expect(await vault.hasKey('anthropic')).toBe(false);
  });

  it('fails closed on unreadable storage', async () => {
    const failing: KeyValueStore = {
      get: () => Promise.reject(new Error('gone')),
      set: () => Promise.reject(new Error('gone')),
    };
    const vault = new KeyVault(failing);
    expect(await vault.loadAll()).toEqual({});
    expect(await vault.presence()).toEqual({});
  });
});

describe('looksLikePlausibleKey', () => {
  it('rejects short, multiline, and JSON-paste inputs', () => {
    expect(looksLikePlausibleKey('openai', 'short')).toBe(false);
    expect(looksLikePlausibleKey('openai', 'sk-line1\nsk-line2')).toBe(false);
    expect(looksLikePlausibleKey('openai', '{"apiKey": "x"}')).toBe(false);
  });

  it('accepts well-formed keys regardless of provider prefix', () => {
    expect(looksLikePlausibleKey('openai', 'sk-proj-abc1234567890')).toBe(true);
    expect(looksLikePlausibleKey('custom', 'whatever-token-value')).toBe(true);
  });
});
