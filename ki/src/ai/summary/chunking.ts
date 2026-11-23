import { AppError } from '../../core/errors';
import type { Transcript, TranscriptSegment } from '../types';

/**
 * Memory-aware transcript chunking for a small local model.
 *
 * The 8 GB reference machine runs qwen2.5:1.5b with a 4096-token context.
 * Chunks are sized from num_ctx minus the requested output and a conservative
 * prompt overhead, using ~3 characters per token. Every chunk keeps its real
 * source timestamps; long single segments are split proportionally inside
 * their original time span (no invented timing).
 */

export const MIN_NUM_CTX = 1024;
export const MAX_CHUNKS = 500;
export const CHARS_PER_TOKEN = 3;
export const CHUNK_PROMPT_OVERHEAD_TOKENS = 600;

export interface TranscriptChunk {
  /** Zero-based position in the chunk list. */
  index: number;
  startMs: number;
  endMs: number;
  segments: TranscriptSegment[];
  /** Raw segment text joined by newlines (no timestamp labels). */
  text: string;
  charCount: number;
}

export interface ChunkOptions {
  numCtx: number;
  numPredict: number;
}

/**
 * Character budget for transcript text in one model call.
 * `overheadTokens` covers the system prompt, instructions and time labels.
 */
export function promptCharBudget(
  numCtx: number,
  outputTokens: number,
  overheadTokens: number,
): number {
  const available = numCtx - outputTokens - overheadTokens;
  return Math.max(600, Math.floor(available * CHARS_PER_TOKEN));
}

export function chunkCharBudget(numCtx: number, numPredict: number): number {
  if (!Number.isFinite(numCtx) || numCtx < MIN_NUM_CTX) {
    throw new AppError(
      'INVALID_INPUT',
      `Summarization needs a context window (num_ctx) of at least ${MIN_NUM_CTX} tokens; current value: ${String(numCtx)}.`,
      {
        hint: `Raise the context window in Settings to at least ${MIN_NUM_CTX}. The default 4096 is recommended.`,
      },
    );
  }
  const output = Math.min(
    Math.max(Math.floor(numPredict), 64),
    Math.floor(numCtx / 2),
  );
  return promptCharBudget(numCtx, output, CHUNK_PROMPT_OVERHEAD_TOKENS);
}

function normalizeSegmentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Split text into pieces of at most `budget` characters, preferring spaces. */
function splitByBudget(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (word.length > budget) {
      if (current.length > 0) {
        pieces.push(current);
        current = '';
      }
      for (let offset = 0; offset < word.length; offset += budget) {
        pieces.push(word.slice(offset, offset + budget));
      }
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= budget) {
      current = `${current} ${word}`;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Split a long segment inside its own time span, proportionally by length. */
function splitSegment(
  segment: TranscriptSegment,
  budget: number,
): TranscriptSegment[] {
  const text = normalizeSegmentText(segment.text);
  const pieces = splitByBudget(text, budget);
  if (pieces.length <= 1) return [{ ...segment, text }];
  const span = Math.max(0, segment.endMs - segment.startMs);
  const totalChars = text.length;
  let consumed = 0;
  return pieces.map((piece, index) => {
    const startMs = Math.round(
      segment.startMs + (consumed / totalChars) * span,
    );
    consumed += piece.length;
    const isLast = index === pieces.length - 1;
    const endMs = isLast
      ? segment.endMs
      : Math.round(segment.startMs + (consumed / totalChars) * span);
    return { startMs, endMs: Math.max(startMs, endMs), text: piece };
  });
}

/**
 * Produce ordered chunks that cover the full transcript exactly once.
 * Empty segments are skipped; an empty transcript is an explicit error.
 */
export function chunkTranscript(
  transcript: Transcript,
  options: ChunkOptions,
): TranscriptChunk[] {
  if (
    !transcript ||
    !Array.isArray(transcript.segments) ||
    transcript.segments.length === 0
  ) {
    throw new AppError(
      'INVALID_INPUT',
      'The transcript has no segments to summarize.',
    );
  }
  const budget = chunkCharBudget(options.numCtx, options.numPredict);

  const source = transcript.segments
    .filter(
      (segment) =>
        segment &&
        Number.isFinite(segment.startMs) &&
        Number.isFinite(segment.endMs) &&
        typeof segment.text === 'string' &&
        normalizeSegmentText(segment.text).length > 0,
    )
    .map((segment) => ({
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: Math.max(0, Math.round(segment.endMs)),
      text: normalizeSegmentText(segment.text),
    }))
    .sort((a, b) => a.startMs - b.startMs);
  if (source.length === 0) {
    throw new AppError(
      'INVALID_INPUT',
      'The transcript contains no readable text to summarize.',
    );
  }

  const chunks: TranscriptChunk[] = [];
  let current: TranscriptSegment[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const text = current.map((segment) => segment.text).join('\n');
    chunks.push({
      index: chunks.length,
      startMs: first.startMs,
      endMs: last.endMs,
      segments: current,
      text,
      charCount: text.length,
    });
    current = [];
    currentChars = 0;
  };

  for (const segment of source) {
    const pieces =
      segment.text.length > budget
        ? splitSegment(segment, budget)
        : [segment];
    for (const piece of pieces) {
      const pieceChars = piece.text.length;
      if (currentChars > 0 && currentChars + 1 + pieceChars > budget) {
        flush();
      }
      current.push(piece);
      currentChars += pieceChars + (current.length > 1 ? 1 : 0);
      if (currentChars >= budget) flush();
    }
  }
  flush();

  if (chunks.length > MAX_CHUNKS) {
    throw new AppError(
      'INVALID_INPUT',
      `The transcript needs ${chunks.length} model calls, which exceeds the limit of ${MAX_CHUNKS}.`,
      {
        hint: 'Summarize a shorter recording, or raise the context window in Settings so fewer chunks are needed.',
      },
    );
  }
  return chunks;
}
