import { AppError } from '../../core/errors';
import type { TaskProgress } from '../queue';
import type { ChatMessage, GenerationOptions, LlmProvider, TranscriptSegment } from '../types';
import { CHARS_PER_TOKEN } from '../summary/chunking';
import { ensureNotAborted } from '../summary/summarizer';
import { parseTranslationBatch, type TranslatedSegment } from './schema';
import { buildTranslationMessages } from './prompts';

export const TRANSLATION_CALL_TIMEOUT_MS = 900_000;
export const DEFAULT_INTERNAL_ATTEMPTS = 2;
export const MAX_SEGMENTS_PER_BATCH = 25;
const OVERHEAD_TOKENS = 300;
const MIN_OUTPUT_TOKENS = 128;

export interface TranslateInput {
  sourceLanguage?: string;
  targetLanguage: string;
  segments: readonly TranscriptSegment[];
}

export interface TranslateOptions {
  provider: LlmProvider;
  model: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  keepAlive?: string;
  signal?: AbortSignal;
  onProgress?: (progress: TaskProgress) => void;
  internalAttempts?: number;
}

export interface TranslateResult {
  segments: TranscriptSegment[];
  model: string;
  batchCount: number;
}

interface Batch {
  keys: string[];
  segments: TranscriptSegment[];
}

function generationFor(
  options: TranslateOptions,
  numPredict: number,
): GenerationOptions {
  const generation: GenerationOptions = {
    model: options.model,
    numCtx: options.numCtx,
    numPredict,
    temperature: options.temperature,
    format: 'json',
    timeoutMs: TRANSLATION_CALL_TIMEOUT_MS,
  };
  if (options.keepAlive !== undefined) generation.keepAlive = options.keepAlive;
  if (options.signal !== undefined) generation.signal = options.signal;
  return generation;
}



async function callBatch(
  options: TranslateOptions,
  messages: ChatMessage[],
  generation: GenerationOptions,
  expectedKeys: readonly string[],
  attempts: number,
): Promise<TranslatedSegment[]> {
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
      const parsed = parseTranslationBatch(content, expectedKeys);
      return parsed.segments;
    } catch (err) {
      const appError = AppError.wrap(err);
      if (appError.code !== 'BAD_RESPONSE') throw appError;
      lastError = appError;
      if (attempt < maxAttempts) {
        current = [
          ...current,
          {
            role: 'user',
            content: `The previous reply was rejected (${appError.message}). Reply again with ONLY one valid JSON object following the required shape, with exactly these keys: ${expectedKeys.join(', ')}.`,
          },
        ];
      }
    }
  }
  throw (
    lastError ??
    new AppError('BAD_RESPONSE', 'The local model did not produce a translation')
  );
}

export async function translateTranscript(
  input: TranslateInput,
  options: TranslateOptions,
): Promise<TranslateResult> {
  if (!options.model || options.model.trim().length === 0) {
    throw new AppError('INVALID_INPUT', 'A model name is required to translate');
  }
  if (!input.targetLanguage || input.targetLanguage.trim().length === 0) {
    throw new AppError('INVALID_INPUT', 'A target language is required');
  }
  const report = options.onProgress ?? (() => {});
  const attempts = options.internalAttempts ?? DEFAULT_INTERNAL_ATTEMPTS;

  const hasUsable = input.segments.some(
    (segment) => typeof segment.text === 'string' && segment.text.trim().length > 0,
  );
  if (!hasUsable) {
    throw new AppError('INVALID_INPUT', 'The transcript has no segments to translate.');
  }

  const available = Math.max(600, options.numCtx - OVERHEAD_TOKENS);
  const outputTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(
      Math.floor(available * (2 / 3)),
      Math.max(options.numPredict, Math.floor(available * (2 / 3))),
    ),
  );
  const generation = generationFor(options, outputTokens);

  // Map from global source index -> translated text.
  const translatedByKey = new Map<string, string>();

  const globalBatches = planBatches(input.segments, options.numCtx);

  const total = globalBatches.length;
  for (let batchIndex = 0; batchIndex < total; batchIndex += 1) {
    ensureNotAborted(options.signal);
    const batch = globalBatches[batchIndex];
    if (!batch) continue;
    report({
      percent: Math.round(((batchIndex) / total) * 90) + 5,
      message: `Translating batch ${batchIndex + 1}/${total}`,
    });
    const messages = buildTranslationMessages({
      ...(input.sourceLanguage === undefined ? {} : { sourceLanguage: input.sourceLanguage }),
      targetLanguage: input.targetLanguage,
      segments: batch.keys.map((key, i) => ({
        key,
        segment: batch.segments[i]!,
      })),
    });
    const parsed = await callBatch(options, messages, generation, batch.keys, attempts);
    for (const item of parsed) {
      translatedByKey.set(item.key, item.text);
    }
  }

  // Reassemble in original order, copying timestamps.
  const resultSegments: TranscriptSegment[] = input.segments.map((segment, index) => {
    if (typeof segment.text !== 'string' || segment.text.trim().length === 0) {
      return { ...segment, text: segment.text };
    }
    const key = String(index);
    const translated = translatedByKey.get(key);
    if (translated === undefined) {
      throw new AppError('BAD_RESPONSE', `Missing translation for segment ${key}`);
    }
    return {
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: translated,
    };
  });

  ensureNotAborted(options.signal);
  report({ percent: 100, message: 'Translation ready' });
  return { segments: resultSegments, model: options.model, batchCount: total };
}

export function planBatches(
  segments: readonly TranscriptSegment[],
  numCtx: number,
): Batch[] {
  const available = Math.max(600, numCtx - OVERHEAD_TOKENS);
  const inputTokens = Math.max(200, Math.floor(available / 3));
  const inputBudget = Math.max(600, Math.floor(inputTokens * CHARS_PER_TOKEN));

  const batches: Batch[] = [];
  let currentKeys: string[] = [];
  let currentSegments: TranscriptSegment[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (currentKeys.length === 0) return;
    batches.push({ keys: currentKeys, segments: currentSegments });
    currentKeys = [];
    currentSegments = [];
    currentChars = 0;
  };

  segments.forEach((segment, index) => {
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (text.length === 0) return;
    const key = String(index);
    const pieceChars = text.length;
    if (
      currentKeys.length > 0 &&
      (currentChars + 1 + pieceChars > inputBudget ||
        currentKeys.length >= MAX_SEGMENTS_PER_BATCH)
    ) {
      flush();
    }
    currentKeys.push(key);
    currentSegments.push(segment);
    currentChars += pieceChars + (currentKeys.length > 1 ? 1 : 0);
    if (currentChars >= inputBudget || currentKeys.length >= MAX_SEGMENTS_PER_BATCH) {
      flush();
    }
  });
  flush();
  return batches;
}

