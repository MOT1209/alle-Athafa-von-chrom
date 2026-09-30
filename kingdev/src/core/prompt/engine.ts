/**
 * Agent Prompt Engine (plan Phase 4).
 *
 * The model never receives a free-text question. It receives a prompt
 * assembled section-by-section from deterministic facts: the `groupErrors`
 * output (classified inputs), the error itself, correlated network evidence,
 * and the rules that fired. Three invariants drive the design:
 *
 *   1. Evidence before model. Every section states its provenance — captured,
 *      rule-derived, or unknown. Nothing is invented to fill a gap.
 *   2. The model may not override deterministic evidence. A rule-backed cause
 *      is stated as non-negotiable in the prompt; the response parser rejects
 *      malformed JSON, and the reconciler marks any model claim that contradicts
 *      a rule-backed cause instead of letting it silently replace it.
 *   3. Structured output or nothing. The response must parse as JSON matching
 *      the analysis schema; anything else becomes a typed PROVIDER_BAD_RESPONSE
 *      error, never a loosely-rendered guess.
 */

import { describeUrl } from '@/core/reasoning/rules';
import type {
  AiIssueAnalysis,
  CapturedError,
  ConfidenceLevel,
  ErrorGroup,
  FixApproach,
  Justification,
  NetworkRequest,
  PromptSection,
  PromptSectionId,
  Result,
  RiskLevel,
  RootCause,
  RootCauseCategory,
  Severity,
} from '@/core/types';
import {
  CONFIDENCE_LEVELS,
  FIX_APPROACHES,
  RISK_LEVELS,
  ROOT_CAUSE_CATEGORIES,
  SEVERITIES,
} from '@/core/types';
import { err, ok } from '@/core/types';

/* ------------------------------------------------------------------ *
 * Prompt input — classified, never free text
 * ------------------------------------------------------------------ */

/**
 * Everything the prompt builder may look at, sorted by how it was obtained.
 * The caller assembles this from `groupErrors` output plus the capture store —
 * the prompt engine renders it verbatim and invents nothing.
 */
export interface AnalysisPromptInput {
  readonly group: ErrorGroup;
  /** The representative error of the group (rendered with stack + frames). */
  readonly representative: CapturedError;
  /** Requests correlated with the group by `correlateRequests`/grouping. */
  readonly correlatedRequests: readonly NetworkRequest[];
  /** Raw occurrences behind the group, for duplicate/pattern observations. */
  readonly groupErrors: readonly CapturedError[];
  /** Page URL the errors were captured on. */
  readonly pageUrl: string;
  /** Character budget from `settings.promptBudgetChars`. */
  readonly budgetChars: number;
  /** Set when the deterministic layer found no rule and said so. */
  readonly deterministicUnknown: boolean;
}

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function describeFrames(error: CapturedError, max = 5): string {
  if (error.frames.length === 0) return '(no frames captured)';
  return error.frames
    .slice(0, max)
    .map(
      (frame, index) =>
        `${index + 1}. ${frame.functionName || '(anonymous)'} at ${frame.url}:${frame.lineNumber}:${frame.columnNumber}`,
    )
    .join('\n');
}

function describeRequests(requests: readonly NetworkRequest[], max = 6): string {
  if (requests.length === 0) {
    return '(no requests were correlated with this error)';
  }
  return requests
    .slice(0, max)
    .map(
      (request) =>
        `- ${request.method} ${describeUrl(request.url)} → ${
          request.statusCode ?? request.outcome
        }${request.fromCache ? ' (from cache)' : ''}, outcome=${request.outcome}${
          request.errorText ? `, error="${truncate(request.errorText, 120)}"` : ''
        }`,
    )
    .join('\n');
}

function describeEvidence(signals: readonly Justification[], max = 5): string {
  if (signals.length === 0) return '(none)';
  return signals
    .slice(0, max)
    .map((signal) => `- ${signal.signal}${signal.detail ? ` — ${signal.detail}` : ''}`)
    .join('\n');
}

