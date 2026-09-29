/**
 * Issue view transformation (plan Phase 3).
 *
 * `ErrorGroup` is the reasoning layer's output; the panel renders *issues*.
 * This module is the explicit, testable boundary between the two: it decides
 * what is shown, what is marked as needing a model, and never lets a UI
 * component improvise an interpretation the deterministic layer did not make.
 *
 * Every issue carries its `discriminatingTest`s verbatim from the rules — the
 * whole point of the evidence-first contract (plan principle 2) is that a
 * developer can run the test themselves instead of trusting a summary.
 */

import type { ErrorGroup, Severity } from '@/core/types';

export interface IssueFix {
  readonly title: string;
  readonly test: string;
}

export interface IssueView {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly occurrences: number;
  readonly category: string;
  readonly statement: string;
  readonly confidence: string;
  readonly ruleIds: readonly string[];
  /** Alternatives with the test that distinguishes them from the main cause. */
  readonly alternatives: readonly IssueFix[];
  readonly relatedRequestIds: readonly string[];
  readonly needsModel: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** True when the deterministic layer produced no usable cause. */
export function needsModel(group: ErrorGroup): boolean {
  return group.rootCause.ruleIds.length === 0 && group.rootCause.confidence === 'unknown';
}

export function toIssueView(group: ErrorGroup): IssueView {
  return {
    id: group.id,
    title: group.title,
    severity: group.severity,
    occurrences: group.duplicateCount,
    category: group.rootCause.category,
    statement: group.rootCause.statement,
    confidence: group.rootCause.confidence,
    ruleIds: group.rootCause.ruleIds,
    alternatives: group.rootCause.alternatives.map((alt) => ({
      title: alt.statement,
      test: alt.discriminatingTest,
    })),
    relatedRequestIds: [...group.relatedRequestIds],
    needsModel: needsModel(group),
    firstSeenAt: group.firstSeenAt,
    lastSeenAt: group.lastSeenAt,
  };
}

/** Groups -> issue views, worst first (groups arrive severity-sorted). */
export function toIssueViews(groups: readonly ErrorGroup[]): readonly IssueView[] {
  return groups.map(toIssueView);
}
