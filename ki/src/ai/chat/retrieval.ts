import type { Transcript, TranscriptSegment } from '../types';
import { indexTerms } from './text';

/**
 * Offline retrieval over a stored transcript.
 *
 * The transcript is grouped into overlapping windows of consecutive segments.
 * Each window keeps the real segment timestamps, so every citation shown in
 * the UI comes from the transcript itself — never from the language model.
 * Ranking is BM25 over normalized stems: no embedding model, no network.
 */

export const WINDOW_TARGET_CHARS = 700;
export const WINDOW_OVERLAP_CHARS = 140;
export const MAX_RETRIEVED_PASSAGES = 4;
/** A multi-term question must share at least this many distinct terms. */
export const MIN_DISTINCT_MATCHES = 2;
/** Passages scoring below this fraction of the best passage are dropped. */
export const MIN_RELATIVE_SCORE = 0.2;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface TranscriptWindow {
  /** Zero-based position in the transcript window list. */
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  segments: TranscriptSegment[];
}

export interface RetrievedPassage extends TranscriptWindow {
  score: number;
  /** Distinct question terms found in this passage. */
  matchedTerms: number;
}

export interface RetrievalOptions {
  targetChars?: number;
  overlapChars?: number;
  maxPassages?: number;
  minMatches?: number;
  relativeScoreCutoff?: number;
}

function normalizeSegmentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Build overlapping windows that cover every segment once, in order.
 * Windows never invent timestamps: start/end come from the segments they hold.
 */
export function buildWindows(
  transcript: Transcript,
  options: { targetChars?: number; overlapChars?: number } = {},
): TranscriptWindow[] {
  const segments = transcript.segments
    .map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: normalizeSegmentText(segment.text),
    }))
    .filter((segment) => segment.text.length > 0);
  if (segments.length === 0) return [];

  const target = Math.max(
    200,
    Math.floor(options.targetChars ?? WINDOW_TARGET_CHARS),
  );
  const overlap = Math.min(
    Math.max(0, Math.floor(options.overlapChars ?? WINDOW_OVERLAP_CHARS)),
    Math.floor(target / 2),
  );

  const windows: TranscriptWindow[] = [];
  let start = 0;
  while (start < segments.length) {
    let chars = 0;
    let end = start;
    while (end < segments.length) {
      const segment = segments[end];
      if (!segment) break;
      chars += segment.text.length + 1;
      end += 1;
      if (chars >= target) break;
    }

    const slice = segments.slice(start, end);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first && last) {
      windows.push({
        index: windows.length,
        startMs: first.startMs,
        endMs: last.endMs,
        text: slice.map((segment) => segment.text).join(' '),
        segments: slice,
      });
    }

    if (end >= segments.length) break;

    // Carry a short tail into the next window so a fact cut by the boundary
    // stays retrievable, while guaranteeing forward progress.
    let next = end;
    let tailChars = 0;
    while (next > start + 1) {
      const segment = segments[next - 1];
      if (!segment) break;
      const length = segment.text.length + 1;
      if (tailChars + length > overlap) break;
      tailChars += length;
      next -= 1;
    }
    start = Math.max(next, start + 1);
  }
  return windows;
}

/** Deduplicated, stopword-free, stemmed question terms. */
export function queryTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of indexTerms(question)) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/**
 * Rank windows against the question. Returns an empty list when the transcript
 * has no meaningful overlap with the question — the honest "not in the video"
 * path, resolved before any model call.
 */
export function searchPassages(
  windows: TranscriptWindow[],
  question: string,
  options: RetrievalOptions = {},
): RetrievedPassage[] {
  const terms = queryTerms(question);
  if (windows.length === 0 || terms.length === 0) return [];

  const documents = windows.map((window) => indexTerms(window.text));
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    totalLength += document.length;
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = totalLength / Math.max(1, documents.length);

  const scored: RetrievedPassage[] = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const document = documents[index];
    if (!window || !document || document.length === 0) continue;

    const frequencies = new Map<string, number>();
    for (const term of document) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }

    let score = 0;
    let matchedTerms = 0;
    for (const term of terms) {
      const count = frequencies.get(term);
      if (count === undefined) continue;
      matchedTerms += 1;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(
        1 + (windows.length - df + 0.5) / (df + 0.5),
      );
      const denominator =
        count +
        BM25_K1 *
          (1 - BM25_B + (BM25_B * document.length) / Math.max(1, averageLength));
      score += idf * ((count * (BM25_K1 + 1)) / Math.max(denominator, 1e-9));
    }
    if (matchedTerms === 0) continue;
    scored.push({ ...window, score, matchedTerms });
  }

  const minMatches =
    options.minMatches ?? (terms.length === 1 ? 1 : MIN_DISTINCT_MATCHES);
  const kept = scored.filter(
    (passage) => passage.score > 0 && passage.matchedTerms >= minMatches,
  );
  kept.sort((a, b) => b.score - a.score || a.startMs - b.startMs);

  const maxPassages = Math.max(1, options.maxPassages ?? MAX_RETRIEVED_PASSAGES);
  const top = kept.slice(0, maxPassages);
  const best = top[0];
  if (!best) return [];
  const cutoff = best.score * (options.relativeScoreCutoff ?? MIN_RELATIVE_SCORE);
  return top.filter((passage) => passage.score >= cutoff);
}

/**
 * Pick the segment inside a window that best matches the question.
 * Deterministic: the model never supplies timestamps.
 */
export function bestSegment(
  window: TranscriptWindow,
  question: string,
): TranscriptSegment | undefined {
  const terms = new Set(queryTerms(question));
  let best: TranscriptSegment | undefined;
  let bestHits = -1;
  for (const segment of window.segments) {
    let hits = 0;
    for (const term of new Set(indexTerms(segment.text))) {
      if (terms.has(term)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = segment;
    }
  }
  return best;
}