function describeAlternatives(rootCause: RootCause): string {
  if (rootCause.alternatives.length === 0) return '(none recorded by the deterministic layer)';
  return rootCause.alternatives
    .map(
      (alt) =>
        `- [${alt.likelihood}] ${alt.statement}\n  Test that discriminates it: ${alt.discriminatingTest}`,
    )
    .join('\n');
}

/** Occurrence pattern of one fingerprint across the capture, stated as facts. */
function describeOccurrences(errors: readonly CapturedError[]): string {
  const total = errors.reduce((sum, e) => sum + e.occurrences, 0);
  const kinds = [...new Set(errors.map((e) => e.kind))].join(', ');
  return `${errors.length} captured record(s), ${total} occurrence(s), kinds: ${kinds || 'none'}.`;
}

/* ------------------------------------------------------------------ *
 * Section builders
 * ------------------------------------------------------------------ */

function roleSection(): PromptSection {
  return {
    id: 'role',
    title: 'Role',
    body: 'You are a senior web debugging assistant. You receive captured evidence from a browser extension and must explain the observed failure without contradicting it.',
    charCount: 0,
    truncated: false,
  };
}

function taskSection(): PromptSection {
  return {
    id: 'task',
    title: 'Task',
    body: 'Explain this captured error: give a hypothesis, the most likely cause, a test that would confirm or refute it, and your confidence. Respond with a single JSON object exactly matching the schema in "Required response format". No prose outside the JSON.',
    charCount: 0,
    truncated: false,
  };
}

function observedEvidenceSection(input: AnalysisPromptInput): PromptSection {
  const lines: string[] = [
    `Group: ${input.group.id}`,
    `Page: ${input.pageUrl}`,
    `Occurrences: ${describeOccurrences(input.groupErrors)}`,
    `First seen: ${input.group.firstSeenAt}; last seen: ${input.group.lastSeenAt}.`,
    `Derived severity: ${input.group.severity} (from deterministic scoring, not adjustable).`,
    'Severity signals:',
    describeEvidence(input.group.severityJustification),
  ];
  if (input.correlatedRequests.length > 0) {
    lines.push(
      `Correlated network requests (${input.correlatedRequests.length}; time-correlation only, not proven causation):`,
      describeRequests(input.correlatedRequests),
    );
  }
  return {
    id: 'observed-evidence',
    title: 'Observed evidence',
    body: lines.join('\n'),
    charCount: 0,
    truncated: false,
  };
}

function errorSection(input: AnalysisPromptInput): PromptSection {
  const error = input.representative;
  return {
    id: 'error',
    title: 'Captured error',
    body: [
      `Kind: ${error.kind}`,
      `Name: ${error.name}`,
      `Message: ${error.message}`,
      `Captured at: ${error.timestamp} on ${error.pageUrl}`,
      error.stack ? `Stack text:\n${truncate(error.stack, 1_500)}` : '(no stack text captured)',
    ].join('\n'),
    charCount: 0,
    truncated: false,
  };
}

function stackTraceSection(input: AnalysisPromptInput): PromptSection {
  return {
    id: 'stack-trace',
    title: 'Stack frames',
    body: describeFrames(input.representative),
    charCount: 0,
    truncated: false,
  };
}

const BINDING_HEADING = 'BINDING DETERMINISTIC FINDING — you must accept it as-is:';

/**
 * The heart of the override-prevention contract. When rules fired, their cause
 * leads the section and is stated as the ground truth the model must accept;
 * the model may add alternatives and unknowns but not replace it. When nothing
 * fired, that fact is stated explicitly and the model is allowed to
 * hypothesise — marked as model-asserted on its return.
 */
