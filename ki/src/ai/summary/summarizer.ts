import { AppError } from '../../core/errors';
import type { TaskProgress } from '../queue';
import type {
  ChatMessage,
  GenerationOptions,
  LlmProvider,
  Transcript,
} from '../types';
import {
  chunkTranscript,
  promptCharBudget,
  type TranscriptChunk,
} from './chunking';
import {
  buildFinalMessages,
  buildMapMessages,
  buildMergeMessages,
} from './prompts';
import {
  parseMapNotes,
  parseStructuredSummary,
  type StructuredSummary,
  type TranscriptNotes,
} from './schema';

/**
 * Map-reduce summarization over a stored transcript.
 *
 * - Map calls are strictly sequential (one model call at a time).
 * - Every model reply is schema-validated; invalid JSON/shape is retried
 *   inside the call and then surfaces as a retryable BAD_RESPONSE.
 * - Notes are merged hierarchically when they no longer fit the final prompt.
 * - Cancellation is checked before every call and forwarded to the provider.
 */

export const DEFAULT_INTERNAL_ATTEMPTS = 2;
export const DEFAULT_MAX_MERGE_ROUNDS = 3;
export const FINAL_MIN_OUTPUT_TOKENS = 900;
/**
 * CPU-only reference hardware (~4 prompt tok/s, ~2 generated tok/s) needs many
 * minutes for one chunk before the first token arrives, so the generic 120 s
 * transport timeout is far too short. Cancellation still aborts immediately.
 */
export const SUMMARY_CALL_TIMEOUT_MS = 1_800_000;
const TIMESTAMP_SLACK_MS = 30_000;
const FINAL_PROMPT_OVERHEAD_TOKENS = 350;
const MERGE_PROMPT_OVERHEAD_TOKENS = 350;

export interface SummarizeInput {
  title: string;
  durationMs?: number;
  transcript: Transcript;
}

export interface SummarizeOptions {
  provider: LlmProvider;
  model: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  keepAlive?: string;
  signal?: AbortSignal;
  onProgress?: (progress: TaskProgress) => void;
  /** Validation retries per model call (default 2 total attempts). */
  internalAttempts?: number;
  /** Character budget for a merge prompt (defaults to the final budget). */
  mergeInputCharBudget?: number;
  maxMergeRounds?: number;
}

export interface SummarizeResult {
  summary: StructuredSummary;
  chunkCount: number;
  mergeRounds: number;
}

export function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('CANCELLED', 'Summarization cancelled');
  }
}

function generationFor(
  options: SummarizeOptions,
  numPredict: number,
): GenerationOptions {
  const generation: GenerationOptions = {
    model: options.model,
    numCtx: options.numCtx,
    numPredict,
    temperature: options.temperature,
    format: 'json',
    timeoutMs: SUMMARY_CALL_TIMEOUT_MS,
  };
  if (options.keepAlive !== undefined) generation.keepAlive = options.keepAlive;
  if (options.signal !== undefined) generation.signal = options.signal;
  return generation;
}

/**
 * One structured model call with schema-validation retries. Only BAD_RESPONSE
 * is retried here; network/timeout errors propagate so the queue owns those
 * retries and never duplicates a long call more than configured.
 */
async function callStructured<T>(
  options: SummarizeOptions,
  messages: ChatMessage[],
  generation: GenerationOptions,
  parse: (raw: string) => T,
  stage: string,
  attempts: number,
): Promise<T> {
  let current = messages;
  let lastError: AppError | undefined;
  const maxAttempts = Math.max(1, Math.floor(attempts));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    ensureNotAborted(options.signal);
    let content: string;
    try {
      const result = await options.provider.chat(current, generation);
      content = result.content;
    } catch (err) {
      const appError = AppError.wrap(err);
      if (appError.code !== 'BAD_RESPONSE') throw appError;
      lastError = appError;
      continue;
    }
    try {
      return parse(content);
    } catch (err) {
      const appError = AppError.wrap(err);
      if (appError.code !== 'BAD_RESPONSE') throw appError;
      lastError = appError;
      if (attempt < maxAttempts) {
        current = [
          ...current,
          {
            role: 'user',
            content: `The previous reply was rejected (${appError.message}). Reply again with ONLY one valid JSON object that follows the required shape.`,
          },
        ];
      }
    }
  }
  throw (
    lastError ??
    new AppError('BAD_RESPONSE', `The local model did not produce ${stage}`)
  );
}

function timestampLimit(input: SummarizeInput): number {
  let lastEnd = 0;
  for (const segment of input.transcript.segments) {
    if (Number.isFinite(segment.endMs) && segment.endMs > lastEnd) {
      lastEnd = segment.endMs;
    }
  }
  const duration =
    input.durationMs !== undefined && Number.isFinite(input.durationMs)
      ? input.durationMs
      : 0;
  return Math.max(lastEnd, duration, 1000) + TIMESTAMP_SLACK_MS;
}

