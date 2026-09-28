/**
 * Smart error grouping (spec sections 26, 27, 28).
 *
 * A page that renders a list of 200 rows and dereferences a missing field in
 * each one produces 200 errors from a single defect. KingDev must present that
 * as **one** issue with 200 occurrences, not 200 issues.
 *
 * Grouping is a two-stage funnel:
 *   1. Collapse by fingerprint — free, exact, and the dominant case.
 *   2. Merge fingerprints that a deterministic rule proves share a cause.
 *
 * Stage 2 is deliberately conservative. Merging two different error types
 * without proof destroys information, and a wrong merge is far more expensive
 * than a missed merge, because the developer then fixes one symptom and the
 * other group reappears. So a merge requires either an identical fingerprint
 * or a rule that fired on *both* groups with the same category.
 */

import type {
  CapturedError,
  ErrorGroup,
  Evidence,
  NetworkRequest,
  RootCause,
  Severity,
  TimelineEvent,
} from '@/core/types';
import { describeLocation } from './fingerprint';
import { evaluateRules, ruleToRootCause } from './rules';
import { assessSeverity, compareSeverity } from './severity';

export interface GroupingOptions {
  readonly relatedRequests?: readonly NetworkRequest[];
  readonly relatedConsole?: readonly { id: string; text: string; level: string }[];
  /** Correlation window: how far before an error a request may have started. */
  readonly correlationWindowMs?: number;
  readonly pageBroken?: boolean;
  /** Maximum groups returned, most severe first. */
  readonly limit?: number;
}

export interface GroupingResult {
  readonly groups: readonly ErrorGroup[];
  /** Total raw error occurrences represented. */
  readonly totalErrors: number;
  /** Number of raw errors that were collapsed away. */
  readonly collapsedErrors: number;
  readonly ungrouped: readonly CapturedError[];
}

const DEFAULT_WINDOW_MS = 5_000;

/* ------------------------------------------------------------------ *
 * Correlation
 * ------------------------------------------------------------------ */

/**
 * Associates an error with the requests that plausibly caused it: a same-origin
 * request that started within the window before the error was thrown.
 *
 * `request.startedAt` is the single source of truth. An earlier draft also
 * accepted a separate start-time map, which was a second source of truth that
 * could silently disagree with the request it described.
 *
 * This is a heuristic and is labelled as one in the UI. A correlation is not
 * proof of causation — it is a defensible ordering of investigation.
 */
