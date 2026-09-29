/**
 * Unified provider client (plan Phase 3).
 *
 * One entry point — `complete()` — over four wire protocols:
 *   - `openai`   : POST {base}/chat/completions   (also OpenRouter, custom)
 *   - `anthropic`: POST {base}/messages           (x-api-key header)
 *   - `google`   : POST {base}/models/{id}:generateContent (key in query)
 *   - `ollama`   : POST {base}/api/chat           (no key)
 *
 * Error mapping is the contract: every provider failure becomes a
 * `KingDevError` with a stable `ErrorCode` so the UI and the retry policy can
 * branch without parsing provider prose:
 *   401/403 -> PROVIDER_AUTH        429 -> PROVIDER_RATE_LIMIT
 *   402     -> PROVIDER_QUOTA       5xx -> PROVIDER_BAD_RESPONSE (retryable)
 *   fetch throw -> PROVIDER_NETWORK (retryable)   other 4xx -> INVALID_INPUT
 *
 * The key is resolved through an injected `KeyResolver`, never passed in by
 * the caller — call sites cannot accidentally log or persist what they do not
 * hold.
 */

import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type KingDevError,
  type ProviderId,
  type Result,
  err,
  kingDevError,
  ok,
} from '@/core/types';
import { providerById } from './catalog';

/** Returns the key for a provider, or undefined when none is stored. */
export type KeyResolver = (providerId: ProviderId) => Promise<string | undefined>;

export function keyResolverFromMap(keys: Readonly<Record<string, string>>): KeyResolver {
  return async (providerId) => keys[providerId];
}

/* ------------------------------------------------------------------ *
 * Request bodies per protocol
 * ------------------------------------------------------------------ */

interface OpenAiBody {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  max_tokens?: number;
  stop?: readonly string[];
}

function openAiBody(request: CompletionRequest): OpenAiBody {
  const body: OpenAiBody = {
    model: request.model.modelId,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body.stop = request.stopSequences;
  }
  return body;
}

function anthropicBody(request: CompletionRequest): Record<string, unknown> {
  const system = request.messages.find((m) => m.role === 'system')?.content;
  const rest = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    model: request.model.modelId,
    ...(system !== undefined ? { system } : {}),
    messages: rest,
    max_tokens: request.maxOutputTokens ?? 1024,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stopSequences !== undefined && request.stopSequences.length > 0
      ? { stop_sequences: request.stopSequences }
      : {}),
  };
}

function googleBody(request: CompletionRequest): Record<string, unknown> {
  const system = request.messages.find((m) => m.role === 'system')?.content;
  const contents = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  return {
    ...(system !== undefined ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
      ...(request.stopSequences !== undefined && request.stopSequences.length > 0
        ? { stopSequences: request.stopSequences }
        : {}),
    },
  };
}

function ollamaBody(request: CompletionRequest): Record<string, unknown> {
  return {
    model: request.model.modelId,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    options: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Response extraction per protocol
 * ------------------------------------------------------------------ */

function openAiText(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === 'string' ? content : '';
}

function anthropicText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { text?: unknown }).text
        ? String((block as { text: unknown }).text)
        : '',
    )
    .join('');
}

function googleText(payload: Record<string, unknown>): string {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0] as { content?: { parts?: { text?: unknown }[] } };
  const parts = first?.content?.parts ?? [];
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

function ollamaText(payload: Record<string, unknown>): string {
  const message = payload.message as { content?: unknown } | undefined;
  return typeof message?.content === 'string' ? message.content : '';
}

/* ------------------------------------------------------------------ *
 * Error mapping
 * ------------------------------------------------------------------ */

export function mapProviderFailure(status: number, bodyText: string): KingDevError {
  const detail = bodyText.slice(0, 400);
  if (status === 401 || status === 403) {
    return kingDevError('PROVIDER_AUTH', 'The provider rejected the API key.', {
      detail,
      retryable: false,
    });
  }
  if (status === 402) {
    return kingDevError('PROVIDER_QUOTA', 'The provider account is out of credit.', {
      detail,
      retryable: false,
    });
  }
  if (status === 429) {
    return kingDevError('PROVIDER_RATE_LIMIT', 'The provider rate-limited the request.', {
      detail,
      retryable: true,
    });
  }
  if (status >= 500) {
    return kingDevError('PROVIDER_BAD_RESPONSE', 'The provider returned a server error.', {
      detail,
      retryable: true,
    });
  }
  return kingDevError('INVALID_INPUT', 'The provider rejected the request.', {
    detail,
    retryable: false,
  });
}

export function mapNetworkFailure(cause: unknown): KingDevError {
  return kingDevError('PROVIDER_NETWORK', 'Could not reach the provider.', {
    retryable: true,
    cause,
  });
}

/* ------------------------------------------------------------------ *
 * Transport port (injectable for tests)
 * ------------------------------------------------------------------ */

