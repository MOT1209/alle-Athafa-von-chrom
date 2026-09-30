/**
 * Prompt engine tests — the prompt is built from deterministic evidence only,
 * the binding finding is stated for rule-backed causes, structured parsing
 * rejects malformed model output, and reconciliation marks contradictions.
 */

import {
  buildAnalysisPrompt,
  extractJsonPayload,
  parseAiAnalysis,
  reconcileWithDeterministic,
} from '@/core/prompt/engine';
import type { AiIssueAnalysis, CapturedError, ErrorGroup, RootCause } from '@/core/types';
import { describe, expect, it } from 'vitest';

function capturedError(overrides: Partial<CapturedError> = {}): CapturedError {
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
    occurrences: 3,
    origin: 'content-script',
    relatedConsoleIds: [],
    relatedRequestIds: [],
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
    alternatives: [
      {
        category: 'auth-expired',
        statement: 'The session token expired.',
        likelihood: 'medium',
        discriminatingTest: 'Replay with a fresh token.',
      },
    ],
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
    duplicateCount: 3,
    title: 'TypeError: boom (3 occurrences)',
    severity: 'high',
    severityJustification: [{ signal: 'error kind: javascript', weight: 3 }],
    rootCause: rootCause(),
    firstSeenAt: '2026-09-29T10:00:00.000Z',
    lastSeenAt: '2026-09-29T10:05:00.000Z',
    relatedRequestIds: ['req_1'],
    relatedConsoleIds: [],
    ...overrides,
  };
}

function validModelPayload(): Record<string, unknown> {
  return {
    title: 'Orders API 500 breaks order list',
    summary: 'The page throws while rendering orders after a failed API call.',
    severity: 'high',
    severityReason: 'Uncaught exception on a primary flow.',
    confidence: 'high',
    confidenceReason: 'A deterministic rule backs the cause.',
    rootCause: 'The orders API returns 500.',
    rootCauseCategory: 'network-failure',
    alternatives: [
      {
        statement: 'The client parses the envelope wrongly.',
        likelihood: 'low',
        discriminatingTest: 'Log the raw response body.',
      },
    ],
    fixes: [
      {
        approach: 'recommended',
        title: 'Add server-side error handling',
        whatChanges: 'Return a typed error envelope.',
        whyItWorks: 'The client can then branch instead of throwing.',
        sideEffects: [],
        filesAffected: ['api/orders.ts'],
        risk: 'low',
        diffs: [],
      },
    ],
    unknowns: ['The upstream service name.'],
    referencedEvidenceIds: ['rule-server-req_1'],
  };
}

describe('buildAnalysisPrompt', () => {
  const baseInput = {
    group: group(),
    representative: capturedError(),
    correlatedRequests: [],
    groupErrors: [capturedError(), capturedError({ id: 'err_2' })],
    pageUrl: 'https://app.dev/orders',
    budgetChars: 12_000,
    deterministicUnknown: false,
  };

  it('contains the rule-backed finding as binding', () => {
    const prompt = buildAnalysisPrompt(baseInput);
    expect(prompt.text).toContain('BINDING DETERMINISTIC FINDING');
    expect(prompt.text).toContain('network/server-error');
    expect(prompt.text).toContain('The orders API returned 500.');
  });

  it('injects the classified groupErrors output', () => {
    const prompt = buildAnalysisPrompt(baseInput);
    expect(prompt.text).toContain('grp_fp-1');
    expect(prompt.text).toContain('Occurrences: 2 captured record(s), 6 occurrence(s)');
    expect(prompt.text).toContain('Derived severity: high');
  });

  it('allows hypothesising but marks model-asserted when no rule fired', () => {
    const prompt = buildAnalysisPrompt({
      ...baseInput,
      deterministicUnknown: true,
      group: group({
        rootCause: rootCause({ ruleIds: [], confidence: 'unknown', category: 'unknown' }),
      }),
    });
    expect(prompt.text).toContain('No deterministic rule matched');
    expect(prompt.text).not.toContain('BINDING DETERMINISTIC FINDING');
  });

  it('includes the response schema and the strict JSON instruction', () => {
    const prompt = buildAnalysisPrompt(baseInput);
    expect(prompt.text).toContain('"rootCauseCategory"');
    expect(prompt.text).toContain('No markdown fences');
  });

  it('lists known unknowns explicitly', () => {
    const prompt = buildAnalysisPrompt({
      ...baseInput,
      representative: capturedError({ stack: undefined, frames: [] }),
      correlatedRequests: [],
    });
    expect(prompt.text).toContain('No stack text was captured');
    expect(prompt.text).toContain('No network requests were correlated');
  });

  it('truncates and drops flexible sections, then reports over-budget honestly', () => {
    const bigError = capturedError({
      stack: 'x'.repeat(20_000),
      message: 'm'.repeat(20_000),
    });
    const prompt = buildAnalysisPrompt({
      ...baseInput,
      representative: bigError,
      budgetChars: 2_000,
    });
    // Structural sections alone exceed a 2,000-char budget. The contract must
    // survive intact, so the prompt goes over budget and says so.
    expect(prompt.totalChars).toBeGreaterThan(2_000);
    expect(prompt.text).toContain('BINDING DETERMINISTIC FINDING');
    expect(prompt.text).toContain('No markdown fences');
    expect(prompt.omittedSectionIds.length).toBeGreaterThan(0);
    // The oversized flexible sections were dropped outright; the binding
    // root-cause section is truncated but kept — its leading binding finding
    // survives, while the tiny stack-trace section is legitimately untouched.
    const byId = new Map(prompt.sections.map((s) => [s.id, s]));
    expect(byId.has('error')).toBe(false);
    expect(byId.has('observed-evidence')).toBe(false);
    expect(prompt.omittedSectionIds).toContain('error');
    expect(byId.get('root-cause')?.truncated).toBe(true);
  });

  it('fits within a generous budget without dropping the contract', () => {
    const bigError = capturedError({
      stack: 'x'.repeat(30_000),
      message: 'm'.repeat(30_000),
    });
    const prompt = buildAnalysisPrompt({
      ...baseInput,
      representative: bigError,
      budgetChars: 3_000,
    });
    expect(prompt.text).toContain('BINDING DETERMINISTIC FINDING');
    expect(prompt.text).toContain('No markdown fences');
    expect(prompt.sections.some((s) => s.id === 'role')).toBe(true);
    expect(prompt.sections.some((s) => s.id === 'constraints')).toBe(true);
    expect(prompt.totalChars).toBeLessThanOrEqual(3_600);
  });
});

