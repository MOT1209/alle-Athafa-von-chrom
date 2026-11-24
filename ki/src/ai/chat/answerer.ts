import { AppError } from '../../core/errors';
import type { TaskProgress } from '../queue';
import type {
  ChatMessage,
  GenerationOptions,
  LlmProvider,
  Transcript,
} from '../types';
import { MIN_NUM_CTX, promptCharBudget } from '../summary/chunking';
import { buildChatMessages, type ChatHistoryTurn } from './prompts';
import {
  bestSegment,
  buildWindows,
  searchPassages,
  type RetrievedPassage,
} from './retrieval';
import {
  parseChatAnswer,
  type ChatCitation,
} from './schema';

/**
 * Grounded question answering over a stored transcript.
 *
 * - Retrieval is local and lexical (BM25); no embedding model is required.
 * - When retrieval finds nothing, the model is not called at all and the
 *   answer is an honest "not in the video".
 * - Citations are resolved from real transcript segments, never from model
 *   output; the model only chooses passage numbers.
 * - Every reply is schema-validated before it can be stored or shown.
 */

export const CHAT_CALL_TIMEOUT_MS = 900_000;
export const CHAT_PROMPT_OVERHEAD_TOKENS = 500;
export const CHAT_MIN_OUTPUT_TOKENS = 240;
export const DEFAULT_INTERNAL_ATTEMPTS = 2;
const MAX_CITATION_CHARS = 320;
const MAX_HISTORY_CHARS = 900;

export interface AnswerInput {
  title: string;
  question: string;
  transcript: Transcript;
  history?: ChatHistoryTurn[];
}

export interface AnswerOptions {
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
  maxPassages?: number;
}

export interface AnswerResult {
  found: boolean;
  answer: string;
  citations: ChatCitation[];
  passageCount: number;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('CANCELLED', 'Question cancelled');
  }
}

function requireContext(numCtx: number): void {
  if (!Number.isFinite(numCtx) || numCtx < MIN_NUM_CTX) {
    throw new AppError(
      'INVALID_INPUT',
      `Chat needs a context window (num_ctx) of at least ${MIN_NUM_CTX} tokens; current value: ${String(numCtx)}.`,
      {
        hint: `Raise the context window in Settings to at least ${MIN_NUM_CTX}. 4096 is recommended for the default model.`,
      },
    );
  }
}

function answerOutputTokens(numCtx: number, numPredict: number): number {
  const requested = Math.max(Math.floor(numPredict), CHAT_MIN_OUTPUT_TOKENS);
  return Math.max(128, Math.min(requested, Math.floor(numCtx / 2)));
}

function passageCost(passage: RetrievedPassage): number {
  return passage.text.length + 64;
}

/** Keep the most relevant passages that fit the prompt budget. */
function selectPassages(
  passages: RetrievedPassage[],
  budget: number,
): RetrievedPassage[] {
  const selected: RetrievedPassage[] = [];
  let used = 0;
  for (const passage of passages) {
    const cost = passageCost(passage);
    if (selected.length === 0 && cost > budget) {
      const room = Math.max(240, budget - 64);
      selected.push({
        ...passage,
        text: passage.text.slice(0, room).trimEnd(),
      });
      break;
    }
    if (selected.length > 0 && used + cost > budget) break;
    selected.push(passage);
    used += cost;
  }
  return selected;
}

function trimHistory(
  history: ChatHistoryTurn[] | undefined,
  charBudget: number,
): ChatHistoryTurn[] {
  if (!history || history.length === 0 || charBudget <= 0) return [];
  const kept: ChatHistoryTurn[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (!turn) continue;
    const cost = turn.text.length + 12;
    if (used + cost > charBudget) break;
    kept.unshift({ role: turn.role, text: turn.text });
    used += cost;
  }
  return kept;
}

function historyChars(history: ChatHistoryTurn[]): number {
  let total = 0;
  for (const turn of history) total += turn.text.length + 12;
  return total;
}

