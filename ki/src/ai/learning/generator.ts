import { AppError } from '../../core/errors';
import type { TaskProgress } from '../queue';
import type { GenerationOptions, LlmProvider, Transcript } from '../types';
import { ensureNotAborted } from '../summary/summarizer';
import { parseGeneratedLearning } from './schema';
import { buildLearningMessages } from './prompts';
import { formatClock } from '../summary/time';

export const LEARNING_CALL_TIMEOUT_MS = 900_000;
export const DEFAULT_INTERNAL_ATTEMPTS = 2;

export interface GenerateLearningInput {
  title: string;
  transcript: Transcript;
  summaryText?: string;
}

export interface GenerateLearningOptions {
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

export interface GenerateLearningResult {
  material: ReturnType<typeof parseGeneratedLearning>;
  model: string;
}

function transcriptText(transcript: Transcript): string {
  return transcript.segments
    .map((segment) => `[${formatClock(segment.startMs)}] ${segment.text}`)
    .join('\n');
}

function generationFor(options: GenerateLearningOptions): GenerationOptions {
  const generation: GenerationOptions = {
    model: options.model,
    numCtx: options.numCtx,
    numPredict: Math.max(256, Math.floor(options.numPredict)),
    temperature: options.temperature,
    format: 'json',
    timeoutMs: LEARNING_CALL_TIMEOUT_MS,
  };
  if (options.keepAlive !== undefined) generation.keepAlive = options.keepAlive;
  if (options.signal !== undefined) generation.signal = options.signal;
  return generation;
}

function lastTimestamp(transcript: Transcript): number {
  let last = 0;
  for (const segment of transcript.segments) {
    if (Number.isFinite(segment.endMs) && segment.endMs > last) last = segment.endMs;
  }
  return Math.max(last, 1000);
}

export async function generateLearning(
  input: GenerateLearningInput,
  options: GenerateLearningOptions,
): Promise<GenerateLearningResult> {
  if (!options.model || options.model.trim().length === 0) {
    throw new AppError('INVALID_INPUT', 'A model name is required to generate learning material');
  }
  const report = options.onProgress ?? (() => {});
  const attempts = options.internalAttempts ?? DEFAULT_INTERNAL_ATTEMPTS;
  const maxTimestampMs = lastTimestamp(input.transcript);

  const messages = buildLearningMessages({
    title: input.title,
    transcriptText: transcriptText(input.transcript),
    ...(input.summaryText === undefined ? {} : { summaryText: input.summaryText }),
  });

  const generation = generationFor(options);
  let lastError: AppError | undefined;
  let current = messages;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ensureNotAborted(options.signal);
    report({ percent: 10 + attempt * 10, message: 'Generating study material…' });
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
      const material = parseGeneratedLearning(content, maxTimestampMs);
      report({ percent: 100, message: 'Study material ready' });
      return { material, model: options.model };
    } catch (err) {
      const appError = AppError.wrap(err);
      if (appError.code !== 'BAD_RESPONSE') throw appError;
      lastError = appError;
      if (attempt < attempts) {
        current = [
          ...current,
          {
            role: 'user',
            content: `The previous reply was rejected (${appError.message}). Reply again with ONLY one valid JSON object following the required shape.`,
          },
        ];
      }
    }
  }
  throw (lastError ?? new AppError('BAD_RESPONSE', 'The local model did not produce study material'));
}