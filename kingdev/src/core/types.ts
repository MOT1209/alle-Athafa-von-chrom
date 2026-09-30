/**
 * KingDev — domain type contracts.
 *
 * Every type in this file is shared across the extension runtime (service
 * worker, content script, devtools panel) and is therefore structured-clone
 * safe: no classes, no functions, no `undefined`-valued optional keys that
 * would be dropped silently by structured clone.
 */

export type ISODateString = string;

/* ------------------------------------------------------------------ *
 * Result type
 * ------------------------------------------------------------------ */

export type Result<T, E = KingDevError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

export function mapResult<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T, KingDevError>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(toKingDevError(cause, 'UNKNOWN'));
  }
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type ErrorCode =
  | 'UNKNOWN'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_QUOTA'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_BAD_RESPONSE'
  | 'PROVIDER_UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'CONSENT_REQUIRED'
  | 'STORAGE_FAILURE'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'INTERNAL';

export interface KingDevError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Operator-facing detail. Redacted before persistence, never sent to a provider. */
  readonly detail?: string;
  readonly retryable: boolean;
  readonly cause?: string;
}

export function kingDevError(
  code: ErrorCode,
  message: string,
  extra: { detail?: string; retryable?: boolean; cause?: unknown } = {},
): KingDevError {
  const out: { -readonly [K in keyof KingDevError]: KingDevError[K] } = {
    code,
    message,
    retryable: extra.retryable ?? false,
  };
  if (extra.detail !== undefined) out.detail = extra.detail;
  if (extra.cause !== undefined) out.cause = describeUnknown(extra.cause);
  return out;
}

export function toKingDevError(cause: unknown, fallback: ErrorCode = 'INTERNAL'): KingDevError {
  if (isKingDevError(cause)) return cause;
  if (cause instanceof Error) {
    return kingDevError(fallback, cause.message, { cause });
  }
  return kingDevError(fallback, describeUnknown(cause), { cause });
}

export function isKingDevError(value: unknown): value is KingDevError {
  if (typeof value !== 'object' || value === null) return false;
  const c = (value as { code?: unknown }).code;
  const m = (value as { message?: unknown }).message;
  return typeof c === 'string' && typeof m === 'string';
}

export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ *
 * Severity / confidence
 * ------------------------------------------------------------------ */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Ordered most-severe-first. Used for sorting and threshold comparisons. */
export const SEVERITY_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = [
  'high',
  'medium',
  'low',
  'unknown',
] as const;

/** Runtime vocabulary of `ConfidenceLevel` — model output is validated against it. */
export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = CONFIDENCE_ORDER;

/** Runtime vocabulary of `Severity` — model output is validated against it. */
export const SEVERITIES: readonly Severity[] = SEVERITY_ORDER;

/** Why a severity or confidence value was assigned. Never shown without this. */
export interface Justification {
  readonly signal: string;
  readonly weight: number;
  readonly detail?: string;
}

/* ------------------------------------------------------------------ *
 * Browser intelligence — console
 * ------------------------------------------------------------------ */

export type ConsoleLevel = 'log' | 'debug' | 'info' | 'warn' | 'error' | 'trace' | 'dir';

export interface ConsoleEntry {
  readonly id: string;
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly timestamp: ISODateString;
  /** Frame URL the message originated from, when the console reported one. */
  readonly sourceUrl?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  /** `window.onerror` / unhandledrejection payloads carry a first-class error. */
  readonly error?: SerializedError;
  readonly count: number;
}

/* ------------------------------------------------------------------ *
 * Browser intelligence — errors
 * ------------------------------------------------------------------ */

export type CapturedErrorKind =
  | 'javascript'
  | 'unhandledrejection'
  | 'resource'
  | 'network'
  | 'framework'
  | 'console-error';

export interface StackFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly frames: readonly StackFrame[];
}

export interface CapturedError {
  readonly id: string;
  readonly kind: CapturedErrorKind;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly frames: readonly StackFrame[];
  readonly timestamp: ISODateString;
  /** Deterministic identity used for de-duplication and grouping. */
  readonly fingerprint: string;
  /** Number of raw occurrences collapsed into this record. */
  readonly occurrences: number;
  /** Source of the capture, for auditability. */
  readonly origin: 'content-script' | 'devtools' | 'injected';
  readonly relatedConsoleIds: readonly string[];
  readonly relatedRequestIds: readonly string[];
  readonly pageUrl: string;
  readonly pageTitle: string;
}

