/**
 * Deterministic root-cause rules.
 *
 * These run entirely offline, with no model involved, and produce a candidate
 * cause with the evidence that triggered it. Their purpose is not to replace
 * the language model but to give it a reproducible prior — and to keep
 * KingDev useful, with honest reasoning, when no provider is configured at all.
 *
 * Every rule must:
 *   - be a pure function of observed evidence,
 *   - attach evidence ids, because a cause without evidence is a guess,
 *   - state a discriminating test, so the user can falsify it.
 *
 * Rules return *candidates*, not conclusions. Selection happens in
 * `grouping.ts` by score, and a group whose best candidate is weak is
 * reported as such rather than dressed up as certain.
 */

import type {
  CapturedError,
  ConfidenceLevel,
  Evidence,
  NetworkRequest,
  RootCause,
  RootCauseCategory,
} from '@/core/types';
import { findApplicationFrame, normalizeMessage } from './fingerprint';

export interface RuleContext {
  readonly error: CapturedError;
  readonly relatedRequests: readonly NetworkRequest[];
  readonly relatedConsole: readonly { id: string; text: string; level: string }[];
  readonly allErrors: readonly CapturedError[];
  readonly documentHtml?: string;
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly category: RootCauseCategory;
  readonly statement: string;
  /** Higher wins. Comparable within and across rules. */
  readonly score: number;
  readonly evidence: readonly Evidence[];
  readonly discriminatingTest: string;
}

type RuleRun = (ctx: RuleContext) => RuleMatch | undefined;

/**
 * A rule is registered with its id, so the engine can report which rule
 * failed. A rule that throws must not take the whole analysis down, but it must
 * never disappear silently either — a silently broken rule looks identical to
 * "no evidence", which is exactly the dishonesty this module exists to avoid.
 */
interface Rule {
  readonly id: string;
  readonly run: RuleRun;
}

const ev = (
  id: string,
  kind: Evidence['kind'],
  summary: string,
  strength: Evidence['strength'],
  sourceId?: string,
  sourceUrl?: string,
): Evidence =>
  sourceId === undefined && sourceUrl === undefined
    ? { id, kind, summary, strength }
    : sourceId === undefined
      ? { id, kind, summary, strength, sourceUrl }
      : { id, kind, summary, strength, sourceId, sourceUrl };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Parses the property that was dereferenced, across engine wordings:
 *   V8:     Cannot read properties of undefined (reading 'userId')
 *   Firefox: userId is undefined
 *   Safari:  undefined is not an object (evaluating 'userId')
 */
