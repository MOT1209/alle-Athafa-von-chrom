import type { CapturedError, NetworkRequest } from '@/core/types';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_RULE_IDS,
  accessedProperty,
  describeUrl,
  evaluateRules,
  registeredRuleCount,
  ruleToRootCause,
} from './rules';

const error = (overrides: Partial<CapturedError> = {}): CapturedError => ({
  id: 'e1',
  kind: 'console-error',
  name: 'Error',
  message: 'boom',
  frames: [],
  timestamp: '2026-01-01T00:00:00.000Z',
  fingerprint: 'fp1',
  occurrences: 1,
  origin: 'content-script',
  relatedConsoleIds: [],
  relatedRequestIds: [],
  pageUrl: 'https://app.dev/page',
  pageTitle: 'Page',
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
  startedAt: '2026-01-01T00:00:00.000Z',
  fromCache: false,
  requestHeaderNames: [],
  responseHeaderNames: [],
  isThirdParty: false,
  ...overrides,
});

const ctx = (
  errorOverrides: Partial<CapturedError>,
  relatedRequests: NetworkRequest[] = [],
  relatedConsole: { id: string; text: string; level: string }[] = [],
) => ({
  error: error(errorOverrides),
  relatedRequests,
  relatedConsole,
  allErrors: [error(errorOverrides)],
});

describe('accessedProperty', () => {
  it('extracts the property from a V8 TypeError', () => {
    expect(accessedProperty("Cannot read properties of undefined (reading 'userId')")).toBe(
      'userId',
    );
  });

  it('extracts the property from a Firefox TypeError', () => {
    expect(accessedProperty('userId is undefined')).toBe('userId');
  });

  it('returns undefined when there is nothing to extract', () => {
    expect(accessedProperty('some unrelated message')).toBeUndefined();
  });
});

describe('describeUrl', () => {
  it('keeps the host and path but drops the origin noise', () => {
    expect(describeUrl('https://app.dev/api/orders?page=2')).toBe('app.dev/api/orders?page=2');
  });

  it('does not throw on a malformed url', () => {
    expect(describeUrl('not a url')).toBe('not a url');
  });
});

describe('evaluateRules — network rules', () => {
  it('attributes a 500 to the server, not the client', () => {
    const result = evaluateRules(
      ctx({ kind: 'resource', message: 'Failed to load resource: 500' }, [
        request({ outcome: 'server-error', statusCode: 500, statusText: 'Internal Server Error' }),
      ]),
    );

    expect(result.best?.ruleId).toBe('network/server-error');
    expect(result.best?.category).toBe('network-failure');
    expect(result.best?.statement).toContain('500');
  });

  it('separates CORS from a generic transport failure', () => {
    const cors = evaluateRules(
      ctx({ kind: 'network' }, [
        request({
          id: 'r9',
          url: 'https://third.party/api',
          outcome: 'failed',
          errorText: 'Access to fetch has been blocked by CORS policy',
        }),
      ]),
    );
    const generic = evaluateRules(
      ctx({ kind: 'network' }, [
        request({ id: 'r8', outcome: 'failed', errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
      ]),
    );

    expect(cors.best?.ruleId).toBe('network/cors');
    expect(generic.best?.ruleId).toBe('network/transport-failure');
  });

  it('attributes 401/403 to authentication', () => {
    const result = evaluateRules(
      ctx({ kind: 'resource', message: 'Failed to load resource: 401' }, [
        request({ outcome: 'client-error', statusCode: 401, statusText: 'Unauthorized' }),
      ]),
    );

    expect(result.best?.ruleId).toBe('network/auth');
    // Must be honest that telemetry cannot distinguish expired from insufficient.
    expect(result.best?.statement).toContain('most common cause');
  });

  it('flags a 2xx JSON response whose shape the caller assumed', () => {
    const result = evaluateRules(
      ctx(
        {
          kind: 'javascript',
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading 'name')",
        },
        [request({ outcome: 'success', statusCode: 200, mimeType: 'application/json' })],
      ),
    );

    expect(result.best?.ruleId).toBe('network/bad-shape');
    expect(result.best?.statement).toContain('validating its shape');
  });

  it('does not claim a bad shape when the request itself failed', () => {
    const result = evaluateRules(
      ctx(
        {
          kind: 'javascript',
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading 'name')",
        },
        [request({ outcome: 'server-error', statusCode: 500 })],
      ),
    );

    expect(result.matches.map((m) => m.ruleId)).not.toContain('network/bad-shape');
  });
});

describe('evaluateRules — JavaScript rules', () => {
  it('attributes a nullish dereference and names the property', () => {
    const result = evaluateRules(
      ctx({
        kind: 'javascript',
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'userId')",
      }),
    );

    expect(result.best?.ruleId).toBe('js/undefined-access');
    expect(result.best?.statement).toContain("'userId'");
  });

  it('does not fire the dereference rule for a different error class', () => {
    const result = evaluateRules(
      ctx({
        kind: 'javascript',
        name: 'RangeError',
        message: "Cannot read properties of undefined (reading 'x')",
      }),
    );

    expect(result.matches.map((m) => m.ruleId)).not.toContain('js/undefined-access');
  });

  it('attributes an unhandled rejection', () => {
    const result = evaluateRules(
      ctx({ kind: 'unhandledrejection', name: 'Error', message: 'nope' }),
    );

    expect(result.best?.ruleId).toBe('js/unhandled-rejection');
  });

  it('attributes a build target problem to configuration', () => {
    const result = evaluateRules(
      ctx({ kind: 'javascript', name: 'ReferenceError', message: 'process is not defined' }),
    );

    expect(result.best?.ruleId).toBe('build/config');
    expect(result.best?.category).toBe('configuration');
  });

  it('recognises a hydration mismatch', () => {
    const result = evaluateRules(
      ctx({
        kind: 'framework',
        name: 'Error',
        message: 'Hydration failed because the server rendered HTML did not match the client',
      }),
    );

    expect(result.best?.ruleId).toBe('framework/hydration');
  });
});