function rootCauseSection(input: AnalysisPromptInput): PromptSection {
  const cause = input.group.rootCause;
  const lines: string[] = [
    `Deterministic category: ${cause.category}`,
    `Deterministic confidence: ${cause.confidence}`,
  ];

  if (cause.ruleIds.length > 0) {
    // The binding finding leads the section so an aggressive character budget
    // cannot cut the override-prevention contract while keeping boilerplate.
    lines.push(
      '',
      BINDING_HEADING,
      cause.statement,
      '',
      `Rules that fired (reproducible, evidence-backed): ${cause.ruleIds.join(', ')}.`,
      '',
      'Its supporting evidence:',
      describeEvidence(cause.confidenceSignals),
      '',
      'Your output must keep rootCauseCategory equal to this category when you agree with the finding, and record why you disagree in "unknowns" if you do not. You may add alternative causes, but the primary cause must not contradict the binding finding.',
    );
  } else {
    lines.push(
      '',
      'No deterministic rule matched — the cause below is unknown, not wrong:',
      cause.statement,
      '',
      'You may hypothesise a cause. Your analysis will be marked as model-asserted (never high confidence) because no rule backs it.',
    );
  }

  lines.push(
    '',
    'Recorded alternative causes with their discriminating tests:',
    describeAlternatives(cause),
  );

  return {
    id: 'root-cause',
    title: 'Deterministic root cause',
    body: lines.join('\n'),
    charCount: 0,
    truncated: false,
  };
}

function recommendedApproachSection(): PromptSection {
  return {
    id: 'recommended-approach',
    title: 'Investigation approach',
    body: 'Prefer causes that explain every observed occurrence with the fewest assumptions. Ground each claim in the evidence above and say so via referencedEvidenceIds. A claim with no supporting evidence belongs in "unknowns", not in rootCause.',
    charCount: 0,
    truncated: false,
  };
}

const RESPONSE_SCHEMA = `{
  "title": string — short headline for the issue (<=120 chars),
  "summary": string — 1-3 sentence restatement of what was observed,
  "severity": one of ${SEVERITIES.join('|')},
  "severityReason": string — why this severity,
  "confidence": one of ${CONFIDENCE_LEVELS.join('|')},
  "confidenceReason": string — why this confidence,
  "rootCause": string — the primary cause statement,
  "rootCauseCategory": one of ${ROOT_CAUSE_CATEGORIES.join('|')},
  "alternatives": [{ "statement": string, "likelihood": one of ${CONFIDENCE_LEVELS.join('|')}, "discriminatingTest": string }],
  "fixes": [{ "approach": one of ${FIX_APPROACHES.join('|')}, "title": string, "whatChanges": string, "whyItWorks": string, "sideEffects": string[], "filesAffected": string[], "risk": one of ${RISK_LEVELS.join('|')}, "diffs": [] }],
  "unknowns": string[] — what the evidence does not establish,
  "referencedEvidenceIds": string[] — ids of evidence items you relied on
}`;

function constraintsSection(): PromptSection {
  return {
    id: 'constraints',
    title: 'Constraints',
    body: [
      '1. The "Deterministic root cause" section is evidence, not opinion. Do not contradict a cause backed by fired rules.',
      '2. Never claim a fact the evidence does not show. If something is unknown, put it in "unknowns".',
      '3. Only reference evidence ids that appear in this prompt.',
      '4. confidence "high" is allowed only when a fired rule backs your primary cause; otherwise use "medium" or "low".',
      '5. fixes[].diffs must stay empty — propose changes in prose, do not invent file contents.',
      '',
      'Required response format — respond with ONLY this JSON object:',
      RESPONSE_SCHEMA,
    ].join('\n'),
    charCount: 0,
    truncated: false,
  };
}

function unknownsSection(input: AnalysisPromptInput): PromptSection {
  const lines: string[] = [];
  if (input.representative.stack === undefined) {
    lines.push('- No stack text was captured; frame-level attribution is unavailable.');
  }
  if (input.correlatedRequests.length === 0) {
    lines.push(
      '- No network requests were correlated with this error; request/response shapes are unavailable.',
    );
  }
  if (input.deterministicUnknown) {
    lines.push('- The deterministic layer found no matching rule; no offline cause exists.');
  }
  if (lines.length === 0) {
    lines.push('- (none beyond what the evidence sections state)');
  }
  return {
    id: 'unknowns',
    title: 'Known unknowns',
    body: lines.join('\n'),
    charCount: 0,
    truncated: false,
  };
}

function reportingSection(): PromptSection {
  return {
    id: 'reporting-requirements',
    title: 'Reporting requirements',
    body: 'Output exactly one JSON object. Start your reply with "{" and end it with "}". No markdown fences, no commentary.',
    charCount: 0,
    truncated: false,
  };
}