function toCitations(
  passages: RetrievedPassage[],
  usedSources: number[],
  question: string,
): ChatCitation[] {
  const byStart = new Map<number, ChatCitation>();
  for (const number of usedSources) {
    const passage = passages[number - 1];
    if (!passage) continue;
    const segment = bestSegment(passage, question);
    if (!segment) continue;
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    const trimmed =
      text.length > MAX_CITATION_CHARS
        ? `${text.slice(0, MAX_CITATION_CHARS - 1).trimEnd()}…`
        : text;
    const startMs = Math.max(0, Math.round(segment.startMs));
    const endMs = Math.max(startMs, Math.round(segment.endMs));
    if (!byStart.has(startMs)) {
      byStart.set(startMs, { startMs, endMs, text: trimmed });
    }
  }
  return [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
}

/**
 * One structured model call with validation retries. Only BAD_RESPONSE is
 * retried here; network/timeout errors propagate so the queue owns them.
 */
async function callStructured(
  options: AnswerOptions,
  messages: ChatMessage[],
  generation: GenerationOptions,
  parse: (raw: string) => ReturnType<typeof parseChatAnswer>,
  attempts: number,
): Promise<ReturnType<typeof parseChatAnswer>> {
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
    new AppError('BAD_RESPONSE', 'The local model did not produce a chat answer')
  );
}

export async function answerQuestion(
  input: AnswerInput,
  options: AnswerOptions,
): Promise<AnswerResult> {
  const question = input.question.trim();
  if (question.length === 0) {
    throw new AppError('INVALID_INPUT', 'A question is required');
  }
  requireContext(options.numCtx);
  ensureNotAborted(options.signal);

  options.onProgress?.({ percent: 5 });
  const windows = buildWindows(input.transcript);
  const passages = searchPassages(windows, question, {
    ...(options.maxPassages === undefined
      ? {}
      : { maxPassages: options.maxPassages }),
  });
  if (passages.length === 0) {
    // Honest offline path: nothing relevant was retrieved, so the model is
    // never asked to guess.
    return { found: false, answer: '', citations: [], passageCount: 0 };
  }

  const outputTokens = answerOutputTokens(options.numCtx, options.numPredict);
  const budget = promptCharBudget(
    options.numCtx,
    outputTokens,
    CHAT_PROMPT_OVERHEAD_TOKENS,
  );
  const history = trimHistory(
    input.history,
    Math.min(MAX_HISTORY_CHARS, Math.floor(budget * 0.25)),
  );
  const selected = selectPassages(
    passages,
    Math.max(600, budget - historyChars(history)),
  );
  if (selected.length === 0) {
    return { found: false, answer: '', citations: [], passageCount: 0 };
  }

  const messages = buildChatMessages({
    title: input.title,
    question,
    passages: selected,
    ...(history.length === 0 ? {} : { history }),
  });
  const generation: GenerationOptions = {
    model: options.model,
    numCtx: options.numCtx,
    numPredict: outputTokens,
    temperature: options.temperature,
    format: 'json',
    timeoutMs: CHAT_CALL_TIMEOUT_MS,
  };
  if (options.keepAlive !== undefined) generation.keepAlive = options.keepAlive;
  if (options.signal !== undefined) generation.signal = options.signal;

  options.onProgress?.({ percent: 40 });
  const parsed = await callStructured(
    options,
    messages,
    generation,
    (raw) => parseChatAnswer(raw, selected.length),
    options.internalAttempts ?? DEFAULT_INTERNAL_ATTEMPTS,
  );
  ensureNotAborted(options.signal);
  options.onProgress?.({ percent: 95 });

  if (!parsed.found) {
    return {
      found: false,
      answer: '',
      citations: [],
      passageCount: selected.length,
    };
  }

  const citations = toCitations(selected, parsed.usedSources, question);
  if (citations.length === 0) {
    throw new AppError(
      'BAD_RESPONSE',
      'The local model cited passages that produced no transcript citation',
      { retryable: true },
    );
  }
  return {
    found: true,
    answer: parsed.answer,
    citations,
    passageCount: selected.length,
  };
}
