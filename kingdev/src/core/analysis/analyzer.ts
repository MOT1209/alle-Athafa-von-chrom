/**
 * Issue analyzer (plan Phase 4) — orchestrates one AI analysis of one issue.
 *
 * Order of operations, deliberately rigid:
 *   1. Consent gate first (`aiExplanation`), before any prompt is built and
 *      before any key is read. Nothing about the egress is allowed to start
 *      from a non-consented state.
 *   2. Prompt built only from deterministic evidence (`buildAnalysisPrompt`).
 *   3. One `complete()` call against the active provider/model.
 *   4. Structured parse of the reply (`parseAiAnalysis`) — malformed output is
 *      a typed error, never rendered as a guess.
 *   5. Reconciliation (`reconcileWithDeterministic`) so the model cannot
 *      silently override a rule-backed cause.
 *
 * Runs in the panel context: provider calls are panel-owned per the settled
 * architecture; the worker keeps settings and storage.
 */

import {
  buildAnalysisPrompt,
  parseAiAnalysis,
  reconcileWithDeterministic,
} from '@/core/prompt/engine';
import { type HttpLike, complete } from '@/core/providers/client';
import type { KeyVault } from '@/core/providers/key-vault';
import type {
  AiIssueAnalysis,
  CapturedError,
  ErrorGroup,
  KingDevError,
  ModelSpec,
  NetworkRequest,
  ProviderId,
  Result,
  Settings,
} from '@/core/types';
import { err, kingDevError, ok } from '@/core/types';
import { maskSecretsInString } from '@/security/masking';
import type { ConsentState } from '@/security/permissions';
import { CONSENT_VERSION, evaluateFeatureAccess } from '@/security/permissions';

export const AI_FEATURE_ID = 'aiExplanation';

/**
 * The logical egress permission. It is never granted by the browser (see
 * `LOGICAL_ONLY_PERMISSIONS` in permissions.ts) — it represents the user's
 * explicit consent decision, which is the one thing that may authorise
 * sending error data off-device.
 */
const AI_LOGICAL_PERMISSION = 'aiAnalysis';

/** Model output caps — analysis is short by design, not a report generator. */
const MAX_OUTPUT_TOKENS = 2_000;
const ANALYSIS_TEMPERATURE = 0.2;

export interface AnalyzerPorts {
  /** Resolves the stored key for a provider (panel-side KeyVault). */
  readonly keyVault: Pick<KeyVault, 'loadAll'>;
  /**
   * HTTP transport for the provider call. Defaults to the real `fetch`
   * adapter; injected in tests so no test ever touches the network.
   */
  readonly http?: HttpLike;
  readonly now?: () => number;
}

export interface AnalyzeIssueInput {
  readonly group: ErrorGroup;
  readonly representative: CapturedError;
  readonly groupErrors: readonly CapturedError[];
  readonly correlatedRequests: readonly NetworkRequest[];
  readonly pageUrl: string;
  readonly settings: Settings;
  readonly consent: ConsentState;
  /** Effective browser-granted permissions (from `permissions/status`). */
  readonly grantedPermissions: readonly string[];
  readonly ports: AnalyzerPorts;
}

export interface AnalysisOutcome {
  readonly groupId: string;
  readonly analysis: AiIssueAnalysis;
  readonly promptChars: number;
  readonly modelId: string;
  readonly latencyMs: number;
  readonly deterministicContradicted: boolean;
  readonly contradictionNotes: readonly string[];
  readonly modelAsserted: boolean;
}

/**
 * Builds the `ModelSpec` for a user-typed model id. Providers rotate models
 * faster than extensions ship, so the id is free text validated structurally —
 * never an allowlist.
 */
export function modelSpecFor(
  providerId: ProviderId,
  modelId: string,
): Result<ModelSpec, KingDevError> {
  const trimmed = modelId.trim();
  if (trimmed === '') {
    return err(
      kingDevError('INVALID_INPUT', 'No model id configured.', {
        detail: 'Set a model id under Settings → Providers.',
      }),
    );
  }
  if (trimmed.length > 200 || /[\r\n]/.test(trimmed)) {
    return err(kingDevError('INVALID_INPUT', 'The configured model id is malformed.'));
  }
  return ok({
    providerId,
    modelId: trimmed,
    displayName: trimmed,
    tier: 'custom',
    contextWindow: 128_000,
    supportsTools: false,
    supportsVision: false,
  });
}

/**
 * Consent gate for the logical egress permission.
 *
 * `aiAnalysis` never appears in browser grants, so the gate composes it from
 * the consent decision itself: user consented (current version) + the browser
 * grants the feature actually needs (storage). Anything else is denied —
 * fail-closed per plan principle 3.
 */