export function accessedProperty(message: string): string | undefined {
  const quoted = /(?:reading|in|evaluating)\s+'([^']+)'/.exec(message);
  if (quoted?.[1]) return quoted[1];

  const safari = /undefined is not an object[^']*'([^']+)'/.exec(message);
  if (safari?.[1]) return safari[1];

  // Firefox prefixes the bare property name, unquoted.
  const firefox = /^([A-Za-z_$][\w$]*) is (?:undefined|null)\b/.exec(message.trim());
  return firefox?.[1];
}

const isServerError = (r: NetworkRequest) => r.outcome === 'server-error';
const isTransportFailure = (r: NetworkRequest) => r.outcome === 'failed';
const isAuthError = (r: NetworkRequest) => r.statusCode === 401 || r.statusCode === 403;

function isJsonLike(request: NetworkRequest): boolean {
  const mime = (request.mimeType ?? '').toLowerCase();
  return mime.includes('json') || /\/api\/|\/graphql|\/v\d+\//.test(request.url);
}

/**
 * True when a request is plausibly the data this error came from: same origin
 * as the failing page, or one the error explicitly named.
 *
 * Same-origin rather than same-path on purpose. A component on
 * `app.dev/orders/42` reading `app.dev/api/orders/42` is the single most
 * common real-world shape, and a path-prefix test would discard exactly the
 * evidence that makes `network/bad-shape` detectable.
 */
function requestsLikelyRelated(error: CapturedError, request: NetworkRequest): boolean {
  if (error.relatedRequestIds.includes(request.id)) return true;
  return originOf(request.url) === originOf(error.pageUrl);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

const serverErrorRule: RuleRun = (ctx) => {
  const server = ctx.relatedRequests.filter(isServerError);
  if (server.length === 0) return undefined;
  const first = server[0];
  if (!first) return undefined;

  return {
    ruleId: 'network/server-error',
    category: 'network-failure',
    statement: `The server returned ${first.statusCode ?? '5xx'} for ${describeUrl(first.url)}. The failure originates upstream of the browser, so a client-side patch treats the symptom rather than the cause.`,
    score: 6,
    evidence: server.map((r) =>
      ev(
        `rule-server-${r.id}`,
        'network',
        `${r.method} ${describeUrl(r.url)} → ${r.statusCode ?? 'error'} ${r.statusText ?? ''}`.trim(),
        'strong',
        r.id,
        r.url,
      ),
    ),
    discriminatingTest: `Reproduce the request with the response status visible (Network panel, or curl) and confirm the same ${first.statusCode} status.`,
  };
};

const transportFailureRule: RuleRun = (ctx) => {
  const failed = ctx.relatedRequests.filter(isTransportFailure);
  if (failed.length === 0) return undefined;
  const first = failed[0];
  if (!first) return undefined;

  const corsLikely = /cors|cross-origin|blocked|not allowed/i.test(first.errorText ?? '');

  return {
    ruleId: corsLikely ? 'network/cors' : 'network/transport-failure',
    category: corsLikely ? 'cors' : 'network-failure',
    statement: corsLikely
      ? `The browser blocked ${describeUrl(first.url)} for cross-origin reasons (${first.errorText}). The response may be reaching the network but never reaching the page.`
      : `The request to ${describeUrl(first.url)} never completed (${first.errorText ?? 'no response'}).`,
    score: corsLikely ? 6 : 5.5,
    evidence: failed.map((r) =>
      ev(
        `rule-failed-${r.id}`,
        'network',
        `${r.method} ${describeUrl(r.url)} failed: ${r.errorText ?? 'unknown error'}`,
        'strong',
        r.id,
        r.url,
      ),
    ),
    discriminatingTest: corsLikely
      ? "Open the Network panel and read the browser's CORS reason text; compare the request's Origin header with any Access-Control-Allow-Origin in the response."
      : 'Retry the request in isolation to determine whether the failure is transport-level (DNS, TLS, offline) rather than application-level.',
  };
};

const authRule: RuleRun = (ctx) => {
  const auth = ctx.relatedRequests.filter(isAuthError);
  if (auth.length === 0) return undefined;
  const first = auth[0];
  if (!first) return undefined;

  return {
    ruleId: 'network/auth',
    category: 'auth-expired',
    statement: `The request to ${describeUrl(first.url)} was rejected with ${first.statusCode}. An expired or missing credential is the most common cause; a genuinely insufficient credential cannot be distinguished from browser telemetry alone.`,
    score: 5.5,
    evidence: auth.map((r) =>
      ev(
        `rule-auth-${r.id}`,
        'network',
        `${r.method} ${describeUrl(r.url)} → ${r.statusCode}`,
        'strong',
        r.id,
        r.url,
      ),
    ),
    discriminatingTest:
      'Inspect the Authorization header on the failing request and the token expiry. If the token is absent, check the auth flow; if present and unexpired, check scopes and server-side ownership checks.',
  };
};

const undefinedAccessRule: RuleRun = (ctx) => {
  const { error } = ctx;
  if (!/^TypeError$/.test(error.name)) return undefined;
  if (
    !/Cannot read (properties|of)/.test(error.message) &&
    !/is not iterable/.test(error.message)
  ) {
    return undefined;
  }

  const property = accessedProperty(error.message);
  const frame = findApplicationFrame(error.frames);

  // A JSON response that succeeded just before the throw is strong evidence
  // that the payload shape, not the network, is the problem.
  const relatedJson = ctx.relatedRequests.filter(
    (r) => r.outcome === 'success' && isJsonLike(r) && requestsLikelyRelated(error, r),
  );

  const evidence: Evidence[] = [];
  if (property) {
    evidence.push(
      ev(
        'rule-undef-property',
        'stack-frame',
        `The code dereferenced '${property}' on a value that was ${error.message.includes('undefined') ? 'undefined' : 'null'}.`,
        'strong',
        error.id,
        frame?.url,
      ),
    );
  }
  for (const r of relatedJson) {
    evidence.push(
      ev(
        `rule-undef-json-${r.id}`,
        'network',
        `${describeUrl(r.url)} returned 2xx JSON immediately before the throw, so the payload is present but its shape is unverified.`,
        'moderate',
        r.id,
        r.url,
      ),
    );
  }

  const alsoUndefined = ctx.allErrors.filter(
    (e) => e.fingerprint === error.fingerprint && e.id !== error.id,
  );
  if (alsoUndefined.length > 0) {
    evidence.push(
      ev(
        'rule-undef-repeat',
        'console',
        `The same dereference failed ${alsoUndefined.length + 1} times, which points at a shared data path rather than a one-off race.`,
        'moderate',
      ),
    );
  }

  const score = 4 + (property ? 1 : 0) + (relatedJson.length > 0 ? 1 : 0);

  return {
    ruleId: 'js/undefined-access',
    category: 'undefined-access',
    statement: property
      ? `The value supplying '${property}' is undefined or null at the point of access, so the upstream source (API response, props, or store) did not provide it. The dereference is the symptom; the missing or renamed field is the cause.`
      : 'A value expected to be an object was undefined or null at the point of access. The upstream producer of that value is where the fix belongs.',
    score,
    evidence,
    discriminatingTest: `Log the value immediately before the access in ${frame ? `${frame.functionName} (${frame.url.split('/').pop()}:${frame.lineNumber})` : 'the failing frame'} and confirm whether it is undefined on the first render or only on a re-render.`,
  };
};

const unhandledRejectionRule: RuleRun = (ctx) => {
  if (ctx.error.kind !== 'unhandledrejection') return undefined;
  return {
    ruleId: 'js/unhandled-rejection',
    category: 'unhandled-promise',
    statement:
      'A promise rejected with no catch handler, so the rejection propagated unhandled. The underlying rejection reason is the real failure; the missing handler is what made it visible.',
    score: 4.5,
    evidence: [
      ev(
        'rule-rejection',
        'stack-frame',
        `Unhandled rejection: ${ctx.error.name}: ${ctx.error.message}`,
        'strong',
        ctx.error.id,
      ),
    ],
    discriminatingTest:
      'Await the rejected promise at its source and read the rejection reason, which names the actual failing operation.',
  };
};

const badApiResponseRule: RuleRun = (ctx) => {
  // A 2xx JSON response followed by a TypeError in the consuming component.
  const succeeded = ctx.relatedRequests.filter(
    (r) => r.outcome === 'success' && isJsonLike(r) && requestsLikelyRelated(ctx.error, r),
  );
  if (succeeded.length === 0) return undefined;
  if (!/Cannot read (properties|of)|undefined|is not a function/.test(ctx.error.message)) {
    return undefined;
  }
  const first = succeeded[0];
  if (!first) return undefined;

  return {
    ruleId: 'network/bad-shape',
    category: 'bad-api-response',
    statement: `A 2xx JSON response from ${describeUrl(first.url)} completed normally, yet the consuming code then dereferenced an absent field. The response was accepted on status alone without validating its shape, so a changed or partial payload became an exception downstream.`,
    score: 6.5,
    evidence: [
      ev(
        `rule-shape-${first.id}`,
        'network',
        `${first.method} ${describeUrl(first.url)} → 2xx ${first.mimeType ?? 'json'}`,
        'strong',
        first.id,
        first.url,
      ),
      ev(
        'rule-shape-error',
        'stack-frame',
        `The throw happened after that response: ${normalizeMessage(ctx.error.message)}`,
        'moderate',
        ctx.error.id,
      ),
    ],
    discriminatingTest:
      'Compare the response body against the fields the component reads. Inspect the raw payload for an error envelope returned with a 2xx status, or a field that was renamed.',
  };
};

const configErrorRule: RuleRun = (ctx) => {
  const { error } = ctx;
  if (
    !/(is not defined|process is not defined|importMeta|cannot use import statement|JSON is not defined)/i.test(
      error.message,
    )
  ) {
    return undefined;
  }
  return {
    ruleId: 'build/config',
    category: 'configuration',
    statement:
      'The bundle was built for the wrong target or a build-time define was not supplied, so an environment-specific global is missing at runtime. This is a build configuration problem, not a source-code defect.',
    score: 5,
    evidence: [ev('rule-config', 'stack-frame', error.message, 'strong', error.id)],
    discriminatingTest:
      'Compare the build target in the bundler config against the browserslist query, and confirm every compile-time define has a value for this environment.',
  };
};

const resourceMissingRule: RuleRun = (ctx) => {
  if (ctx.error.kind !== 'resource') return undefined;
  return {
    ruleId: 'resource/missing',
    category: 'resource-missing',
    statement:
      'A subresource the page depends on failed to load, so any code that depended on it ran without it. The originating failure is usually a build-path or hosting problem rather than a source defect.',
    score: 4,
    evidence: [ev('rule-resource', 'console', ctx.error.message, 'strong', ctx.error.id)],
    discriminatingTest:
      'Open the failing URL directly in a new tab to see whether it 404s at the origin or is blocked by a CSP or integrity rule.',
  };
};

const hydrationRule: RuleRun = (ctx) => {
  if (!/hydrat|did not match|server (?:html|rendered)/i.test(ctx.error.message)) return undefined;
  return {
    ruleId: 'framework/hydration',
    category: 'hydration',
    statement:
      'The server-rendered markup did not match the first client render. Usually caused by rendering-dependent-on-time, browser-only APIs, or locale/timezone differences evaluated during SSR.',
    score: 5.5,
    evidence: [ev('rule-hydration', 'stack-frame', ctx.error.message, 'strong', ctx.error.id)],
    discriminatingTest:
      'Reproduce with JavaScript hydration against the server HTML and diff the first client render against the delivered markup, looking for time, locale, or random values.',
  };
};

const cspRule: RuleRun = (ctx) => {
  const cspLogs = ctx.relatedConsole.filter((c) => /content security policy|violat/i.test(c.text));
  if (cspLogs.length === 0) return undefined;
  return {
    ruleId: 'security/csp',
    category: 'configuration',
    statement:
      'A Content-Security-Policy directive blocked a resource or script. A policy change, a new third-party origin, or an inline script introduced after the policy was written will all produce this.',
    score: 5,
    evidence: cspLogs
      .slice(0, 3)
      .map((c) => ev(`rule-csp-${c.id}`, 'console', c.text.slice(0, 200), 'strong', c.id)),
    discriminatingTest:
      "Read the violated directive and the blocked URL in the console message, then confirm the origin against the policy's directive list.",
  };
};

const cspRuleIds = new Set(['security/csp']);

const RULES: readonly Rule[] = [
  { id: 'security/csp', run: cspRule },
  { id: 'network/server-error', run: serverErrorRule },
  { id: 'network/cors', run: transportFailureRule },
  { id: 'network/transport-failure', run: transportFailureRule },
  { id: 'network/auth', run: authRule },
  { id: 'network/bad-shape', run: badApiResponseRule },
  { id: 'js/undefined-access', run: undefinedAccessRule },
  { id: 'framework/hydration', run: hydrationRule },
  { id: 'js/unhandled-rejection', run: unhandledRejectionRule },
  { id: 'build/config', run: configErrorRule },
  { id: 'resource/missing', run: resourceMissingRule },
];

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

export interface RuleEvaluation {
  readonly matches: readonly RuleMatch[];
  /** Best match, or undefined when nothing fired. */
  readonly best?: RuleMatch;
  readonly confidence: ConfidenceLevel;
  readonly confidenceSignals: readonly { signal: string; weight: number; detail?: string }[];
  /**
   * Rules that threw. Always surfaced — never swallowed. A non-empty list means
   * KingDev is reasoning with fewer rules than it thinks it has, and the
   * diagnostics page reports it.
   */
  readonly ruleErrors: readonly { ruleId: string; message: string }[];
}

export function evaluateRules(ctx: RuleContext): RuleEvaluation {
  const matches: RuleMatch[] = [];
  const ruleErrors: { ruleId: string; message: string }[] = [];

  for (const rule of RULES) {
    try {
      const match = rule.run(ctx);
      if (match && match.evidence.length > 0) matches.push(match);
    } catch (cause) {
      ruleErrors.push({
        ruleId: rule.id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];

  if (!best) {
    return {
      matches,
      ruleErrors,
      confidence: 'unknown',
      confidenceSignals: [
        {
          signal: 'no deterministic rule matched',
          weight: 0,
          detail:
            'KingDev has no offline evidence for a cause here. An explanation requires the configured AI provider, and will be reported as speculative.',
        },
      ],
    };
  }

  // A margin between the top two rules matters: two rules at equal score means
  // genuinely competing explanations, and the confidence must reflect that.
  const runnerUp = matches[1];
  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  const strongEvidence = best.evidence.filter((e) => e.strength === 'strong').length;
  const agreement = cspRuleIds.has(best.ruleId) ? 1 : Math.min(1, margin / 2);

  let score = Math.min(1, best.score / 6) * 0.6 + Math.min(1, strongEvidence / 2) * 0.4;
  score *= 0.6 + agreement * 0.4;

  const confidence: ConfidenceLevel = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';

  return {
    matches,
    ruleErrors,
    ...(best ? { best } : {}),
    confidence,
    confidenceSignals: [
      {
        signal: `rule ${best.ruleId} fired with score ${best.score}`,
        weight: 0.6,
        detail: best.statement,
      },
      {
        signal: `${strongEvidence} strong evidence item(s)`,
        weight: 0.4,
      },
      ...(runnerUp
        ? [
            {
              signal: `competing rule ${runnerUp.ruleId} scored ${runnerUp.score}`,
              weight: 0,
              detail: `Margin of ${margin.toFixed(1)}; a narrow margin lowers confidence.`,
            },
          ]
        : []),
    ],
  };
}

/** Converts the winning rule into a `RootCause`. */
export function ruleToRootCause(evaluation: RuleEvaluation): RootCause | undefined {
  const best = evaluation.best;
  if (!best) return undefined;

  return {
    category: best.category,
    statement: best.statement,
    confidence: evaluation.confidence,
    confidenceSignals: evaluation.confidenceSignals,
    supportingEvidenceIds: best.evidence.map((e) => e.id),
    contradictingEvidenceIds: [],
    alternatives: evaluation.matches.slice(1, 4).map((m) => ({
      category: m.category,
      statement: m.statement,
      likelihood: m.score >= best.score * 0.9 ? 'medium' : 'low',
      discriminatingTest: m.discriminatingTest,
    })),
    ruleIds: [best.ruleId],
  };
}

export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return `${parsed.host}${path.length > 1 ? path : '/'}`;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Every rule id KingDev can emit, derived from the registry so it cannot drift
 * out of step with the rules themselves.
 */
export const KNOWN_RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);

/** Rule ids that can ever fire, for the diagnostics page. */
export function registeredRuleCount(): number {
  return RULES.length;
}
