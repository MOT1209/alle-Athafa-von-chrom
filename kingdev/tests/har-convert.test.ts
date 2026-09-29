/**
 * HAR conversion tests — outcome derivation must be evidence-based, header
 * values must never survive, and malformed entries must be dropped rather
 * than repaired.
 */

import {
  type HarDocument,
  type HarEntry,
  convertEntry,
  convertHar,
  deriveOutcome,
  deriveStartedAt,
} from '@/core/network/har-convert';
import { describe, expect, it } from 'vitest';

let seed = 0;
const nextId = (): string => (++seed).toString(36);

function entry(overrides: Partial<HarEntry> = {}): HarEntry {
  return {
    request: {
      method: 'GET',
      url: 'https://api.example.test/orders',
      headers: [{ name: 'Authorization', value: 'Bearer secret-value' }, { name: 'Accept' }],
    },
    response: {
      status: 200,
      statusText: 'OK',
      content: { size: 120, mimeType: 'application/json' },
      headers: [{ name: 'content-type' }],
    },
    startedDateTime: '2026-09-29T10:00:00.000Z',
    time: 123.6,
    ...overrides,
  };
}

describe('deriveOutcome', () => {
  it('maps status classes to outcomes', () => {
    expect(deriveOutcome(200, false, false)).toBe('success');
    expect(deriveOutcome(302, false, false)).toBe('redirect');
    expect(deriveOutcome(404, false, false)).toBe('client-error');
    expect(deriveOutcome(503, false, false)).toBe('server-error');
  });

  it('treats a cache hit as cached regardless of status', () => {
    expect(deriveOutcome(200, false, true)).toBe('cached');
    expect(deriveOutcome(500, true, true)).toBe('cached');
  });

  it('reports failed when there is no status or a response error', () => {
    expect(deriveOutcome(undefined, false, false)).toBe('failed');
    expect(deriveOutcome(undefined, true, false)).toBe('failed');
  });
});

describe('deriveStartedAt', () => {
  it('normalises a valid startedDateTime to ISO', () => {
    expect(deriveStartedAt({ startedDateTime: '2026-09-29T10:00:00Z' })).toBe(
      '2026-09-29T10:00:00.000Z',
    );
  });

  it('falls back to the epoch sentinel rather than inventing a time', () => {
    expect(deriveStartedAt({})).toBe('1970-01-01T00:00:00.000Z');
    expect(deriveStartedAt({ startedDateTime: 'garbage' })).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('convertEntry', () => {
  it('converts a normal entry to a flat NetworkRequest', () => {
    const request = convertEntry(entry(), nextId);
    expect(request).toMatchObject({
      method: 'GET',
      url: 'https://api.example.test/orders',
      statusCode: 200,
      outcome: 'success',
      mimeType: 'application/json',
      durationMs: 124,
      fromCache: false,
      startedAt: '2026-09-29T10:00:00.000Z',
    });
  });

  it('keeps header NAMES but never values', () => {
    const request = convertEntry(entry(), nextId);
    expect(request?.requestHeaderNames).toHaveLength(2);
    expect(request?.requestHeaderNames).toContain('authorization');
    expect(request?.requestHeaderNames).toContain('accept');
    const serialised = JSON.stringify(request);
    expect(serialised).not.toContain('secret-value');
    expect(serialised).not.toContain('Bearer');
  });

  it('drops entries without url or method instead of repairing them', () => {
    expect(convertEntry({ request: { url: 'https://x' } }, nextId)).toBeUndefined();
    expect(convertEntry({ request: { method: 'GET' } }, nextId)).toBeUndefined();
    expect(convertEntry({}, nextId)).toBeUndefined();
  });

  it('derives failed from response._error even with a 0 status', () => {
    const request = convertEntry(
      entry({ response: { status: 0, _error: 'net::ERR_CONNECTION_REFUSED' } }),
      nextId,
    );
    expect(request?.outcome).toBe('failed');
    expect(request?.statusCode).toBeUndefined();
  });

  it('marks cache hits', () => {
    const request = convertEntry(entry({ cache: { beforeRequest: {} } }), nextId);
    expect(request?.outcome).toBe('cached');
    expect(request?.fromCache).toBe(true);
  });

  it('flags third-party when the initiator origin differs', () => {
    const request = convertEntry(
      entry({ _initiator: { url: 'https://cdn.other.test/lib.js' } }),
      nextId,
    );
    expect(request?.isThirdParty).toBe(true);
  });

  it('uppercases the method', () => {
    const request = convertEntry(
      entry({ request: { method: 'post', url: 'https://x.test/' } }),
      nextId,
    );
    expect(request?.method).toBe('POST');
  });
});

describe('convertHar', () => {
  it('converts entries in order and reports stats', () => {
    const unusable: HarEntry = {}; // no request at all -> dropped
    const har: HarDocument = {
      log: {
        version: '1.2',
        entries: [entry(), entry({ response: { status: 500 } }), unusable],
      },
    };
    const { requests, stats } = convertHar(har);
    expect(requests).toHaveLength(2);
    expect(stats).toEqual({ total: 3, converted: 2, dropped: 1, fromCache: 0 });
  });

  it('handles a missing or malformed log gracefully', () => {
    expect(convertHar({}).requests).toEqual([]);
    expect(convertHar({ log: {} }).stats.total).toBe(0);
    expect(convertHar({ log: { entries: [] } }).requests).toEqual([]);
  });
});