function notesLength(notes: TranscriptNotes[]): number {
  let total = 0;
  for (const note of notes) {
    total += note.summary.length + 16;
    for (const point of note.keyPoints) {
      total += point.text.length + 24;
    }
  }
  return total;
}

function groupNotes(
  notes: TranscriptNotes[],
  budget: number,
): TranscriptNotes[][] {
  const groups: TranscriptNotes[][] = [];
  let current: TranscriptNotes[] = [];
  let currentLength = 0;
  for (const note of notes) {
    const length = notesLength([note]);
    if (current.length > 0 && currentLength + length > budget) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(note);
    currentLength += length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function finalOutputTokens(numCtx: number, numPredict: number): number {
  const requested = Math.max(Math.floor(numPredict), FINAL_MIN_OUTPUT_TOKENS);
  return Math.max(128, Math.min(requested, Math.floor(numCtx / 2)));
}

export async function summarizeTranscript(
  input: SummarizeInput,
  options: SummarizeOptions,
): Promise<SummarizeResult> {
  if (!options.model || options.model.trim().length === 0) {
    throw new AppError('INVALID_INPUT', 'A model name is required to summarize');
  }
  const report = options.onProgress ?? (() => {});
  const attempts = options.internalAttempts ?? DEFAULT_INTERNAL_ATTEMPTS;

  report({ percent: 1, message: 'Splitting the transcript into model-sized parts' });
  const chunks: TranscriptChunk[] = chunkTranscript(input.transcript, {
    numCtx: options.numCtx,
    numPredict: options.numPredict,
  });
  const maxTimestampMs = timestampLimit(input);
  const mapOutputTokens = Math.max(64, Math.floor(options.numPredict));
  const mapGeneration = generationFor(options, mapOutputTokens);

  const notes: TranscriptNotes[] = [];
  for (const chunk of chunks) {
    ensureNotAborted(options.signal);
    const result = await callStructured(
      options,
      buildMapMessages({
        title: input.title,
        chunk,
        totalChunks: chunks.length,
      }),
      mapGeneration,
      (raw) => parseMapNotes(raw, maxTimestampMs),
      `notes for part ${chunk.index + 1}`,
      attempts,
    );
    notes.push(result);
    report({
      percent: 10 + Math.round(((chunk.index + 1) / chunks.length) * 55),
      message: `Summarized part ${chunk.index + 1}/${chunks.length}`,
    });
  }

  const outputTokens = finalOutputTokens(options.numCtx, options.numPredict);
  const finalBudget = promptCharBudget(
    options.numCtx,
    outputTokens,
    FINAL_PROMPT_OVERHEAD_TOKENS,
  );
  const mergeBudget = Math.max(
    600,
    options.mergeInputCharBudget ??
      promptCharBudget(
        options.numCtx,
        mapOutputTokens,
        MERGE_PROMPT_OVERHEAD_TOKENS,
      ),
  );
  const maxRounds = Math.max(
    0,
    Math.floor(options.maxMergeRounds ?? DEFAULT_MAX_MERGE_ROUNDS),
  );
  let condensed = notes;
  let mergeRounds = 0;

  while (
    condensed.length > 1 &&
    notesLength(condensed) > finalBudget &&
    mergeRounds < maxRounds
  ) {
    const groups = groupNotes(condensed, mergeBudget);
    if (groups.every((group) => group.length === 1)) break;
    mergeRounds += 1;
    const merged: TranscriptNotes[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      ensureNotAborted(options.signal);
      const group = groups[index];
      if (!group) continue;
      if (group.length === 1) {
        const only = group[0];
        if (only) merged.push(only);
        continue;
      }
      const result = await callStructured(
        options,
        buildMergeMessages({
          title: input.title,
          notes: group,
          round: mergeRounds,
          totalRounds: maxRounds,
        }),
        mapGeneration,
        (raw) => parseMapNotes(raw, maxTimestampMs),
        `merged notes (round ${mergeRounds})`,
        attempts,
      );
      merged.push(result);
      report({
        percent: 66 + Math.round(((index + 1) / groups.length) * 16),
        message: `Merged notes (round ${mergeRounds})`,
      });
    }
    condensed = merged;
  }

  if (notesLength(condensed) > finalBudget) {
    throw new AppError(
      'INVALID_INPUT',
      'The transcript notes are too large for the configured context window.',
      {
        hint: 'Increase the context window (num_ctx) in Settings to 4096 or more, or summarize a shorter video.',
      },
    );
  }

  ensureNotAborted(options.signal);
  report({ percent: 90, message: 'Writing the final summary' });
  const summary = await callStructured(
    options,
    buildFinalMessages({
      title: input.title,
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: input.durationMs }),
      notes: condensed,
    }),
    generationFor(options, outputTokens),
    (raw) => parseStructuredSummary(raw, maxTimestampMs),
    'final summary',
    attempts,
  );
  ensureNotAborted(options.signal);
  report({ percent: 100, message: 'Summary ready' });

  return { summary, chunkCount: chunks.length, mergeRounds };
}