describe('evaluateRules — policy and resource rules', () => {
  it('attributes a missing subresource', () => {
    const result = evaluateRules(
      ctx({ kind: 'resource', message: 'Failed to load resource: 404' }),
    );

    expect(result.best?.ruleId).toBe('resource/missing');
  });

  it('attributes a CSP violation', () => {
    const result = evaluateRules(
      ctx(
        { kind: 'console-error', message: 'Refused to load the image' },
        [],
        [
          {
            id: 'c1',
            text: "Content Security Policy: Refused to connect to 'https://x.dev'",
            level: 'error',
          },
        ],
      ),
    );

    expect(result.best?.ruleId).toBe('security/csp');
  });
});

describe('evaluateRules — honesty guarantees', () => {
  it('reports unknown rather than guessing when nothing matches', () => {
    const result = evaluateRules(
      ctx({ kind: 'console-error', name: 'Error', message: 'something odd' }),
    );

    expect(result.best).toBeUndefined();
    expect(result.confidence).toBe('unknown');
    expect(result.confidenceSignals[0]?.signal).toContain('no deterministic rule matched');
  });

  it('never emits a match without evidence', () => {
    const result = evaluateRules(
      ctx(
        {
          kind: 'javascript',
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading 'x')",
        },
        [request({ outcome: 'server-error', statusCode: 500 })],
      ),
    );

    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.evidence.length).toBeGreaterThan(0);
    }
  });

  it('always offers a way to falsify the hypothesis', () => {
    const result = evaluateRules(
      ctx({ kind: 'resource', message: 'Failed to load resource: 500' }, [
        request({ outcome: 'server-error', statusCode: 500 }),
      ]),
    );

    for (const match of result.matches) {
      expect(match.discriminatingTest.length).toBeGreaterThan(10);
    }
  });

  it('survives a malformed error without throwing', () => {
    expect(() =>
      evaluateRules(
        ctx({
          kind: 'javascript',
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading '')",
        }),
      ),
    ).not.toThrow();
  });

  it('reports no rule failures on well-formed input', () => {
    // Regression guard: a rule that throws used to be swallowed silently and
    // became indistinguishable from "no evidence". ruleErrors makes it visible.
    const result = evaluateRules(
      ctx(
        { kind: 'resource', message: 'Failed to load resource: 500' },
        [request({ outcome: 'server-error', statusCode: 500 })],
        [{ id: 'c1', text: 'Content Security Policy violation', level: 'error' }],
      ),
    );

    expect(result.ruleErrors).toEqual([]);
  });

  it('lists a competing rule as an alternative', () => {
    const rootCause = ruleToRootCause(
      evaluateRules(
        ctx(
          {
            kind: 'javascript',
            name: 'TypeError',
            message: "Cannot read properties of undefined (reading 'x')",
          },
          [request({ outcome: 'server-error', statusCode: 500 })],
        ),
      ),
    );

    expect(rootCause?.alternatives.length).toBeGreaterThan(0);
    expect(rootCause?.alternatives[0]?.discriminatingTest).toBeTruthy();
  });
});

describe('rule catalogue', () => {
  it('matches the ids the rules actually emit', () => {
    const emitted = new Set(
      [
        evaluateRules(
          ctx({ kind: 'resource', message: 'Failed to load resource: 500' }, [
            request({ outcome: 'server-error', statusCode: 500 }),
          ]),
        ),
        evaluateRules(
          ctx({ kind: 'network' }, [
            request({ id: 'a', outcome: 'failed', errorText: 'blocked by CORS policy' }),
          ]),
        ),
        evaluateRules(
          ctx({ kind: 'network' }, [
            request({ id: 'b', outcome: 'failed', errorText: 'ERR_FAILED' }),
          ]),
        ),
        evaluateRules(
          ctx({ kind: 'resource', message: 'x' }, [
            request({ id: 'c', outcome: 'client-error', statusCode: 403 }),
          ]),
        ),
        evaluateRules(
          ctx(
            {
              kind: 'javascript',
              name: 'TypeError',
              message: "Cannot read properties of undefined (reading 'x')",
            },
            [request({ id: 'd', mimeType: 'application/json' })],
          ),
        ),
        evaluateRules(
          ctx({
            kind: 'javascript',
            name: 'TypeError',
            message: "Cannot read properties of undefined (reading 'x')",
          }),
        ),
        evaluateRules(ctx({ kind: 'framework', message: 'hydration failed' })),
        evaluateRules(ctx({ kind: 'unhandledrejection', message: 'x' })),
        evaluateRules(
          ctx({ kind: 'javascript', name: 'ReferenceError', message: 'process is not defined' }),
        ),
        evaluateRules(ctx({ kind: 'resource', message: '404' })),
        evaluateRules(
          ctx(
            { kind: 'console-error', message: 'x' },
            [],
            [{ id: 'c', text: 'Content Security Policy violation', level: 'error' }],
          ),
        ),
      ].flatMap((r) => r.matches.map((m) => m.ruleId)),
    );

    for (const id of emitted) {
      expect(KNOWN_RULE_IDS).toContain(id);
    }
    expect(emitted.size).toBeGreaterThanOrEqual(10);
  });

  it('derives the catalogue from the registry, so it cannot drift', () => {
    expect(KNOWN_RULE_IDS).toHaveLength(registeredRuleCount());
    expect(new Set(KNOWN_RULE_IDS).size).toBe(KNOWN_RULE_IDS.length);
  });
});
