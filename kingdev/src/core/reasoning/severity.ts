/**
 * Severity and confidence assignment.
 *
 * Both are *derived*, never asserted. Every value carries the signals that
 * produced it so the UI can answer "why is this critical?" without guessing
 * (spec section 25 and 30). An unexplained severity is a bug in this file.
 *
 * Severity and confidence are independent axes on purpose: an error can be
 * certainly severe (a hard crash on page load) or certainly uncertain (a
 * speculative cause for a minor warning).
 */

import type {
  CapturedError,
  ConfidenceLevel,
  Evidence,
  Justification,
  NetworkRequest,
  RootCause,
  Severity,
} from '@/core/types';

/* ------------------------------------------------------------------ *
 * Severity
 * ------------------------------------------------------------------ */

export interface SeverityInput {
  readonly error: CapturedError;
  /** Requests that the error is correlated with. */
  readonly relatedRequests: readonly NetworkRequest[];
  /** Total distinct errors sharing this root cause. */
  readonly duplicateCount: number;
  /** How many of them are hard crashes rather than console noise. */
  readonly fatalCount: number;
  /** True when the page failed to reach a usable interactive state. */
  readonly pageBroken?: boolean;
}

const SEVERITY_SCORE: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function scoreToSeverity(score: number): Severity {
  if (score >= 5) return 'critical';
  if (score >= 4) return 'high';
  if (score >= 2.5) return 'medium';
  if (score >= 1.5) return 'low';
  return 'info';
}

/**
 * Computes severity from observable facts only.
 *
 * The base score comes from the error kind and whether it actually throws
 * (an uncaught error stops execution; a `console.error` does not). Correlated
 * failures escalate: a 500 on the endpoint a component is reading is a very
 * different problem from the same TypeError with a healthy network.
 */
export function assessSeverity(input: SeverityInput): {
  severity: Severity;
  justification: readonly Justification[];
} {
  const { error, relatedRequests, duplicateCount, fatalCount } = input;
  const signals: Justification[] = [];
  let score = 0;

  // --- Base severity from the error kind -----------------------------
  if (
    error.kind === 'unhandledrejection' ||
    error.kind === 'network' ||
    error.kind === 'resource'
  ) {
    score += 2.5;
    signals.push({
      signal: `error kind: ${error.kind}`,
      weight: 2.5,
      detail: 'Unhandled rejections, failed requests and missing resources break page behaviour.',
    });
  } else if (error.kind === 'javascript' || error.kind === 'framework') {
    score += 3;
    signals.push({
      signal: `error kind: ${error.kind}`,
      weight: 3,
      detail: 'An uncaught exception interrupts execution at the point of the throw.',
    });
  } else if (error.kind === 'console-error') {
    // A console.error is a *report* of a problem, not a failure itself. The
    // application chose to keep running. Low baseline on purpose.
    score += 1.5;
    signals.push({
      signal: 'reported via console.error only',
      weight: 1.5,
      detail: 'No uncaught exception was observed, so execution was not interrupted.',
    });
  }

  // --- Error class weighting -----------------------------------------
  if (/^(TypeError|ReferenceError|SyntaxError|RangeError)$/.test(error.name)) {
    score += 1;
    signals.push({
      signal: `error class: ${error.name}`,
      weight: 1,
      detail: 'A programming error rather than an expected, handled condition.',
    });
  }

  // --- Correlated request failures -----------------------------------
  const failedRequests = relatedRequests.filter(
    (r) => r.outcome === 'server-error' || r.outcome === 'failed' || r.outcome === 'client-error',
  );
  const serverErrors = relatedRequests.filter((r) => r.outcome === 'server-error');

  if (serverErrors.length > 0) {
    score += 1.5;
    signals.push({
      signal: `${serverErrors.length} correlated 5xx response(s)`,
      weight: 1.5,
      detail: serverErrors
        .slice(0, 3)
        .map((r) => `${r.statusCode} ${stripOrigin(r.url)}`)
        .join(', '),
    });
  }
  if (failedRequests.some((r) => r.outcome === 'failed')) {
    score += 1;
    signals.push({
      signal: 'correlated request failed at the transport layer',
      weight: 1,
      detail: 'CORS rejection, DNS failure, offline, or an aborted request.',
    });
  }
  const authFailures = relatedRequests.filter((r) => r.statusCode === 401 || r.statusCode === 403);
  if (authFailures.length > 0) {
    score += 1;
    signals.push({
      signal: `${authFailures.length} correlated 401/403 response(s)`,
      weight: 1,
      detail: 'Authentication or authorisation failed for a request this error depends on.',
    });
  }

  // --- Breadth -------------------------------------------------------
  if (duplicateCount > 1) {
    // Sub-linear (log10) but capped high enough that breadth genuinely changes
    // the verdict: 10 occurrences and 10,000 occurrences are different
    // problems, and the developer needs to see that difference. The cap also
    // stops a 10,000-row table from reporting itself as critical on volume
    // alone — the underlying error class still decides most of the score.
    const breadth = Math.min(2.5, Math.log10(duplicateCount));
    score += breadth;
    signals.push({
      signal: `${duplicateCount} occurrences of one fingerprint`,
      weight: Number(breadth.toFixed(2)),
      detail: 'Repeated failure suggests a shared cause on a widely-used code path.',
    });
  }
  if (fatalCount > 1) {
    score += 0.5;
    signals.push({
      signal: `${fatalCount} uncaught throw(s) in this group`,
      weight: 0.5,
      detail: 'More than one uncaught exception, not merely logged diagnostics.',
    });
  }

  // --- Page impact ---------------------------------------------------
  if (input.pageBroken) {
    score += 1;
    signals.push({
      signal: 'page failed to reach a usable state',
      weight: 1,
      detail: 'The document did not finish loading, or the root element is empty.',
    });
  }

  const severity = scoreToSeverity(score);
  signals.push({
    signal: `derived score ${score.toFixed(2)} → ${severity}`,
    weight: 0,
    detail: 'Thresholds: >=5 critical, >=4 high, >=2.5 medium, >=1.5 low, else info.',
  });

  return { severity, justification: signals };
}

function stripOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.slice(0, 60);
  }
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_SCORE[b] - SEVERITY_SCORE[a];
}

/* ------------------------------------------------------------------ *
 * Confidence
 * ------------------------------------------------------------------ */

const STRENGTH_WEIGHT = {
  strong: 1,
  moderate: 0.6,
  weak: 0.3,
  circumstantial: 0.15,
} as const;

/**
 * Derives a confidence level from the evidence actually collected.
 *
 * A high-confidence claim needs at least one strong signal, and confidence is
 * capped when the analysis rests only on circumstantial evidence. Contradicting
 * evidence always lowers the result — a hypothesis is weakened by a signal
 * pointing elsewhere, not merely unsupported by it.
 */
export function assessConfidence(input: {
  readonly evidence: readonly Evidence[];
  readonly contradictingEvidence?: readonly Evidence[];
  readonly ruleIds?: readonly string[];
  readonly modelAsserted?: boolean;
}): { confidence: ConfidenceLevel; signals: readonly Justification[] } {
  const { evidence, contradictingEvidence = [], ruleIds = [], modelAsserted = false } = input;
  const signals: Justification[] = [];

  if (evidence.length === 0) {
    return {
      confidence: 'unknown',
      signals: [
        {
          signal: 'no supporting evidence collected',
          weight: 0,
          detail: 'KingDev will not assert a cause it has no evidence for.',
        },
      ],
    };
  }

  let score = 0;
  let strong = 0;

  for (const e of evidence) {
    const w = STRENGTH_WEIGHT[e.strength];
    score += w;
    if (e.strength === 'strong') strong++;
  }

  // Diminishing returns: the fifth corroborating weak signal adds far less
  // than the second, otherwise repetition alone would manufacture certainty.
  score = Math.log2(1 + score) / 2;

  // Cap: strong evidence is required for high confidence. The cap sits just
  // below the high threshold so that sheer repetition of weak signals can never
  // reach it — otherwise twenty weak hints would outrank four hard facts.
  if (strong === 0) score = Math.min(score, 1.2);
  if (evidence.length < 2) score = Math.min(score, 0.5);

  // A deterministic rule that fired is itself a strong signal.
  if (ruleIds.length > 0) {
    score += Math.min(0.8, ruleIds.length * 0.4);
    signals.push({
      signal: `${ruleIds.length} deterministic rule(s) matched: ${ruleIds.slice(0, 4).join(', ')}`,
      weight: Math.min(0.8, ruleIds.length * 0.4),
      detail: 'Rule matches are reproducible, unlike a free-form model inference.',
    });
  }

  for (const e of contradictingEvidence) {
    score -= STRENGTH_WEIGHT[e.strength] * 0.8;
    signals.push({
      signal: 'contradicting evidence found',
      weight: -STRENGTH_WEIGHT[e.strength] * 0.8,
      detail: e.summary,
    });
  }

  if (modelAsserted) {
    signals.push({
      signal: 'cause asserted by the language model',
      weight: 0,
      detail:
        'Model reasoning is not independently reproducible in KingDev, so it never reaches high confidence on its own.',
    });
  }

  signals.push({
    signal: `${evidence.length} supporting signal(s), ${strong} strong`,
    weight: 0,
    detail: `Evidence-weighted score ${score.toFixed(2)}.`,
  });

  return { confidence: scoreToConfidence(score), signals };
}

/**
 * Calibrated against the evidence-weight scale: one strong signal lands on
 * `low`, two corroborating signals reach `medium`, and `high` requires either
 * repeated strong evidence or a deterministic rule on top of it.
 */
function scoreToConfidence(score: number): ConfidenceLevel {
  if (score >= 1.25) return 'high';
  if (score >= 0.6) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
};

/** Renders the justification list as the "why" string shown under a badge. */
export function formatJustification(signals: readonly Justification[]): string {
  if (signals.length === 0) return 'No signals recorded.';
  return signals
    .filter((s) => s.weight !== 0 || s.signal.includes('derived'))
    .map((s) => (s.detail ? `${s.signal} — ${s.detail}` : s.signal))
    .join('\n');
}

/**
 * Confidence of a root cause is the weaker of the derived confidence and any
 * cap already applied to it, so a single function serves the UI.
 */
export function rootCauseConfidence(rootCause: RootCause): ConfidenceLevel {
  return rootCause.confidence;
}