export function aiAccessDecision(input: {
  consent: ConsentState;
  grantedPermissions: readonly string[];
}): { allowed: boolean; reason?: string } {
  const granted = new Set<string>(input.grantedPermissions);
  if (
    input.consent.grantedFeatures.includes(AI_FEATURE_ID) &&
    input.consent.version === CONSENT_VERSION
  ) {
    granted.add(AI_LOGICAL_PERMISSION);
  }
  const decision = evaluateFeatureAccess({
    featureId: AI_FEATURE_ID,
    consent: input.consent,
    grantedPermissions: [...granted] as never[],
  });
  return { allowed: decision.allowed, ...(decision.reason ? { reason: decision.reason } : {}) };
}

/**
 * Runs one analysis end to end. Every failure mode returns a typed
 * `KingDevError` — the UI never sees a thrown exception.
 */
export async function analyzeIssue(
  input: AnalyzeIssueInput,
): Promise<Result<AnalysisOutcome, KingDevError>> {
  // --- 1. Consent gate ------------------------------------------------
  const access = aiAccessDecision({
    consent: input.consent,
    grantedPermissions: input.grantedPermissions,
  });
  if (!access.allowed) {
    return err(
      kingDevError('CONSENT_REQUIRED', 'AI analysis is not enabled.', {
        detail: `Enable the "${AI_FEATURE_ID}" feature from Settings first. Error data would be sent to the configured provider.`,
      }),
    );
  }

  // --- 2. Settings sanity ---------------------------------------------
  const providerId = input.settings.activeProviderId;
  const spec = modelSpecFor(providerId, input.settings.activeModelId);
  if (!spec.ok) return spec;

  // --- 3. Prompt from deterministic evidence ---------------------------
  // Egress hygiene: everything about to leave the device passes the masking
  // rules first. `redactSecrets` masks credential-shaped strings and is the
  // default; `redactPii` additionally strips personal identifiers. Captured
  // page data is untrusted by nature — it may embed tokens the page leaked
  // into console text, stack traces, or URLs.
  const maskOptions = { redactPii: input.settings.redactPii };
  const mask = (text: string): string =>
    input.settings.redactSecrets ? maskSecretsInString(text, maskOptions) : text;
  const maskedGroup: ErrorGroup = {
    ...input.group,
    rootCause: {
      ...input.group.rootCause,
      statement: mask(input.group.rootCause.statement),
    },
    title: mask(input.group.title),
  };
  const maskedRepresentative: CapturedError = {
    ...input.representative,
    message: mask(input.representative.message),
    stack: input.representative.stack === undefined ? undefined : mask(input.representative.stack),
    pageUrl: mask(input.representative.pageUrl),
  };
  const maskedErrors = input.groupErrors.map((error) => ({
    ...error,
    message: mask(error.message),
    stack: error.stack === undefined ? undefined : mask(error.stack),
    pageUrl: mask(error.pageUrl),
  }));
  const maskedRequests = input.correlatedRequests.map((request) => ({
    ...request,
    url: mask(request.url),
    errorText: request.errorText === undefined ? undefined : mask(request.errorText),
  }));

  const prompt = buildAnalysisPrompt({
    group: maskedGroup,
    representative: maskedRepresentative,
    correlatedRequests: maskedRequests,
    groupErrors: maskedErrors,
    pageUrl: mask(input.pageUrl),
    budgetChars: input.settings.promptBudgetChars,
    deterministicUnknown: input.group.rootCause.ruleIds.length === 0,
  });

  // --- 4. Provider call -------------------------------------------------
  let keys: Record<string, string>;
  try {
    const loaded = await input.ports.keyVault.loadAll();
    keys = { ...loaded } as Record<string, string>;
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not read the provider key vault.', { cause }),
    );
  }

  const response = await complete(
    {
      model: spec.value,
      messages: [
        {
          role: 'system',
          content:
            'You are a precise debugging assistant. You never contradict evidence-backed findings and you answer in the exact JSON schema you are given.',
        },
        { role: 'user', content: prompt.text },
      ],
      temperature: ANALYSIS_TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseFormat: 'json',
      timeoutMs: input.settings.requestTimeoutMs,
    },
    {
      http: input.ports.http,
      now: input.ports.now,
      keyResolver: async (id) => keys[id],
    },
  );
  if (!response.ok) return response;

  // --- 5. Structured parse ---------------------------------------------
  const parsed = parseAiAnalysis(response.value.text);
  if (!parsed.ok) {
    return err(
      kingDevError('PROVIDER_BAD_RESPONSE', 'The model response was not valid analysis JSON.', {
        detail: parsed.error.message,
        cause: parsed.error,
      }),
    );
  }

  // --- 6. Reconcile with the deterministic layer ------------------------
  const reconciled = reconcileWithDeterministic(parsed.value, input.group);

  return ok({
    groupId: input.group.id,
    analysis: reconciled.analysis,
    promptChars: prompt.totalChars,
    modelId: response.value.modelId || spec.value.modelId,
    latencyMs: response.value.latencyMs,
    deterministicContradicted: reconciled.deterministicContradicted,
    contradictionNotes: reconciled.contradictionNotes,
    modelAsserted: reconciled.modelAsserted,
  });
}