export interface HttpLike {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export const defaultHttp: HttpLike = {
  fetch: (url, init) => fetch(url, init),
};

export interface CompleteDeps {
  readonly http?: HttpLike;
  readonly keyResolver: KeyResolver;
  readonly now?: () => number;
}

export type CompleteResponse = Result<CompletionResult, KingDevError>;

/** Rejects a timed-out fetch via AbortController wired to the timeout. */
async function fetchWithTimeout(
  http: HttpLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await http.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Per-protocol dispatch
 * ------------------------------------------------------------------ */

async function completeOpenAiCompatible(
  request: CompletionRequest,
  base: string,
  key: string | undefined,
  http: HttpLike,
  timeoutMs: number,
): Promise<CompleteResponse> {
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      http,
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(openAiBody(request)),
      },
      timeoutMs,
    );
  } catch (cause) {
    return err(mapNetworkFailure(cause));
  }
  return readStandardResponse(response, openAiText);
}

async function completeAnthropic(
  request: CompletionRequest,
  base: string,
  key: string,
  http: HttpLike,
  timeoutMs: number,
): Promise<CompleteResponse> {
  const url = `${base.replace(/\/$/, '')}/messages`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      http,
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicBody(request)),
      },
      timeoutMs,
    );
  } catch (cause) {
    return err(mapNetworkFailure(cause));
  }
  return readStandardResponse(response, anthropicText);
}

async function completeGoogle(
  request: CompletionRequest,
  base: string,
  key: string,
  http: HttpLike,
  timeoutMs: number,
): Promise<CompleteResponse> {
  const model = encodeURIComponent(request.model.modelId);
  const url = `${base.replace(/\/$/, '')}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      http,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(googleBody(request)),
      },
      timeoutMs,
    );
  } catch (cause) {
    return err(mapNetworkFailure(cause));
  }
  return readStandardResponse(response, googleText);
}

async function completeOllama(
  request: CompletionRequest,
  base: string,
  http: HttpLike,
  timeoutMs: number,
): Promise<CompleteResponse> {
  const url = `${base.replace(/\/$/, '')}/api/chat`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      http,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ollamaBody(request)),
      },
      timeoutMs,
    );
  } catch (cause) {
    return err(mapNetworkFailure(cause));
  }

  if (!response.ok)
    return err(mapProviderFailure(response.status, await response.text().catch(() => '')));

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const text = ollamaText(payload);
  return ok({
    text,
    modelId: request.model.modelId,
    finishReason: 'stop',
    usage: {},
    latencyMs: 0,
  });
}

async function readStandardResponse(
  response: Response,
  extract: (payload: Record<string, unknown>) => string,
): Promise<CompleteResponse> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return err(mapProviderFailure(response.status, body));
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const text = extract(payload);
  const usage = payload.usage as { total_tokens?: unknown } | undefined;
  return ok({
    text,
    modelId: typeof payload.model === 'string' ? payload.model : '',
    finishReason: 'stop',
    usage: {
      ...(typeof usage?.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
    },
    latencyMs: 0,
  });
}

/* ------------------------------------------------------------------ *
 * Public entry
 * ------------------------------------------------------------------ */

/**
 * Runs one completion against the provider implied by `request.model`.
 * Latency is measured here — adapters return text, this function owns timing.
 */
export async function complete(
  request: CompletionRequest,
  deps: CompleteDeps,
): Promise<CompleteResponse> {
  const descriptor = providerById(request.model.providerId);
  if (!descriptor) {
    return err(
      kingDevError('PROVIDER_UNSUPPORTED', `Unknown provider: ${request.model.providerId}`),
    );
  }

  const key = await deps.keyResolver(request.model.providerId);
  if (descriptor.keyRequired && (key === undefined || key === '')) {
    return err(
      kingDevError('PROVIDER_AUTH', `No API key configured for ${descriptor.displayName}.`, {
        detail: 'Add a key in Settings → Providers.',
        retryable: false,
      }),
    );
  }

  const http = deps.http ?? defaultHttp;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = request.timeoutMs ?? 60_000;
  const started = now();

  const base =
    request.model.notes === 'custom-base-url' && descriptor.defaultBaseUrl === ''
      ? descriptor.defaultBaseUrl
      : descriptor.defaultBaseUrl;

  let result: CompleteResponse;
  switch (descriptor.protocol) {
    case 'openai':
      result = await completeOpenAiCompatible(request, base, key, http, timeoutMs);
      break;
    case 'anthropic':
      result = await completeAnthropic(request, base, key ?? '', http, timeoutMs);
      break;
    case 'google':
      result = await completeGoogle(request, base, key ?? '', http, timeoutMs);
      break;
    case 'ollama':
      result = await completeOllama(request, base, http, timeoutMs);
      break;
  }

  if (result.ok) {
    return ok({ ...result.value, latencyMs: now() - started });
  }
  return result;
}

/** Builds a ChatMessage list conveniently for prompt-engine callers. */
export function messages(...list: readonly ChatMessage[]): readonly ChatMessage[] {
  return list;
}
