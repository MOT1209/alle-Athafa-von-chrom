import type { CapturedError, ConfidenceLevel, Evidence, NetworkRequest } from '@/core/types';
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_LABELS,
  SEVERITY_LABELS,
  assessConfidence,
  assessSeverity,
  compareSeverity,
  formatJustification,
  rootCauseConfidence,
} from './severity';

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

const evidence = (strength: Evidence['strength'], id = 'ev1'): Evidence => ({
  id,
  kind: 'console',
  summary: `observed ${strength} signal`,
  strength,
});

describe('assessSeverity', () => {
  const base = { relatedRequests: [] as NetworkRequest[], duplicateCount: 1, fatalCount: 0 };

  it('ranks a console.error below an uncaught exception', () => {
    const logged = assessSeverity({ ...base, error: error({ kind: 'console-error' }) });
    const thrown = assessSeverity({ ...base, error: error({ kind: 'javascript' }) });

    // A console.error is a report; the app kept running.
    expect(compareSeverity(logged.severity, thrown.severity)).toBeGreaterThan(0);
  });

  it('escalates on a programming error class', () => {
    const generic = assessSeverity({
      ...base,
      error: error({ kind: 'javascript', name: 'Error' }),
    });
    const typeError = assessSeverity({
      ...base,
      error: error({ kind: 'javascript', name: 'TypeError' }),
    });

    expect(compareSeverity(typeError.severity, generic.severity)).toBeLessThan(0);
  });

  it('escalates when a correlated request returned 5xx', () => {
    const without = assessSeverity({
      ...base,
      error: error({ kind: 'javascript', name: 'TypeError' }),
    });
    const with5xx = assessSeverity({
      ...base,
      error: error({ kind: 'javascript', name: 'TypeError' }),
      relatedRequests: [
        request({
          id: 'r9',
          outcome: 'server-error',
          statusCode: 503,
          statusText: 'Service Unavailable',
        }),
      ],
    });

    expect(compareSeverity(with5xx.severity, without.severity)).toBeLessThan(0);
  });

  it('escalates on a transport failure', () => {
    const result = assessSeverity({
      ...base,
      error: error({ kind: 'console-error' }),
      relatedRequests: [
        request({
          id: 'r9',
          outcome: 'failed',
          statusCode: undefined,
          errorText: 'net::ERR_FAILED',
        }),
      ],
    });

    expect(['medium', 'high']).toContain(result.severity);
  });

  it('escalates on 401/403', () => {
    const result = assessSeverity({
      ...base,
      error: error({ kind: 'javascript', name: 'TypeError' }),
      relatedRequests: [
        request({ id: 'r9', outcome: 'client-error', statusCode: 401, statusText: 'Unauthorized' }),
      ],
    });

    const signals = result.justification.map((s) => s.signal).join(' | ');
    expect(signals).toContain('401/403');
  });

  it('reaches critical when a TypeError coincides with a 5xx and a broken page', () => {
    const result = assessSeverity({
      error: error({ kind: 'javascript', name: 'TypeError' }),
      relatedRequests: [request({ id: 'r9', outcome: 'server-error', statusCode: 500 })],
      duplicateCount: 1,
      fatalCount: 1,
      pageBroken: true,
    });

    expect(result.severity).toBe('critical');
  });

  it('scales with breadth but with diminishing returns', () => {
    const few = assessSeverity({ ...base, error: error(), duplicateCount: 10 });
    const many = assessSeverity({ ...base, error: error(), duplicateCount: 10_000 });

    // Volume of occurrences must actually move the verdict.
    expect(compareSeverity(many.severity, few.severity)).toBeLessThan(0);

    // But growth is sub-linear: 1000x the occurrences must not buy more than
    // one severity level, or a big table would cry wolf on every page.
    const fewScore = scoreOf(few.justification);
    const manyScore = scoreOf(many.justification);
    expect(manyScore - fewScore).toBeLessThanOrEqual(2.5);
    expect(levelGap(many.severity, few.severity)).toBeLessThanOrEqual(1);
  });

  it('explains every verdict, including the derived score', () => {
    const result = assessSeverity({ ...base, error: error() });

    expect(result.justification.length).toBeGreaterThan(0);
    const derived = result.justification.find((s) => s.signal.startsWith('derived score'));
    expect(derived).toBeDefined();
    expect(derived?.signal).toContain(result.severity);
    expect(derived?.detail).toContain('Thresholds');
  });

  it('labels every severity', () => {
    for (const key of ['critical', 'high', 'medium', 'low', 'info'] as const) {
      expect(SEVERITY_LABELS[key]).toBeTruthy();
    }
  });
});