/* ------------------------------------------------------------------ *
 * Browser intelligence — network
 * ------------------------------------------------------------------ */

export type RequestOutcome =
  | 'success'
  | 'client-error'
  | 'server-error'
  | 'failed'
  | 'aborted'
  | 'cached'
  | 'redirect';

export interface NetworkRequest {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly statusCode?: number;
  readonly statusText?: string;
  readonly outcome: RequestOutcome;
  readonly mimeType?: string;
  readonly resourceType?: string;
  readonly startedAt: ISODateString;
  readonly durationMs?: number;
  readonly totalBytes?: number;
  readonly fromCache: boolean;
  readonly initiator?: string;
  readonly errorText?: string;
  /** Header names only. Header *values* are never captured by default (see SECURITY.md). */
  readonly requestHeaderNames: readonly string[];
  readonly responseHeaderNames: readonly string[];
  readonly isThirdParty: boolean;
}

/* ------------------------------------------------------------------ *
 * Browser intelligence — page / DOM
 * ------------------------------------------------------------------ */

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly capturedAt: ISODateString;
  readonly framework: DetectedFramework;
  readonly documentHtml: string;
  readonly scriptUrls: readonly string[];
  readonly stylesheetUrls: readonly string[];
  readonly metaTags: Readonly<Record<string, string>>;
  readonly lang?: string;
}

export type Framework =
  | 'next.js'
  | 'react'
  | 'vue'
  | 'angular'
  | 'svelte'
  | 'solid'
  | 'remix'
  | 'nuxt'
  | 'astro'
  | 'jquery'
  | 'htmx'
  | 'alpine'
  | 'vanilla'
  | 'unknown';

export interface DetectedFramework {
  readonly primary: Framework;
  readonly evidence: readonly string[];
  readonly confidence: ConfidenceLevel;
  readonly version?: string;
}