/* ------------------------------------------------------------------ *
 * Budget application
 * ------------------------------------------------------------------ */

/**
 * Applies the character budget. Flexible evidence sections are truncated
 * first (longest first), then dropped entirely once truncation cannot help.
 * Structural sections (role, task, constraints, reporting) and the binding
 * root-cause section are never dropped: they carry the override-prevention
 * contract, which is the one thing this module must guarantee. When the
 * structural floor alone exceeds the budget the prompt is returned over
 * budget — `totalChars > budgetChars` reports that honestly — rather than
 * silently shedding the contract to hit a number.
 *
 * A dropped section is flagged `truncated: true` with a stated `omittedReason`
 * — sections disappear visibly, never silently.
 */
function applyBudget(
  sections: readonly PromptSection[],
  budgetChars: number,
): {
  sections: readonly PromptSection[];
  omittedSectionIds: readonly PromptSectionId[];
} {
  const sized = sections.map((section) => ({ ...section, charCount: section.body.length }));
  const total = sized.reduce((sum, s) => sum + s.charCount + 20, 0);
  if (total <= budgetChars) return { sections: sized, omittedSectionIds: [] };

  const structural = new Set<PromptSectionId>([
    'role',
    'task',
    'constraints',
    'reporting-requirements',
  ]);
  /** Truncation may shrink it, but pass 1 must never drop it. */
  const neverDropInPass1 = new Set<PromptSectionId>(['root-cause']);
  const MIN_FLEX = 200;
  let over = total - budgetChars;
  const omitted: PromptSectionId[] = [];

  const remove = (section: PromptSection): void => {
    const at = sized.indexOf(section);
    if (at === -1) return; // already removed — never splice(-1)
    over -= section.charCount + 20;
    sized.splice(at, 1);
    omitted.push(section.id);
  };

  // Pass 1: truncate then drop flexible evidence sections, longest first.
  const flexible = sized
    .filter((s) => !structural.has(s.id) && s.charCount > MIN_FLEX)
    .sort((a, b) => b.charCount - a.charCount);
  for (const section of flexible) {
    if (over <= 0) break;
    const oldCount = section.charCount;
    const target = Math.max(MIN_FLEX, oldCount - over);
    if (target < oldCount) {
      section.body = truncate(section.body, target);
      section.charCount = section.body.length;
      over -= oldCount - section.charCount;
      section.truncated = true;
      section.omittedReason = 'truncated to fit the prompt budget';
    }
    if (over > 0 && section.charCount <= MIN_FLEX && !neverDropInPass1.has(section.id)) {
      remove(section);
    }
  }
  if (over <= 0) return { sections: sized, omittedSectionIds: omitted };

  // The structural floor alone exceeds the budget. Keeping the contract
  // intact beats hitting the number: return over budget and let the caller
  // see it via totalChars > budgetChars.
  return { sections: sized, omittedSectionIds: omitted };
}

/* ------------------------------------------------------------------ *
 * Prompt assembly
 * ------------------------------------------------------------------ */

export interface GeneratedAnalysisPrompt {
  readonly text: string;
  readonly sections: readonly PromptSection[];
  readonly totalChars: number;
  readonly budgetChars: number;
  readonly omittedSectionIds: readonly PromptSectionId[];
}

function sectionTitle(id: PromptSectionId, title: string): string {
  return id === 'constraints' ? title : `${title}`;
}

/** Assembles the final prompt text from sized sections. */
function renderPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map((section) => `## ${sectionTitle(section.id, section.title)}\n${section.body}`)
    .join('\n\n');
}

export function buildAnalysisPrompt(input: AnalysisPromptInput): GeneratedAnalysisPrompt {
  const draft: readonly PromptSection[] = [
    roleSection(),
    taskSection(),
    observedEvidenceSection(input),
    errorSection(input),
    stackTraceSection(input),
    rootCauseSection(input),
    recommendedApproachSection(),
    constraintsSection(),
    unknownsSection(input),
    reportingSection(),
  ];

  const { sections, omittedSectionIds } = applyBudget([...draft], input.budgetChars);
  const text = renderPrompt(sections);

  return {
    text,
    sections,
    totalChars: text.length,
    budgetChars: input.budgetChars,
    omittedSectionIds,
  };
}