export function correlateRequests(
  error: CapturedError,
  requests: readonly NetworkRequest[],
  windowMs = DEFAULT_WINDOW_MS,
): NetworkRequest[] {
  const errorAt = Date.parse(error.timestamp);
  if (Number.isNaN(errorAt)) return [];

  const pageOrigin = safeOrigin(error.pageUrl);

  return requests.filter((request) => {
    const startedMs = Date.parse(request.startedAt);
    if (Number.isNaN(startedMs)) return false;

    const delta = errorAt - startedMs;
    if (delta < 0 || delta > windowMs) return false;

    // Same-origin requests need no extra check. Cross-origin ones are kept only
    // when the error already named them, to avoid pulling in third-party noise.
    const requestOrigin = safeOrigin(request.url);
    return requestOrigin === pageOrigin || error.relatedRequestIds.includes(request.id);
  });
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

interface Bucket {
  readonly fingerprint: string;
  readonly errors: readonly CapturedError[];
}

export function groupErrors(
  errors: readonly CapturedError[],
  options: GroupingOptions = {},
): GroupingResult {
  const {
    relatedRequests = [],
    relatedConsole = [],
    correlationWindowMs = DEFAULT_WINDOW_MS,
    pageBroken = false,
    limit = 100,
  } = options;

  if (errors.length === 0) {
    return { groups: [], totalErrors: 0, collapsedErrors: 0, ungrouped: [] };
  }

  // --- Stage 0: quarantine errors with no usable fingerprint ----------
  // `fingerprint` is a required field on the type, but a malformed capture or
  // history written by an older build can still carry an empty string. Keying
  // the bucket map on it would merge every such error into one meaningless
  // group, and stage 1 runs *before* the rule-confidence guard that protects
  // stage 2. Refusing to group them is the only non-destructive option.
  const groupable: CapturedError[] = [];
  const ungrouped: CapturedError[] = [];
  for (const error of errors) {
    if (error.fingerprint.trim() === '') ungrouped.push(error);
    else groupable.push(error);
  }

  // --- Stage 1: collapse by fingerprint ------------------------------
  // Buckets are rebuilt rather than appended to, so `groupErrors` never
  // mutates anything it was handed.
  const buckets = new Map<string, Bucket>();
  for (const error of groupable) {
    const existing = buckets.get(error.fingerprint);
    buckets.set(error.fingerprint, {
      fingerprint: error.fingerprint,
      errors: existing ? [...existing.errors, error] : [error],
    });
  }

  // --- Stage 2: merge buckets a rule proves share a cause ------------
  const merged = mergeByProvenCause([...buckets.values()], {
    relatedRequests,
    relatedConsole,
    correlationWindowMs,
  });

  // --- Build a group per bucket -------------------------------------
  const groups: ErrorGroup[] = [];

  for (const bucket of merged) {
    const group = buildGroup(bucket, {
      relatedRequests,
      relatedConsole,
      correlationWindowMs,
      pageBroken,
    });
    if (group) groups.push(group);
  }

  groups.sort(
    (a, b) =>
      compareSeverity(a.severity, b.severity) ||
      b.duplicateCount - a.duplicateCount ||
      a.firstSeenAt.localeCompare(b.firstSeenAt),
  );

  // Totals describe the entire capture, not the returned slice: a truncated
  // list is a display decision and must not silently change what the user is
  // told they have. `collapsedErrors` counts occurrences that deduplication
  // absorbed, and therefore excludes anything quarantined in `ungrouped`.
  const ungroupedOccurrences = ungrouped.reduce((sum, e) => sum + e.occurrences, 0);
  const groupedOccurrences = groups.reduce((sum, g) => sum + g.duplicateCount, 0);
  const totalErrors = groupedOccurrences + ungroupedOccurrences;

  return {
    groups: groups.slice(0, limit),
    totalErrors,
    collapsedErrors: Math.max(0, totalErrors - groups.length - ungroupedOccurrences),
    ungrouped,
  };
}

/**
 * Turns one bucket of same-signature errors into a presentable group: rules
 * decide the cause, severity decides the ordering.
 *
 * Split out of `groupErrors` so the pipeline stages stay readable side by side.
 */
function buildGroup(
  bucket: Bucket,
  options: {
    relatedRequests: readonly NetworkRequest[];
    relatedConsole: readonly { id: string; text: string; level: string }[];
    correlationWindowMs: number;
    pageBroken: boolean;
  },
): ErrorGroup | undefined {
  const sorted = [...bucket.errors].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const representative = sorted[0];
  if (!representative) return undefined;

  const correlated = collectCorrelatedRequests(
    sorted,
    options.relatedRequests,
    options.correlationWindowMs,
  );

  const evaluation = evaluateRules({
    error: representative,
    relatedRequests: correlated,
    relatedConsole: options.relatedConsole,
    allErrors: sorted,
  });

  const derived: RootCause | undefined = ruleToRootCause(evaluation);
  const rootCause: RootCause = derived ?? unknownRootCause(representative, correlated);

  const occurrences = sorted.reduce((sum, e) => sum + e.occurrences, 0);
  const fatalCount = sorted.filter(
    (e) => e.kind === 'javascript' || e.kind === 'framework' || e.kind === 'unhandledrejection',
  ).length;

  const { severity, justification } = assessSeverity({
    error: representative,
    relatedRequests: correlated,
    duplicateCount: occurrences,
    fatalCount,
    pageBroken: options.pageBroken,
  });

  return {
    id: `grp_${bucket.fingerprint}`,
    fingerprint: bucket.fingerprint,
    representativeErrorId: representative.id,
    errorIds: sorted.map((e) => e.id),
    duplicateCount: occurrences,
    title: titleFor(representative, occurrences),
    severity,
    severityJustification: justification,
    rootCause,
    firstSeenAt: representative.timestamp,
    lastSeenAt: sorted[sorted.length - 1]?.timestamp ?? representative.timestamp,
    relatedRequestIds: [...new Set(correlated.map((r) => r.id))],
    relatedConsoleIds: [...new Set(representative.relatedConsoleIds)],
  };
}

/**
 * Merges buckets whose best-matching rule produced the same category.
 *
 * Requires the *same* rule id, not merely the same category: a 500 on the
 * orders endpoint and a 500 on the auth endpoint are both `network-failure` by
 * category but are not one bug, and merging them would hide the distinction
 * that matters most when triaging.
 */
function mergeByProvenCause(
  buckets: readonly Bucket[],
  context: {
    relatedRequests: readonly NetworkRequest[];
    relatedConsole: readonly { id: string; text: string; level: string }[];
    correlationWindowMs: number;
  },
): Bucket[] {
  if (buckets.length < 2) return [...buckets];

  /** ruleId -> buckets it fired on. */
  const byRule = new Map<string, Bucket[]>();

  for (const bucket of buckets) {
    const representative = bucket.errors[0];
    if (!representative) continue;

    const evaluation = evaluateRules({
      error: representative,
      relatedRequests: collectCorrelatedRequests(
        bucket.errors,
        context.relatedRequests,
        context.correlationWindowMs,
      ),
      relatedConsole: context.relatedConsole,
      allErrors: bucket.errors,
    });

    const best = evaluation.best;
    // Merging *different* signatures is irreversible: the developer sees one
    // issue, fixes it, and the other signature reappears as an unexplained
    // failure. So stage 2 demands high confidence, not merely "not low".
    if (!best || evaluation.confidence !== 'high') continue;

    const list = byRule.get(best.ruleId);
    if (list) list.push(bucket);
    else byRule.set(best.ruleId, [bucket]);
  }

  // Bucket -> errors, rebuilt rather than mutated. `mergeByProvenCause` takes a
  // readonly array, so writing through `primary.errors.push` would be a
  // contract violation even though the current caller happens to own its
  // buckets: the next caller would inherit a silent, order-dependent bug.
  const merged = new Map<Bucket, readonly CapturedError[]>();
  const claimed = new Set<string>();

  for (const members of byRule.values()) {
    if (members.length < 2) continue;
    // Only merge distinct error signatures; two buckets with the same
    // fingerprint were already collapsed in stage 1.
    const signatures = new Set(members.map((b) => b.fingerprint));
    if (signatures.size < 2) continue;

    const [primary, ...rest] = members;
    if (!primary) continue;

    merged.set(primary, [...primary.errors, ...rest.flatMap((b) => b.errors)]);
    for (const bucket of rest) claimed.add(bucket.fingerprint);
  }

  return buckets
    .filter((b) => !claimed.has(b.fingerprint))
    .map((b) => ({ fingerprint: b.fingerprint, errors: merged.get(b) ?? b.errors }));
}

function collectCorrelatedRequests(
  errors: readonly CapturedError[],
  requests: readonly NetworkRequest[],
  windowMs: number,
): NetworkRequest[] {
  const ids = new Set<string>();
  for (const error of errors) {
    for (const request of correlateRequests(error, requests, windowMs)) {
      ids.add(request.id);
    }
  }
  return requests.filter((r) => ids.has(r.id));
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

function titleFor(error: CapturedError, occurrences: number): string {
  const base = `${error.name}: ${error.message}`.slice(0, 160);
  return occurrences > 1 ? `${base} (${occurrences} occurrences)` : base;
}

function unknownRootCause(error: CapturedError, correlated: readonly NetworkRequest[]): RootCause {
  const evidence: Evidence[] = [
    {
      id: `unknown-obs-${error.id}`,
      kind: 'stack-frame',
      summary: `Observed ${error.name} at ${describeLocation(error)}.`,
      strength: 'moderate',
      sourceId: error.id,
    },
  ];

  if (correlated.length > 0) {
    evidence.push({
      id: `unknown-net-${error.id}`,
      kind: 'network',
      summary: `${correlated.length} request(s) completed within the correlation window, none of which failed.`,
      strength: 'weak',
    });
  }

  return {
    category: 'unknown',
    statement:
      correlated.length > 0
        ? 'No deterministic rule matched and no correlated request failed. The cause cannot be established from the collected evidence alone; it needs the configured AI provider, or a wider evidence source such as a source map.'
        : 'No deterministic rule matched and no correlated requests were observed. The cause cannot be established from the collected evidence alone.',
    confidence: 'unknown',
    confidenceSignals: [
      {
        signal: 'no rule matched and no contradicting request failure',
        weight: 0,
        detail:
          'KingDev reports this as unknown rather than guessing. Enable an AI provider for a model-based analysis.',
      },
    ],
    supportingEvidenceIds: evidence.map((e) => e.id),
    contradictingEvidenceIds: [],
    alternatives: [],
    ruleIds: [],
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ *
 * Timeline (spec section 28)
 * ------------------------------------------------------------------ */

/** Latest parseable timestamp, ignoring malformed entries. */
function latestTimestamp(errors: readonly CapturedError[]): number | undefined {
  let max: number | undefined;
  for (const error of errors) {
    const t = Date.parse(error.timestamp);
    if (!Number.isNaN(t)) max = max === undefined ? t : Math.max(max, t);
  }
  return max;
}

/**
 * Timeline entries for one request: when it started, and how it ended.
 *
 * A request carrying both a duration and a status code produces a response
 * event, even when its recorded outcome is a failure — the status code is the
 * more specific fact, and a server error is still worth showing as one.
 */
function requestTimeline(request: NetworkRequest, startedMs: number): TimelineEvent[] {
  const detail = `${request.method} ${shortUrl(request.url)}`;

  const events: TimelineEvent[] = [
    {
      id: `tl-req-${request.id}`,
      at: request.startedAt,
      kind: 'request-start',
      label: detail,
      refId: request.id,
    },
  ];

  const severity = severityForOutcome(request.outcome);

  if (request.durationMs !== undefined && request.statusCode !== undefined) {
    events.push({
      id: `tl-res-${request.id}`,
      at: new Date(startedMs + request.durationMs).toISOString(),
      kind: 'response',
      label: `${request.statusCode} ${request.statusText ?? ''}`.trim(),
      detail,
      refId: request.id,
      ...(severity ? { severity } : {}),
    });
  } else if (request.outcome === 'failed' || request.outcome === 'aborted') {
    events.push({
      id: `tl-fail-${request.id}`,
      at: new Date(startedMs + (request.durationMs ?? 0)).toISOString(),
      kind: 'request-failed',
      label: request.errorText ?? request.outcome,
      detail,
      refId: request.id,
      severity: request.outcome === 'failed' ? 'high' : 'low',
    });
  }

  return events;
}

/**
 * Builds a causally-ordered timeline. The value of this view is that a 500
 * response at 15:21:03 *preceding* a React render failure at 15:21:03 tells the
 * developer which came first, which the error list alone cannot show.
 */
export function buildTimeline(
  errors: readonly CapturedError[],
  requests: readonly NetworkRequest[],
  windowMs = DEFAULT_WINDOW_MS,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Traffic that began after the last error is from a later interaction and
  // says nothing about these errors. Requests that began *before* the first
  // error are kept: page load and long-polling are legitimate context, and a
  // request that failed thirty seconds after starting can still be the cause.
  const latestError = latestTimestamp(errors);

  for (const request of requests) {
    const startedMs = Date.parse(request.startedAt);
    if (Number.isNaN(startedMs)) continue;
    if (latestError !== undefined && startedMs > latestError + windowMs) continue;

    events.push(...requestTimeline(request, startedMs));
  }

  for (const error of errors) {
    events.push({
      id: `tl-err-${error.id}`,
      at: error.timestamp,
      kind: 'error',
      label: `${error.name}: ${error.message}`.slice(0, 160),
      detail: describeLocation(error),
      refId: error.id,
      severity: error.kind === 'console-error' ? 'medium' : 'high',
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return events;
}

function severityForOutcome(outcome: NetworkRequest['outcome']): Severity | undefined {
  switch (outcome) {
    case 'server-error':
      return 'high';
    case 'client-error':
      return 'medium';
    case 'failed':
      return 'high';
    case 'aborted':
      return 'low';
    default:
      return undefined;
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
}