export interface ElementSnapshot {
  readonly selector: string;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly textPreview: string;
  readonly outerHtmlPreview: string;
  readonly computedStyles: Readonly<Record<string, string>>;
  readonly box: { x: number; y: number; width: number; height: number };
  readonly classes: readonly string[];
  readonly id?: string;
  readonly frameworkHints: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Reasoning
 * ------------------------------------------------------------------ */

export interface Evidence {
  readonly id: string;
  readonly kind: 'console' | 'network' | 'stack-frame' | 'dom' | 'source-content' | 'doc';
  readonly summary: string;
  readonly strength: 'strong' | 'moderate' | 'weak' | 'circumstantial';
  readonly sourceId?: string;
  readonly sourceUrl?: string;
}

export type RootCauseCategory =
  | 'undefined-access'
  | 'network-failure'
  | 'auth-expired'
  | 'cors'
  | 'bad-api-response'
  | 'type-mismatch'
  | 'missing-dependency'
  | 'syntax-or-bundle'
  | 'hydration'
  | 'race-condition'
  | 'configuration'
  | 'resource-missing'
  | 'unhandled-promise'
  | 'permissions-policy'
  | 'runtime-invariant'
  | 'unknown';

/** Runtime vocabulary of `RootCauseCategory` — model output is validated against it. */
export const ROOT_CAUSE_CATEGORIES: readonly RootCauseCategory[] = [
  'undefined-access',
  'network-failure',
  'auth-expired',
  'cors',
  'bad-api-response',
  'type-mismatch',
  'missing-dependency',
  'syntax-or-bundle',
  'hydration',
  'race-condition',
  'configuration',
  'resource-missing',
  'unhandled-promise',
  'permissions-policy',
  'runtime-invariant',
  'unknown',
] as const;

export interface RootCause {
  readonly category: RootCauseCategory;
  readonly statement: string;
  readonly confidence: ConfidenceLevel;
  readonly confidenceSignals: readonly Justification[];
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds: readonly string[];
  readonly alternatives: readonly Alternative[];
  /** Deterministic rules that fired. Empty means the model asserted this. */
  readonly ruleIds: readonly string[];
}

export interface Alternative {
  readonly category: RootCauseCategory;
  readonly statement: string;
  readonly likelihood: ConfidenceLevel;
  readonly discriminatingTest: string;
}

/**
 * The smart-grouping unit: one root cause with every error it explains.
 * Section 26 of the product spec — 30 errors from one cause render as one issue.
 */
export interface ErrorGroup {
  readonly id: string;
  readonly fingerprint: string;
  readonly representativeErrorId: string;
  readonly errorIds: readonly string[];
  readonly duplicateCount: number;
  readonly title: string;
  readonly severity: Severity;
  readonly severityJustification: readonly Justification[];
  readonly rootCause: RootCause;
  readonly firstSeenAt: ISODateString;
  readonly lastSeenAt: ISODateString;
  readonly relatedRequestIds: readonly string[];
  readonly relatedConsoleIds: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

export type TimelineEventKind =
  | 'request-start'
  | 'response'
  | 'request-failed'
  | 'console'
  | 'error'
  | 'navigation'
  | 'user-action';

export interface TimelineEvent {
  readonly id: string;
  readonly at: ISODateString;
  readonly kind: TimelineEventKind;
  readonly label: string;
  readonly detail?: string;
  readonly refId?: string;
  readonly severity?: Severity;
}

/* ------------------------------------------------------------------ *
 * Fix proposals
 * ------------------------------------------------------------------ */

export type FixApproach = 'quick' | 'safe' | 'recommended' | 'architectural';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

/** Runtime vocabulary of `FixApproach` — model output is validated against it. */
export const FIX_APPROACHES: readonly FixApproach[] = [
  'quick',
  'safe',
  'recommended',
  'architectural',
] as const;

/** Runtime vocabulary of `RiskLevel` — model output is validated against it. */
export const RISK_LEVELS: readonly RiskLevel[] = ['none', 'low', 'medium', 'high'] as const;

export interface CodeDiff {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly languageHint?: string;
}

export interface FixProposal {
  readonly id: string;
  readonly approach: FixApproach;
  readonly title: string;
  readonly whatChanges: string;
  readonly whyItWorks: string;
  readonly sideEffects: readonly string[];
  readonly filesAffected: readonly string[];
  readonly risk: RiskLevel;
  readonly diffs: readonly CodeDiff[];
  /** Populated when the model authored the proposal. */
  readonly confidence: ConfidenceLevel;
  readonly generatedBy: 'rule-engine' | 'model';
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export type AgentId =
  | 'kingagent'
  | 'claude-code'
  | 'opencode'
  | 'codex'
  | 'cursor'
  | 'generic'
  | 'custom';

export interface AgentProfile {
  readonly id: AgentId;
  readonly displayName: string;
  readonly vendor: string;
  readonly persona: string;
  /** Sections the prompt must contain, in order. */
  readonly sections: readonly PromptSectionId[];
  readonly toolUseGuidance: string;
  readonly verificationGuidance: string;
  readonly planningGuidance: string;
  /** CLI flag / invocation hint shown next to the generated prompt. */
  readonly invocationHint: string;
  readonly acceptsJsonOutput: boolean;
}

/* ------------------------------------------------------------------ *
 * Prompt engine
 * ------------------------------------------------------------------ */

export type PromptSectionId =
  | 'role'
  | 'task'
  | 'project-context'
  | 'error'
  | 'stack-trace'
  | 'location'
  | 'observed-evidence'
  | 'root-cause'
  | 'relevant-files'
  | 'recommended-approach'
  | 'requirements'
  | 'constraints'
  | 'test-requirements'
  | 'verification-requirements'
  | 'expected-result'
  | 'reporting-requirements'
  | 'unknowns'
  | 'risk-constraints';

export interface PromptSection {
  readonly id: PromptSectionId;
  readonly title: string;
  readonly body: string;
  readonly charCount: number;
  /** Sections dropped to respect the context budget carry this. */
  readonly truncated: boolean;
  readonly omittedReason?: string;
}

export interface GeneratedPrompt {
  readonly id: string;
  readonly text: string;
  readonly targetAgent: AgentId;
  readonly sections: readonly PromptSection[];
  readonly totalChars: number;
  readonly budgetChars: number;
  readonly omittedSectionIds: readonly PromptSectionId[];
  readonly createdAt: ISODateString;
  readonly contentHash: string;
}

/* ------------------------------------------------------------------ *
 * AI provider layer
 * ------------------------------------------------------------------ */

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'ollama' | 'custom';

export type ModelTier = 'fast' | 'balanced' | 'powerful' | 'local' | 'custom';

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly displayName: string;
  /** `openai-compatible` providers only need baseUrl + apiKey. */
  readonly protocol: 'openai' | 'anthropic' | 'google' | 'ollama';
  readonly defaultBaseUrl: string;
  readonly keyRequired: boolean;
  readonly supportsStreaming: boolean;
  readonly local: boolean;
  readonly docsUrl: string;
}

export interface ModelSpec {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly displayName: string;
  readonly tier: ModelTier;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly notes?: string;
}

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly name?: string;
}

export interface CompletionRequest {
  readonly model: ModelSpec;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  readonly signal?: AbortSignal;
  readonly responseFormat?: 'text' | 'json';
  readonly timeoutMs?: number;
}

export interface CompletionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly modelId: string;
  readonly finishReason: 'stop' | 'length' | 'error';
  readonly usage: CompletionUsage;
  readonly latencyMs: number;
  /** Raw provider payload, retained for the diagnostics page only. */
  readonly raw?: unknown;
}