/* ------------------------------------------------------------------ *
 * Response parsing — structured output or a typed error
 * ------------------------------------------------------------------ */

export type AnalysisParseResult = Result<AiIssueAnalysis, AnalysisParseError>;

export class AnalysisParseError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Model response failed schema validation: ${problems.join('; ')}`);
    this.name = 'AnalysisParseError';
    this.problems = problems;
  }
}

function isOneOf<T extends string>(value: unknown, vocab: readonly T[]): value is T {
  return typeof value === 'string' && (vocab as readonly string[]).includes(value);
}

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : truncate(trimmed, max);
}

function asStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    const s = asString(item, 300);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/**
 * Extracts the JSON payload from a model reply. Tolerates markdown fences and
 * surrounding prose — real models add both despite instructions — but the
 * extracted payload must still validate against the schema.
 */
export function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  const candidate = withoutFences.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

const MAX_ALTERNATIVES = 5;
const MAX_FIXES = 4;

function parseAlternatives(value: unknown): AiIssueAnalysis['alternatives'] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ALTERNATIVES)
    .map((item) => {
      if (typeof item !== 'object' || item === null) return undefined;
      const record = item as Record<string, unknown>;
      const statement = asString(record.statement, 400);
      if (statement === undefined) return undefined;
      return {
        statement,
        likelihood: isOneOf(record.likelihood, CONFIDENCE_LEVELS) ? record.likelihood : 'low',
        discriminatingTest: asString(record.discriminatingTest, 400) ?? 'not provided',
      };
    })
    .filter((item): item is AiIssueAnalysis['alternatives'][number] => item !== undefined);
}

function parseFixes(value: unknown): NonNullable<AiIssueAnalysis['fixes']> {
  if (!Array.isArray(value)) return [];
  const fixes: AiIssueAnalysis['fixes'][number][] = [];
  for (const item of value.slice(0, MAX_FIXES)) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const title = asString(record.title, 160);
    const whatChanges = asString(record.whatChanges, 800);
    if (title === undefined || whatChanges === undefined) continue;
    fixes.push({
      approach: isOneOf(record.approach, FIX_APPROACHES)
        ? record.approach
        : ('recommended' as FixApproach),
      title,
      whatChanges,
      whyItWorks: asString(record.whyItWorks, 800) ?? 'not provided',
      sideEffects: asStringArray(record.sideEffects, 6) ?? [],
      filesAffected: asStringArray(record.filesAffected, 10) ?? [],
      risk: isOneOf(record.risk, RISK_LEVELS) ? record.risk : ('low' as RiskLevel),
      diffs: [],
    });
  }
  return fixes;
}

export function parseAiAnalysis(text: string): AnalysisParseResult {
  const payload = extractJsonPayload(text);
  if (typeof payload !== 'object' || payload === null) {
    return err(new AnalysisParseError(['no JSON object could be extracted from the response']));
  }

  const problems: string[] = [];
  const record = payload as Record<string, unknown>;

  const title = asString(record.title, 160);
  const summary = asString(record.summary, 1_000);
  const rootCauseText = asString(record.rootCause, 1_000);

  if (title === undefined) problems.push('title is missing or empty');
  if (summary === undefined) problems.push('summary is missing or empty');
  if (rootCauseText === undefined) problems.push('rootCause is missing or empty');
  if (!isOneOf(record.severity, SEVERITIES))
    problems.push(`severity must be one of ${SEVERITIES.join('|')}`);
  if (!isOneOf(record.confidence, CONFIDENCE_LEVELS))
    problems.push(`confidence must be one of ${CONFIDENCE_LEVELS.join('|')}`);
  if (!isOneOf(record.rootCauseCategory, ROOT_CAUSE_CATEGORIES))
    problems.push(`rootCauseCategory must be one of ${ROOT_CAUSE_CATEGORIES.join('|')}`);
  if (asString(record.severityReason, 500) === undefined)
    problems.push('severityReason is missing');
  if (asString(record.confidenceReason, 500) === undefined)
    problems.push('confidenceReason is missing');

  if (problems.length > 0) {
    return err(new AnalysisParseError(problems));
  }

  const analysis: AiIssueAnalysis = {
    title: title as string,
    summary: summary as string,
    severity: record.severity as Severity,
    severityReason: asString(record.severityReason, 500) as string,
    confidence: record.confidence as ConfidenceLevel,
    confidenceReason: asString(record.confidenceReason, 500) as string,
    rootCause: rootCauseText as string,
    rootCauseCategory: record.rootCauseCategory as (typeof ROOT_CAUSE_CATEGORIES)[number],
    alternatives: parseAlternatives(record.alternatives),
    fixes: parseFixes(record.fixes),
    unknowns: asStringArray(record.unknowns, 8) ?? [],
    referencedEvidenceIds: asStringArray(record.referencedEvidenceIds, 20) ?? [],
  };

  return ok(analysis);
}

/* ------------------------------------------------------------------ *
 * Reconciliation — the model may not override deterministic evidence
 * ------------------------------------------------------------------ */

export interface ReconciledAnalysis {
  readonly analysis: AiIssueAnalysis;
  /** Set when the model's primary cause contradicts a rule-backed finding. */
  readonly deterministicContradicted: boolean;
  /** Human-readable reasons shown in the UI when contradicted. */
  readonly contradictionNotes: readonly string[];
  /** True when no deterministic rule backs the cause (model-asserted only). */
  readonly modelAsserted: boolean;
}

function contradictsRuleBackedCause(
  cause: RootCause,
  modelCategory: RootCauseCategory,
  modelConfidence: ConfidenceLevel,
): boolean {
  if (cause.ruleIds.length === 0) return false;
  if (modelCategory !== cause.category) return true;
  // The model accepts the category but downgrades the confidence below the
  // rule-derived one — a silent demotion of reproducible evidence.
  return modelConfidence === 'low' || modelConfidence === 'unknown';
}

/**
 * Reconciles the parsed model output with the deterministic layer.
 *
 * The model is free to add alternatives and unknowns. It is not free to
 * replace a rule-backed cause: if it does, the UI shows the binding finding
 * alongside the contradiction instead of silently adopting the model's claim.
 */
export function reconcileWithDeterministic(
  analysis: AiIssueAnalysis,
  group: ErrorGroup,
): ReconciledAnalysis {
  const cause = group.rootCause;
  const ruleBacked = cause.ruleIds.length > 0;
  const contradicted = contradictsRuleBackedCause(
    cause,
    analysis.rootCauseCategory,
    analysis.confidence,
  );

  const contradictionNotes: string[] = [];
  if (contradicted) {
    contradictionNotes.push(
      `The model's primary cause (${analysis.rootCauseCategory}) contradicts the deterministic finding (${cause.category}, rules: ${cause.ruleIds.join(', ')}). The deterministic finding stands.`,
      `Binding statement: ${cause.statement}`,
    );
  }
  if (ruleBacked && analysis.confidence === 'high' && !contradicted) {
    contradictionNotes.push(
      `High confidence accepted because deterministic rules (${cause.ruleIds.join(', ')}) back the cause.`,
    );
  }

  // Evidence hygiene: only ids that the prompt actually contained may be
  // referenced. Unknown ids would let the model imply evidence that was
  // never collected.
  const knownEvidence = new Set<string>([
    ...cause.supportingEvidenceIds,
    ...cause.confidenceSignals.map((signal) => signal.signal),
    ...group.relatedRequestIds,
    ...group.relatedConsoleIds,
    group.representativeErrorId,
  ]);
  const referenced = analysis.referencedEvidenceIds.filter((id) => knownEvidence.has(id));

  const modelAsserted = !ruleBacked;

  return {
    analysis: { ...analysis, referencedEvidenceIds: referenced },
    deterministicContradicted: contradicted,
    contradictionNotes,
    modelAsserted,
  };
}
