import type { CapturedError, NetworkRequest, TimelineEvent } from '@/core/types';
import { describe, expect, it } from 'vitest';
import { buildTimeline, correlateRequests, groupErrors } from './grouping';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';

const appFrame = (file = 'chunk.js') => ({
  functionName: 'renderRow',
  url: `https://app.dev/assets/${file}`,
  lineNumber: 42,
  columnNumber: 7,
});

const error = (overrides: Partial<CapturedError> = {}): CapturedError => ({
  id: 'e1',
  kind: 'javascript',
  name: 'TypeError',
  message: "Cannot read properties of undefined (reading 'name')",
  frames: [appFrame()],
  timestamp: T0,
  fingerprint: 'fp_a',
  occurrences: 1,
  origin: 'content-script',
  relatedConsoleIds: [],
  relatedRequestIds: [],
  pageUrl: 'https://app.dev/orders',
  pageTitle: 'Orders',
  ...overrides,
});

const request = (overrides: Partial<NetworkRequest> = {}): NetworkRequest => ({
  id: 'r1',
  url: 'https://app.dev/api/orders',
  method: 'GET',
  statusCode: 200,
  statusText: 'OK',
  outcome: 'success',
  mimeType: 'application/json',
  startedAt: T0,
  fromCache: false,
  requestHeaderNames: [],
  responseHeaderNames: [],
  isThirdParty: false,
  ...overrides,
});

/** Builds N errors sharing one fingerprint, as a 200-row table would. */
const repeats = (count: number, base: Partial<CapturedError> = {}): CapturedError[] =>
  Array.from({ length: count }, (_, i) =>
    error({
      id: `e${i + 1}`,
      fingerprint: 'fp_a',
      ...base,
    }),
  );