/* ------------------------------------------------------------------ *
 * AI analysis — model-authored, schema-validated
 * ------------------------------------------------------------------ */

export interface AiIssueAnalysis {
  readonly title: string;
  readonly summary: string;
  readonly severity: Severity;
  readonly severityReason: string;
  readonly confidence: ConfidenceLevel;
  readonly confidenceReason: string;
  readonly rootCause: string;
  readonly rootCauseCategory: RootCauseCategory;
  readonly alternatives: readonly {
    statement: string;
    likelihood: ConfidenceLevel;
    discriminatingTest: string;
  }[];
  readonly fixes: readonly {
    approach: FixApproach;
    title: string;
    whatChanges: string;
    whyItWorks: string;
    sideEffects: readonly string[];
    filesAffected: readonly string[];
    risk: RiskLevel;
    diffs: readonly { path: string; before: string; after: string; languageHint?: string }[];
  }[];
  readonly unknowns: readonly string[];
  readonly referencedEvidenceIds: readonly string[];
}

export interface AiExplanation {
  readonly headline: string;
  readonly body: string;
  readonly keyPoints: readonly string[];
  readonly relatedResources: readonly { label: string; url?: string; note?: string }[];
  readonly confidence: ConfidenceLevel;
}

/* ------------------------------------------------------------------ *
 * Context engine
 * ------------------------------------------------------------------ */

export type ContextSourceId =
  | 'page-content'
  | 'console'
  | 'network'
  | 'dom'
  | 'selected-element'
  | 'selected-code'
  | 'user-prompt'
  | 'previous-analysis'
  | 'project-metadata'
  | 'cookies'
  | 'local-storage'
  | 'session-storage';

export interface ContextSourceDescriptor {
  readonly id: ContextSourceId;
  readonly label: string;
  readonly description: string;
  /** Sources that can carry credentials default to `false`. */
  readonly sensitive: boolean;
  readonly defaultEnabled: boolean;
  /** Whether the source is reachable in the current browser context. */
  readonly availability: 'always' | 'devtools-only' | 'user-selection';
}

/** Serialisable projection of a source, ready to hand to the prompt engine. */
export interface ContextPayload {
  readonly source: ContextSourceId;
  readonly text: string;
  readonly charCount: number;
  readonly enabled: boolean;
  readonly sensitive: boolean;
  readonly redactions: number;
  readonly truncated: boolean;
  readonly unavailableReason?: string;
}

export interface ContextBundle {
  readonly id: string;
  readonly createdAt: ISODateString;
  readonly tabId?: number;
  readonly payloads: readonly ContextPayload[];
  readonly totalChars: number;
  readonly totalRedactions: number;
  readonly skipped: readonly { source: ContextSourceId; reason: string }[];
}

/* ------------------------------------------------------------------ *
 * Session / memory
 * ------------------------------------------------------------------ */

export type SessionOutcome =
  | 'open'
  | 'fix-proposed'
  | 'prompt-generated'
  | 'resolved'
  | 'abandoned';

export interface DebugSession {
  readonly id: string;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly outcome: SessionOutcome;
  readonly groupIds: readonly string[];
  readonly analyses: readonly AiIssueAnalysis[];
  readonly promptIds: readonly string[];
  readonly labels: readonly string[];
  readonly notes: string;
}

/* ------------------------------------------------------------------ *
 * Workflow (spec section 2)
 * ------------------------------------------------------------------ */

export type WorkflowStage =
  | 'observe'
  | 'understand'
  | 'collect-context'
  | 'analyze'
  | 'identify-root-cause'
  | 'plan'
  | 'generate-solution'
  | 'generate-agent-prompt'
  | 'execute-delegate'
  | 'test'
  | 'verify'
  | 'report';

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'observe',
  'understand',
  'collect-context',
  'analyze',
  'identify-root-cause',
  'plan',
  'generate-solution',
  'generate-agent-prompt',
  'execute-delegate',
  'test',
  'verify',
  'report',
] as const;