describe('extractJsonPayload', () => {
  it('parses a bare object', () => {
    expect(extractJsonPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nHope that helps!';
    expect(extractJsonPayload(text)).toEqual({ a: 1 });
  });

  it('returns undefined when no object exists', () => {
    expect(extractJsonPayload('no json here')).toBeUndefined();
  });
});

describe('parseAiAnalysis', () => {
  it('accepts a valid payload', () => {
    const result = parseAiAnalysis(JSON.stringify(validModelPayload()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe('Orders API 500 breaks order list');
      expect(result.value.alternatives).toHaveLength(1);
      expect(result.value.fixes[0]?.diffs).toEqual([]);
    }
  });

  it('accepts fenced payloads', () => {
    const result = parseAiAnalysis(
      `\u0060\u0060\u0060json\n${JSON.stringify(validModelPayload())}\n\u0060\u0060\u0060`,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects non-JSON output with a typed parse error', () => {
    const result = parseAiAnalysis('The error is probably a network issue.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.problems[0]).toContain('no JSON object');
  });

  it('rejects payloads missing required fields', () => {
    const payload = validModelPayload();
    const { rootCause: _removed, ...rest } = payload;
    const result = parseAiAnalysis(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.problems.join(' ')).toContain('rootCause');
  });

  it('rejects out-of-vocabulary enums', () => {
    const payload = { ...validModelPayload(), severity: 'catastrophic' };
    const result = parseAiAnalysis(JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.problems.join(' ')).toContain('severity');
  });

  it('forces empty diffs even when the model tries to smuggle file content', () => {
    const payload = validModelPayload();
    const firstFix = (payload.fixes as { diffs?: unknown }[])[0];
    if (firstFix !== undefined) firstFix.diffs = [{ path: 'x.ts', before: 'a', after: 'b' }];
    const result = parseAiAnalysis(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fixes[0]?.diffs).toEqual([]);
  });
});

describe('reconcileWithDeterministic', () => {
  const baseAnalysis: AiIssueAnalysis = {
    title: 't',
    summary: 's',
    severity: 'high',
    severityReason: 'r',
    confidence: 'high',
    confidenceReason: 'r',
    rootCause: 'The orders API returned 500.',
    rootCauseCategory: 'network-failure',
    alternatives: [],
    fixes: [],
    unknowns: [],
    referencedEvidenceIds: ['rule-server-req_1', 'made-up-evidence'],
  };

  it('accepts an agreeing model answer', () => {
    const result = reconcileWithDeterministic(baseAnalysis, group());
    expect(result.deterministicContradicted).toBe(false);
    expect(result.modelAsserted).toBe(false);
  });

  it('flags a category contradiction instead of adopting the model claim', () => {
    const result = reconcileWithDeterministic(
      { ...baseAnalysis, rootCauseCategory: 'undefined-access' },
      group(),
    );
    expect(result.deterministicContradicted).toBe(true);
    expect(result.contradictionNotes.join(' ')).toContain('network-failure');
    expect(result.contradictionNotes.join(' ')).toContain('network/server-error');
  });

  it('flags a silent confidence demotion as a contradiction', () => {
    const result = reconcileWithDeterministic({ ...baseAnalysis, confidence: 'low' }, group());
    expect(result.deterministicContradicted).toBe(true);
  });

  it('filters evidence ids the prompt never contained', () => {
    const result = reconcileWithDeterministic(baseAnalysis, group());
    expect(result.analysis.referencedEvidenceIds).toEqual(['rule-server-req_1']);
  });

  it('marks the analysis model-asserted when no rule backed the cause', () => {
    const result = reconcileWithDeterministic(
      { ...baseAnalysis, rootCauseCategory: 'race-condition', confidence: 'medium' },
      group({ rootCause: rootCause({ ruleIds: [], confidence: 'unknown', category: 'unknown' }) }),
    );
    expect(result.modelAsserted).toBe(true);
    expect(result.deterministicContradicted).toBe(false);
  });
});