function scoreOf(signals: readonly { weight: number }[]): number {
  return signals.reduce((sum, s) => sum + s.weight, 0);
}

const LEVELS = ['info', 'low', 'medium', 'high', 'critical'] as const;

function levelGap(higher: (typeof LEVELS)[number], lower: (typeof LEVELS)[number]): number {
  return LEVELS.indexOf(higher) - LEVELS.indexOf(lower);
}

describe('assessConfidence', () => {
  it('refuses to assert anything without evidence', () => {
    const result = assessConfidence({ evidence: [] });

    expect(result.confidence).toBe('unknown');
    expect(result.signals[0]?.signal).toContain('no supporting evidence');
  });

  it('caps confidence when no strong signal is present', () => {
    const weakOnly = assessConfidence({ evidence: [evidence('weak'), evidence('weak', 'ev2')] });
    const withStrong = assessConfidence({
      evidence: [evidence('strong'), evidence('weak', 'ev2')],
    });

    expect(order(weakOnly.confidence)).toBeLessThan(order(withStrong.confidence));
  });

  it('treats a single piece of evidence as insufficient for medium', () => {
    const result = assessConfidence({ evidence: [evidence('strong')] });

    expect(order(result.confidence)).toBeLessThanOrEqual(order('medium'));
  });

  it('rises monotonically with corroborating strong evidence', () => {
    const levels = [1, 2, 3, 4, 5, 9, 12].map((n) =>
      order(
        assessConfidence({
          evidence: Array.from({ length: n }, (_, i) => evidence('strong', `ev${i}`)),
        }).confidence,
      ),
    );

    for (let i = 1; i < levels.length; i++) {
      const previous = levels[i - 1];
      const current = levels[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous === undefined || current === undefined) continue;
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it('never reaches high confidence on repetition of weak signals alone', () => {
    const result = assessConfidence({
      evidence: Array.from({ length: 20 }, (_, i) => evidence('weak', `ev${i}`)),
    });

    expect(result.confidence).not.toBe('high');
  });

  it('is lowered by contradicting evidence', () => {
    const evidence_ = Array.from({ length: 6 }, (_, i) => evidence('strong', `ev${i}`));
    const without = assessConfidence({ evidence: evidence_ });
    const with_ = assessConfidence({
      evidence: evidence_,
      contradictingEvidence: [evidence('strong', 'contra')],
    });

    expect(order(with_.confidence)).toBeLessThan(order(without.confidence));
    expect(with_.signals.some((s) => s.signal === 'contradicting evidence found')).toBe(true);
  });

  it('credits a matched deterministic rule', () => {
    const base = Array.from({ length: 3 }, (_, i) => evidence('strong', `ev${i}`));
    const without = assessConfidence({ evidence: base });
    const withRule = assessConfidence({ evidence: base, ruleIds: ['network/server-error'] });

    expect(order(withRule.confidence)).toBeGreaterThan(order(without.confidence));
  });

  it('notes when a cause came from the model rather than a rule', () => {
    const result = assessConfidence({
      evidence: Array.from({ length: 12 }, (_, i) => evidence('strong', `ev${i}`)),
      modelAsserted: true,
    });

    expect(result.signals.some((s) => s.signal.includes('language model'))).toBe(true);
  });

  it('labels every confidence level', () => {
    for (const key of ['high', 'medium', 'low', 'unknown'] as const) {
      expect(CONFIDENCE_LABELS[key]).toBeTruthy();
    }
  });
});

function order(level: ConfidenceLevel): number {
  return ['unknown', 'low', 'medium', 'high'].indexOf(level);
}

describe('formatJustification', () => {
  it('says so when there is nothing to explain', () => {
    expect(formatJustification([])).toBe('No signals recorded.');
  });

  it('includes the detail of each weighted signal', () => {
    const text = formatJustification([
      { signal: 'error kind: javascript', weight: 3, detail: 'interrupts execution' },
    ]);

    expect(text).toContain('error kind: javascript');
    expect(text).toContain('interrupts execution');
  });
});

describe('rootCauseConfidence', () => {
  it('reads the confidence recorded on the root cause', () => {
    expect(
      rootCauseConfidence({
        category: 'unknown',
        statement: 'no evidence',
        confidence: 'unknown',
        confidenceSignals: [],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        alternatives: [],
        ruleIds: [],
      }),
    ).toBe('unknown');
  });
});
