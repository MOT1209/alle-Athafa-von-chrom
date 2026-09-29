/**
 * Issue view tests — the rendering contract: deterministic causes surface
 * with their discriminating tests, model-dependent causes are flagged as such,
 * and nothing invents content between the two.
 */

import { needsModel, toIssueView, toIssueViews } from '@/core/reasoning/issue';
import type { ErrorGroup, RootCause } from '@/core/types';
import { describe, expect, it } from 'vitest';

function rootCause(overrides: Partial<RootCause> = {}): RootCause {
  return {
    category: 'network-failure',
    statement: 'The orders API returned 500.',
    confidence: 'high',
    confidenceSignals: [{ signal: 'matched rule network-5xx', weight: 0.9 }],
    supportingEvidenceIds: ['ev-1'],
    contradictingEvidenceIds: [],
    alternatives: [
      {
        category: 'auth-expired',
        statement: 'The session token expired mid-flight.',
        likelihood: 'medium',
        discriminatingTest: 'Replay the request with a fresh token and compare the status.',
      },
    ],
    ruleIds: ['network-5xx'],
    ...overrides,
  };
}

function group(overrides: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    id: 'grp_abc',
    fingerprint: 'abc:typeerror',
    representativeErrorId: 'err_1',
    errorIds: ['err_1', 'err_2'],
    duplicateCount: 30,
    title: 'TypeError: boom (30 occurrences)',
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

describe('needsModel', () => {
  it('is false when a deterministic rule fired', () => {
    expect(needsModel(group())).toBe(false);
  });

  it('is true when no rule matched and confidence is unknown', () => {
    expect(
      needsModel(
        group({
          rootCause: rootCause({
            ruleIds: [],
            confidence: 'unknown',
            category: 'unknown',
          }),
        }),
      ),
    ).toBe(true);
  });

  it('is false when confidence is unknown but a rule still fired', () => {
    expect(
      needsModel(
        group({ rootCause: rootCause({ ruleIds: ['some-rule'], confidence: 'unknown' }) }),
      ),
    ).toBe(false);
  });
});

describe('toIssueView', () => {
  it('projects the group verbatim — no invented interpretation', () => {
    const view = toIssueView(group());
    expect(view).toMatchObject({
      id: 'grp_abc',
      title: 'TypeError: boom (30 occurrences)',
      severity: 'high',
      occurrences: 30,
      category: 'network-failure',
      statement: 'The orders API returned 500.',
      confidence: 'high',
      ruleIds: ['network-5xx'],
      needsModel: false,
    });
    expect(view.alternatives).toEqual([
      {
        title: 'The session token expired mid-flight.',
        test: 'Replay the request with a fresh token and compare the status.',
      },
    ]);
  });

  it('keeps the discriminating test text exactly as the rule wrote it', () => {
    const view = toIssueView(group());
    expect(view.alternatives[0]?.test).toBe(
      'Replay the request with a fresh token and compare the status.',
    );
  });

  it('round-trips unknown causes as needsModel', () => {
    const view = toIssueView(
      group({ rootCause: rootCause({ ruleIds: [], confidence: 'unknown', alternatives: [] }) }),
    );
    expect(view.needsModel).toBe(true);
    expect(view.alternatives).toEqual([]);
  });
});

describe('toIssueViews', () => {
  it('maps in order without re-sorting — severity order stays the caller’s', () => {
    const views = toIssueViews([
      group({ id: 'g-high', severity: 'high' }),
      group({ id: 'g-low', severity: 'low' }),
    ]);
    expect(views.map((v) => v.id)).toEqual(['g-high', 'g-low']);
  });

  it('returns an empty list for empty groups', () => {
    expect(toIssueViews([])).toEqual([]);
  });
});
