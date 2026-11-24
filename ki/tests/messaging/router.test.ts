import { describe, expect, it } from 'vitest';
import { createRouter, type Handlers } from '../../src/messaging/router';
import { AppError } from '../../src/core/errors';
import type { RequestEnvelope } from '../../src/messaging/protocol';

function envelope(type: string, payload?: unknown): RequestEnvelope {
  return {
    kind: 'videoking/request',
    id: 'req_1',
    type: type as RequestEnvelope['type'],
    payload: payload as never,
  };
}

function baseHandlers(overrides: Partial<Handlers> = {}): Handlers {
  const handlers: Handlers = {
    'settings/get': () => ({ schemaVersion: 1 }) as never,
    'settings/update': (payload) => payload as never,
    'settings/reset': () => ({}) as never,
    'runtime/status': () => ({}) as never,
    'runtime/testConnection': () => ({ ok: true, latencyMs: 1 }) as never,
    'runtime/testModel': () => ({ taskId: 't1' }),
    'runtime/pullModel': () => ({ taskId: 't2' }),
    'runtime/deleteModel': () => ({ deleted: true }),
    'queue/list': () => [],
    'queue/cancel': () => ({ cancelled: true }),
    'queue/retry': () => ({}) as never,
    'consent/get': () => ({ version: 1, youtubeCaptions: false }),
    'consent/grant': () => ({ version: 1, youtubeCaptions: true }),
    'consent/revoke': () => ({ version: 1, youtubeCaptions: false }),
    'youtube/activeVideo': () => ({ supported: false, reason: 'no-active-tab' }) as never,
    'youtube/capture': () => ({ record: {} }) as never,
    'videos/list': () => [],
    'videos/get': () => ({ record: null }),
    'videos/remove': () => ({ removed: true }),
    'summaries/generate': () => ({ taskId: 't3', deduped: false }),
    'summaries/list': () => [],
    'summaries/get': () => ({ record: null }),
    'summaries/remove': () => ({ removed: true }),
    'chat/ask': () => ({ taskId: 't4', deduped: false }),
    'chat/history': () => ({ record: null }),
    'chat/list': () => [],
    'chat/clear': () => ({ cleared: true }),
    'transcripts/updateSegment': () => ({ record: {} as never, changed: true }),
    'transcripts/search': () => ({ hits: [] }),
    'translations/generate': () => ({ taskId: 't5', deduped: false }),
    'translations/list': () => [],
    'translations/get': () => ({ bundle: null, staleLanguages: [] }),
    'translations/remove': () => ({ removed: true }),
    'learning/generate': () => ({ taskId: 't6', deduped: false }),
    'learning/list': () => [],
    'learning/get': () => ({ record: null }),
    'learning/remove': () => ({ removed: true }),
    'learning/review': () => ({ reviewed: true }),
    ...overrides,
  };
  return handlers;
}

describe('createRouter', () => {
  it('routes a known request and echoes the id', async () => {
    const router = createRouter(baseHandlers());
    const response = await router(envelope('queue/cancel', { taskId: 'x' }));
    expect(response).toEqual({ ok: true, id: 'req_1', data: { cancelled: true } });
  });

  it('awaits async handlers', async () => {
    const router = createRouter(
      baseHandlers({
        'runtime/testConnection': async () => {
          await Promise.resolve();
          return { ok: true, latencyMs: 7 };
        },
      }),
    );
    const response = await router(envelope('runtime/testConnection'));
    expect(response?.ok).toBe(true);
    if (response?.ok) expect(response.data).toEqual({ ok: true, latencyMs: 7 });
  });

  it('serializes AppError failures', async () => {
    const router = createRouter(
      baseHandlers({
        'runtime/deleteModel': () => {
          throw new AppError('MODEL_NOT_FOUND', 'missing', { hint: 'pull it' });
        },
      }),
    );
    const response = await router(envelope('runtime/deleteModel', { model: 'x' }));
    expect(response?.ok).toBe(false);
    if (response && !response.ok) {
      expect(response.error.code).toBe('MODEL_NOT_FOUND');
      expect(response.error.hint).toBe('pull it');
      expect(response.id).toBe('req_1');
    }
  });

  it('wraps unexpected exceptions as INTERNAL', async () => {
    const router = createRouter(
      baseHandlers({
        'queue/list': () => {
          throw new Error('boom');
        },
      }),
    );
    const response = await router(envelope('queue/list'));
    expect(response?.ok).toBe(false);
    if (response && !response.ok) expect(response.error.code).toBe('INTERNAL');
  });

  it('ignores messages that are not videoKING envelopes', async () => {
    const router = createRouter(baseHandlers());
    expect(await router(undefined)).toBeUndefined();
    expect(await router({ kind: 'other' })).toBeUndefined();
    expect(await router('text')).toBeUndefined();
    expect(
      await router({ kind: 'videoking/request', id: 'x', type: 'bogus/type' }),
    ).toBeUndefined();
  });

  it('rejects a valid type with a missing handler as INVALID_INPUT', async () => {
    const partial = { 'queue/list': () => [] } as unknown as Handlers;
    const router = createRouter(partial);
    const response = await router(envelope('queue/cancel', { taskId: 'x' }));
    expect(response?.ok).toBe(false);
    if (response && !response.ok) expect(response.error.code).toBe('INVALID_INPUT');
  });
});