export interface WorkflowState {
  readonly stage: WorkflowStage;
  readonly startedAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly completedStages: readonly WorkflowStage[];
  readonly findings: readonly string[];
  readonly blockers: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export interface ProviderSettingsEntry {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly modelIds: readonly string[];
  /** True when the key lives only in memory for this browser session. */
  readonly keyIsEphemeral: boolean;
}

export type RoutingPolicy = 'manual' | 'auto';

export interface RoutingRule {
  readonly from:
    | 'simple-explanation'
    | 'debugging'
    | 'large-repository'
    | 'sensitive-data'
    | 'code-generation';
  readonly toTier: ModelTier;
  readonly rationale: string;
  readonly userEditable: boolean;
}

export interface KeyboardShortcut {
  readonly command: string;
  readonly binding: string;
  readonly description: string;
}

export interface Settings {
  readonly version: number;
  readonly activeProviderId: ProviderId;
  readonly activeModelId: string;
  readonly providers: readonly ProviderSettingsEntry[];
  readonly tierModels: Readonly<Record<ModelTier, string>>;
  readonly routing: RoutingPolicy;
  readonly routingRules: readonly RoutingRule[];
  readonly contextDefaults: Readonly<Partial<Record<ContextSourceId, boolean>>>;
  readonly promptBudgetChars: number;
  readonly redactSecrets: boolean;
  readonly redactPii: boolean;
  readonly theme: 'dark' | 'light' | 'system';
  readonly shortcuts: readonly KeyboardShortcut[];
  readonly telemetry: false;
  readonly retainHistory: boolean;
  readonly maxSessions: number;
  readonly autoCapture: boolean;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  activeProviderId: 'openrouter',
  activeModelId: '',
  providers: [],
  tierModels: { fast: '', balanced: '', powerful: '', local: '', custom: '' },
  routing: 'manual',
  routingRules: [
    {
      from: 'simple-explanation',
      toTier: 'fast',
      rationale: 'Low-risk summarisation work does not need a frontier model.',
      userEditable: true,
    },
    {
      from: 'debugging',
      toTier: 'powerful',
      rationale:
        'Root-cause reasoning over heterogeneous evidence benefits from maximum reasoning quality.',
      userEditable: true,
    },
    {
      from: 'large-repository',
      toTier: 'powerful',
      rationale: 'Repository-scale analysis needs the largest available context window.',
      userEditable: true,
    },
    {
      from: 'sensitive-data',
      toTier: 'local',
      rationale: 'Sensitive source and payloads stay on-device.',
      userEditable: true,
    },
    {
      from: 'code-generation',
      toTier: 'balanced',
      rationale: 'Code generation is a middle-of-the-road cost/quality trade-off.',
      userEditable: true,
    },
  ],
  contextDefaults: {
    'page-content': true,
    console: true,
    network: true,
    dom: true,
    'selected-element': true,
    'selected-code': true,
    'user-prompt': true,
    'previous-analysis': true,
    'project-metadata': true,
    cookies: false,
    'local-storage': false,
    'session-storage': false,
  },
  promptBudgetChars: 12_000,
  redactSecrets: true,
  redactPii: true,
  theme: 'dark',
  shortcuts: [
    {
      command: 'command-palette',
      binding: 'Ctrl+Shift+K',
      description: 'Open the KingDev command palette',
    },
    {
      command: 'analyze-page',
      binding: 'Ctrl+Shift+D',
      description: 'Capture and analyse the current page',
    },
    {
      command: 'generate-prompt',
      binding: 'Ctrl+Shift+P',
      description: 'Generate an agent fix prompt',
    },
    {
      command: 'toggle-palette',
      binding: 'Ctrl+Shift+I',
      description: 'Toggle the KingDev element inspector',
    },
  ],
  telemetry: false,
  retainHistory: true,
  maxSessions: 100,
  autoCapture: true,
  requestTimeoutMs: 60_000,
  maxRetries: 2,
};

/* ------------------------------------------------------------------ *
 * Capabilities — honest reporting of what is reachable in this context
 * ------------------------------------------------------------------ */

export type CapabilityId =
  | 'console-capture'
  | 'window-error-capture'
  | 'resource-error-capture'
  | 'network-detail-capture'
  | 'network-body-capture'
  | 'dom-inspection'
  | 'computed-styles'
  | 'storage-access'
  | 'cookies-access'
  | 'source-map-lookup'
  | 'page-content'
  | 'clipboard-write'
  | 'ai-provider-call'
  | 'github-api';

export type CapabilityState = 'available' | 'unavailable' | 'requires-opt-in' | 'not-implemented';

/**
 * Declares, per execution context, what KingDev can actually do right now.
 * The UI renders this verbatim — no capability is ever implied to exist.
 */
export interface CapabilityReport {
  readonly context: 'service-worker' | 'content-script' | 'devtools-panel';
  readonly capabilities: readonly {
    readonly id: CapabilityId;
    readonly state: CapabilityState;
    readonly reason: string;
  }[];
}

/* ------------------------------------------------------------------ *
 * Messaging (service worker <-> panel <-> content)
 * ------------------------------------------------------------------ */

export type PanelToWorkerMessage =
  | { readonly type: 'settings/get' }
  | { readonly type: 'settings/update'; readonly patch: Partial<Settings> }
  | {
      readonly type: 'provider/keys/set';
      readonly providerId: ProviderId;
      readonly key: string | null;
    }
  | { readonly type: 'provider/keys/list' }
  | { readonly type: 'session/save'; readonly session: DebugSession }
  | { readonly type: 'session/list' }
  | { readonly type: 'session/get'; readonly id: string }
  | { readonly type: 'session/delete'; readonly id: string }
  | { readonly type: 'log/write'; readonly entries: readonly LogEntry[] }
  | { readonly type: 'diagnostics/get' }
  /* --- Phase 2: consent + permissions -------------------------------- */
  | { readonly type: 'consent/get' }
  | { readonly type: 'consent/grant'; readonly featureId: string }
  | { readonly type: 'consent/revoke'; readonly featureId: string }
  | { readonly type: 'permissions/status' }
  /* --- Phase 2: capture pipeline ------------------------------------- */
  | { readonly type: 'capture/errors/get' }
  | { readonly type: 'capture/errors/clear' }
  | { readonly type: 'capture/state/get' };

/** Content-script -> worker envelopes (error capture pipeline). */
export type ContentToWorkerMessage =
  | { readonly type: 'kingdev/content-error'; readonly error: CapturedError }
  | { readonly type: 'kingdev/capture-ping' };

export type WorkerToPanelMessage =
  | { readonly type: 'settings/changed'; readonly settings: Settings }
  | { readonly type: 'session/changed' }
  | { readonly type: 'worker/error'; readonly error: KingDevError }
  /* --- Phase 2 --------------------------------------------------------- */
  | {
      readonly type: 'consent/changed';
      readonly consent: import('@/security/permissions').ConsentState;
    }
  | { readonly type: 'capture/updated'; readonly totalErrors: number };

/* --- Phase 2: wire shapes shared between worker and panel ------------- */

/** What the browser currently holds, as the panel sees it. */
export interface PermissionsStatus {
  /** Internal permission ids the browser reports right now (no aiAnalysis). */
  readonly grantedPermissions: readonly string[];
  /** Raw literals from chrome.permissions.getAll(), for the diagnostics page. */
  readonly rawPermissions: readonly string[];
  readonly rawOrigins: readonly string[];
  /** Feature ids whose optional browser grants are fully present. */
  readonly featuresWithGrants: readonly string[];
  /** True when chrome.permissions is reachable in the panel's context. */
  readonly apiAvailable: boolean;
}

/** Replayable capture state exposed by the worker. */
export interface CaptureState {
  readonly totalErrors: number;
  readonly distinctErrors: number;
  readonly lastErrorAt?: ISODateString;
}

export type PanelToContentMessage =
  | { readonly type: 'snapshot/page' }
  | { readonly type: 'snapshot/element' }
  | { readonly type: 'inspector/enable'; readonly enabled: boolean }
  | { readonly type: 'collectors/replay'; readonly entries: readonly unknown[] };

export type ContentToPanelMessage =
  | { readonly type: 'content/ready' }
  | { readonly type: 'content/error'; readonly error: SerializedError }
  | { readonly type: 'content/console'; readonly entry: ConsoleEntry }
  | { readonly type: 'content/resource-error'; readonly url: string; readonly tagName: string }
  | { readonly type: 'content/page'; readonly snapshot: PageSnapshot }
  | { readonly type: 'content/element'; readonly element: ElementSnapshot }
  | { readonly type: 'content/status'; readonly state: 'error' | 'ok'; readonly message: string };

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly timestamp: ISODateString;
  readonly level: LogLevel;
  readonly module: string;
  readonly operation: string;
  readonly status: 'ok' | 'error';
  readonly durationMs?: number;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}