describe('groupErrors — collapsing duplicates', () => {
  it('turns 200 identical errors into one issue', () => {
    const result = groupErrors(repeats(200));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.duplicateCount).toBe(200);
    expect(result.groups[0]?.errorIds).toHaveLength(200);
  });

  it('reports how many occurrences were collapsed away', () => {
    const result = groupErrors(repeats(200));

    expect(result.totalErrors).toBe(200);
    // 200 raw errors, 1 group: 199 were duplicates, not 200.
    expect(result.collapsedErrors).toBe(199);
  });

  it('sums pre-aggregated occurrence counts', () => {
    const result = groupErrors([
      error({ id: 'e1', fingerprint: 'fp_a', occurrences: 5 }),
      error({ id: 'e2', fingerprint: 'fp_a', occurrences: 3 }),
    ]);

    expect(result.groups[0]?.duplicateCount).toBe(8);
  });

  it('keeps distinct fingerprints apart when nothing proves a shared cause', () => {
    const result = groupErrors([
      error({ id: 'e1', fingerprint: 'fp_a' }),
      error({ id: 'e2', fingerprint: 'fp_b', message: 'totally different failure' }),
    ]);

    expect(result.groups).toHaveLength(2);
  });

  it('returns nothing for no errors', () => {
    const result = groupErrors([]);

    expect(result.groups).toEqual([]);
    expect(result.totalErrors).toBe(0);
  });

  it('does not mutate the errors it was given', () => {
    const input = [error({ id: 'e1' }), error({ id: 'e2' })];

    groupErrors(input);

    expect(input[0]?.id).toBe('e1');
    expect(input).toHaveLength(2);
  });

  it('reports totals for the whole capture even when the list is truncated', () => {
    const errors = [
      error({ id: 'e1', fingerprint: 'fp_a', message: 'boom a', frames: [appFrame('a.js')] }),
      error({ id: 'e2', fingerprint: 'fp_b', message: 'boom b', frames: [appFrame('b.js')] }),
      error({ id: 'e3', fingerprint: 'fp_c', message: 'boom c', frames: [appFrame('c.js')] }),
    ];

    const full = groupErrors(errors);
    const truncated = groupErrors(errors, { limit: 1 });

    expect(full.groups).toHaveLength(3);
    expect(truncated.groups).toHaveLength(1);
    // A display limit must never change what the user is told they have.
    expect(truncated.totalErrors).toBe(full.totalErrors);
    expect(truncated.collapsedErrors).toBe(full.collapsedErrors);
  });

  it('counts a quarantined empty fingerprint as ungrouped instead of merging it', () => {
    // Stage 1 keys on the fingerprint, and an empty string would collapse every
    // such error into one meaningless group before any confidence guard runs.
    const result = groupErrors([
      error({ id: 'e1', fingerprint: '', message: 'unfingerprinted one' }),
      error({ id: 'e2', fingerprint: '', message: 'unfingerprinted two' }),
      error({ id: 'e3', fingerprint: '   ', message: 'blank fingerprint' }),
      error({ id: 'e4', fingerprint: 'fp_a', message: 'normal' }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.ungrouped.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(result.totalErrors).toBe(4);
    // Nothing was collapsed: 3 quarantined + 1 group = 4.
    expect(result.collapsedErrors).toBe(0);
  });

  it('reports ungrouped errors when every error lacks a fingerprint', () => {
    const result = groupErrors([error({ id: 'e1', fingerprint: '' })]);

    expect(result.groups).toEqual([]);
    expect(result.ungrouped).toHaveLength(1);
    expect(result.totalErrors).toBe(1);
    expect(result.collapsedErrors).toBe(0);
  });
});

describe('groupErrors — merging distinct signatures', () => {
  it('merges different signatures when the same high-confidence rule fires on both', () => {
    const result = groupErrors(
      [
        error({
          id: 'e1',
          fingerprint: 'fp_a',
          kind: 'resource',
          message: 'Failed to load resource: 500',
          frames: [appFrame('a.js')],
        }),
        error({
          id: 'e2',
          fingerprint: 'fp_b',
          kind: 'resource',
          message: 'Failed to load resource: 500',
          frames: [appFrame('b.js')],
        }),
      ],
      {
        relatedRequests: [
          request({
            id: 'r1',
            url: 'https://app.dev/api/orders',
            outcome: 'server-error',
            statusCode: 500,
          }),
          request({
            id: 'r2',
            url: 'https://app.dev/api/users',
            outcome: 'server-error',
            statusCode: 500,
          }),
        ],
      },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.errorIds).toEqual(['e1', 'e2']);
  });

  it('refuses to merge on a merely medium-confidence rule', () => {
    // resource/missing fires but only reaches medium confidence, and merging
    // different signatures is irreversible — so these must stay separate.
    const result = groupErrors([
      error({
        id: 'e1',
        fingerprint: 'fp_a',
        kind: 'resource',
        message: '404 a',
        frames: [appFrame('a.js')],
      }),
      error({
        id: 'e2',
        fingerprint: 'fp_b',
        kind: 'resource',
        message: '404 b',
        frames: [appFrame('b.js')],
      }),
    ]);

    expect(result.groups).toHaveLength(2);
  });

  it('does not mutate the bucket it merges into', () => {
    const primary = error({
      id: 'e1',
      fingerprint: 'fp_a',
      kind: 'resource',
      message: 'Failed to load resource: 500',
      frames: [appFrame('a.js')],
    });
    const secondary = error({
      id: 'e2',
      fingerprint: 'fp_b',
      kind: 'resource',
      message: 'Failed to load resource: 500',
      frames: [appFrame('b.js')],
    });

    const result = groupErrors([primary, secondary], {
      relatedRequests: [
        request({
          id: 'r1',
          url: 'https://app.dev/api/orders',
          outcome: 'server-error',
          statusCode: 500,
        }),
        request({
          id: 'r2',
          url: 'https://app.dev/api/users',
          outcome: 'server-error',
          statusCode: 500,
        }),
      ],
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.errorIds).toEqual(['e1', 'e2']);
    // Grouping is a pure read of the caller's errors.
    expect(primary.fingerprint).toBe('fp_a');
    expect(secondary.fingerprint).toBe('fp_b');
  });

  it('never merges errors that no rule matched', () => {
    const result = groupErrors([
      error({ id: 'e1', fingerprint: 'fp_a', message: 'odd thing A' }),
      error({ id: 'e2', fingerprint: 'fp_b', message: 'odd thing B' }),
    ]);

    expect(result.groups).toHaveLength(2);
    for (const group of result.groups) {
      expect(group.rootCause.confidence).toBe('unknown');
    }
  });
});

describe('groupErrors — group content', () => {
  it('records severity together with the reason for it', () => {
    const group = groupErrors(
      [error({ id: 'e1', kind: 'resource', message: '500', frames: [appFrame('a.js')] })],
      {
        relatedRequests: [request({ id: 'r1', outcome: 'server-error', statusCode: 500 })],
      },
    ).groups[0];

    expect(group).toBeDefined();
    expect(group?.severity).toBeTruthy();
    expect(group?.severityJustification.length).toBeGreaterThan(0);
  });

  it('carries the rule that produced the cause', () => {
    const group = groupErrors(
      [error({ id: 'e1', kind: 'resource', message: '500', frames: [appFrame('a.js')] })],
      {
        relatedRequests: [request({ id: 'r1', outcome: 'server-error', statusCode: 500 })],
      },
    ).groups[0];

    expect(group?.rootCause.ruleIds).toContain('network/server-error');
    expect(group?.rootCause.supportingEvidenceIds.length).toBeGreaterThan(0);
  });

  it('reports unknown honestly when no rule applies', () => {
    const group = groupErrors([error({ id: 'e1', message: 'something odd' })]).groups[0];

    expect(group?.rootCause.category).toBe('unknown');
    expect(group?.rootCause.confidence).toBe('unknown');
    expect(group?.rootCause.statement).toContain('cannot be established');
  });

  it('notes the occurrence count in the title', () => {
    const group = groupErrors(repeats(3)).groups[0];

    expect(group?.title).toContain('3 occurrences');
  });

  it('orders the most severe first', () => {
    const result = groupErrors([
      error({
        id: 'low',
        fingerprint: 'fp_low',
        kind: 'console-error',
        name: 'Error',
        message: 'a warning',
      }),
      error({ id: 'crit', fingerprint: 'fp_crit', kind: 'javascript', name: 'TypeError' }),
    ]);

    expect(result.groups[0]?.severity).toBe('high');
    expect(result.groups[1]?.severity).toBe('low');
  });

  it('records the first and last time the error was seen', () => {
    const group = groupErrors([
      error({ id: 'e1', fingerprint: 'fp_a', timestamp: T1 }),
      error({ id: 'e2', fingerprint: 'fp_a', timestamp: T0 }),
    ]).groups[0];

    expect(group?.firstSeenAt).toBe(T0);
    expect(group?.lastSeenAt).toBe(T1);
  });
});

describe('correlateRequests', () => {
  it('correlates a request that started just before the error', () => {
    const correlated = correlateRequests(error({ timestamp: T1 }), [request()]);

    expect(correlated.map((r) => r.id)).toEqual(['r1']);
  });

  it('ignores a request that started after the error', () => {
    const correlated = correlateRequests(error({ timestamp: T0 }), [request({ startedAt: T1 })]);

    expect(correlated).toEqual([]);
  });

  it('ignores a request outside the correlation window', () => {
    const correlated = correlateRequests(
      error({ timestamp: '2026-01-01T00:01:00.000Z' }),
      [request()],
      5_000,
    );

    expect(correlated).toEqual([]);
  });

  it('ignores a third-party request the error never named', () => {
    const correlated = correlateRequests(error({ timestamp: T1 }), [
      request({ id: 'r1', url: 'https://tracker.other.dev/pixel', isThirdParty: true }),
    ]);

    expect(correlated).toEqual([]);
  });

  it('keeps a third-party request the error explicitly named', () => {
    const correlated = correlateRequests(error({ timestamp: T1, relatedRequestIds: ['r1'] }), [
      request({ id: 'r1', url: 'https://api.other.dev/v1', isThirdParty: true }),
    ]);

    expect(correlated.map((r) => r.id)).toEqual(['r1']);
  });

  it('ignores a request with no start time', () => {
    expect(
      correlateRequests(error({ timestamp: T1 }), [request({ startedAt: 'nonsense' })]),
    ).toEqual([]);
  });

  it('tolerates an unparseable timestamp', () => {
    expect(correlateRequests(error({ timestamp: 'nonsense' }), [request()])).toEqual([]);
  });
});

describe('buildTimeline', () => {
  it('orders the response before the error it caused', () => {
    const events = buildTimeline(
      [error({ id: 'e1', timestamp: T1 })],
      [request({ id: 'r1', startedAt: T0, durationMs: 200, statusCode: 200, statusText: 'OK' })],
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('response')).toBeLessThan(kinds.indexOf('error'));
  });

  it('marks a failed request', () => {
    const events = buildTimeline(
      [error({ id: 'e1', timestamp: T1 })],
      [
        request({
          id: 'r1',
          startedAt: T0,
          outcome: 'failed',
          statusCode: undefined,
          errorText: 'net::ERR_FAILED',
        }),
      ],
    );

    const failure = events.find((e) => e.kind === 'request-failed');
    expect(failure?.label).toBe('net::ERR_FAILED');
    expect(failure?.severity).toBe('high');
  });

  it('flags a 5xx response in the timeline', () => {
    const events = buildTimeline(
      [],
      [
        request({
          id: 'r1',
          startedAt: T0,
          durationMs: 10,
          outcome: 'server-error',
          statusCode: 500,
        }),
      ],
    );

    expect(events.find((e) => e.kind === 'response')?.severity).toBe('high');
  });

  it('emits events in chronological order', () => {
    const events: TimelineEvent[] = buildTimeline(
      [error({ id: 'e2', timestamp: T1 }), error({ id: 'e1', timestamp: T0 })],
      [request({ id: 'r1', startedAt: T0, durationMs: 50, statusCode: 200 })],
    );

    const times = events.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('keeps a request that started long before the first error', () => {
    // Page load and long-polling are legitimate context for the diagnosis.
    const events = buildTimeline(
      [error({ id: 'e1', timestamp: '2026-01-01T00:10:00.000Z' })],
      [request({ id: 'r1', startedAt: T0, durationMs: 10, statusCode: 200 })],
    );

    expect(events.map((e) => e.refId)).toContain('r1');
  });

  it('drops a request that started after the last error', () => {
    // Traffic from a later interaction says nothing about these errors.
    const events = buildTimeline(
      [error({ id: 'e1', timestamp: T0 })],
      [
        request({
          id: 'late',
          startedAt: '2026-01-01T00:05:00.000Z',
          durationMs: 10,
          statusCode: 200,
        }),
      ],
    );

    expect(events.map((e) => e.refId)).toEqual(['e1']);
  });

  it('keeps a request that started between two errors', () => {
    const events = buildTimeline(
      [error({ id: 'e1', timestamp: T0 }), error({ id: 'e2', timestamp: T1 })],
      [
        request({
          id: 'mid',
          startedAt: '2026-01-01T00:00:00.500Z',
          durationMs: 10,
          statusCode: 200,
        }),
      ],
    );

    expect(events.map((e) => e.refId)).toContain('mid');
  });

  it('never invents a severity for a healthy response', () => {
    const events = buildTimeline(
      [],
      [request({ id: 'r1', startedAt: T0, durationMs: 10, outcome: 'success', statusCode: 200 })],
    );

    expect(events.find((e) => e.kind === 'response')?.severity).toBeUndefined();
  });
});
