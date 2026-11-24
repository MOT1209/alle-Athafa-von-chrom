import { indexTerms } from '../ai/chat/text';
import type { VideoRecord } from '../capture/videos';
import { normalizeSegmentText } from './editor';

/**
 * Local, segment-level search over every stored transcript. Matching reuses
 * the same AR/EN normalization and light stemming as chat retrieval, so Arabic
 * diacritics/alef variants and English plurals behave consistently. No index is
 * persisted: transcripts are read from local records and searched in memory.
 */

export interface TranscriptSearchHit {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  language?: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  /** Bounded excerpt around the first match. */
  text: string;
  score: number;
}

export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 100;
const SNIPPET_CHARS = 320;
const SNIPPET_LEAD_WORDS = 8;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(value)));
}

function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of indexTerms(query)) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function snippetFor(text: string, terms: ReadonlySet<string>): string {
  const clean = normalizeSegmentText(text);
  if (clean.length <= SNIPPET_CHARS) return clean;

  const words = clean.split(' ');
  let offset = 0;
  let matchOffset = -1;
  for (const word of words) {
    if (indexTerms(word).some((term) => terms.has(term))) {
      matchOffset = offset;
      break;
    }
    offset += word.length + 1;
  }

  let start = 0;
  if (matchOffset > 0) {
    start = Math.max(0, matchOffset - 60);
    const space = clean.indexOf(' ', start);
    if (space !== -1 && space < matchOffset) start = space + 1;
  }
  let end = Math.min(clean.length, start + SNIPPET_CHARS);
  if (end < clean.length) {
    const space = clean.lastIndexOf(' ', end);
    if (space > start + 40) end = space;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

/**
 * Score every segment by how many distinct query stems it contains, with a
 * bonus for the exact phrase. Multi-word queries keep precision: three or more
 * terms need at least two matches.
 */
export function searchTranscripts(
  records: readonly VideoRecord[],
  query: string,
  limit?: number,
): TranscriptSearchHit[] {
  if (typeof query !== 'string') return [];
  const normalizedQuery = normalizeSegmentText(query);
  if (normalizedQuery.length === 0) return [];
  const terms = queryTerms(normalizedQuery);
  if (terms.length === 0) return [];
  const termSet = new Set(terms);
  const phrase = normalizedQuery.toLocaleLowerCase();
  const required = terms.length >= 3 ? 2 : 1;
  const max = clampLimit(limit);

  const scored: Array<{ hit: TranscriptSearchHit; recordIndex: number }> = [];
  records.forEach((record, recordIndex) => {
    record.transcript.segments.forEach((segment, segmentIndex) => {
      if (segment.text.trim().length === 0) return;
      const segmentTerms = new Set(indexTerms(segment.text));
      let matched = 0;
      for (const term of terms) {
        if (segmentTerms.has(term)) matched += 1;
      }
      if (matched < required) return;
      const exactPhrase =
        terms.length > 1 &&
        normalizeSegmentText(segment.text).toLocaleLowerCase().includes(phrase);
      const score =
        (matched / terms.length) * 100 + (exactPhrase ? 25 : 0);
      const hit: TranscriptSearchHit = {
        videoRecordId: record.id,
        videoTitle: record.title,
        videoUrl: record.url,
        ...(record.language === undefined ? {} : { language: record.language }),
        segmentIndex,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: snippetFor(segment.text, termSet),
        score: Math.round(score * 100) / 100,
      };
      scored.push({ hit, recordIndex });
    });
  });

  scored.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    if (a.recordIndex !== b.recordIndex) return a.recordIndex - b.recordIndex;
    return a.hit.segmentIndex - b.hit.segmentIndex;
  });
  return scored.slice(0, max).map((entry) => entry.hit);
}

/** True when the leading words before the excerpt were trimmed. */
export function isLeadingSnippet(text: string): boolean {
  return text.startsWith('…');
}

/** Number of words skipped from the left (used by the UI for a short hint). */
export function snippetLeadWords(): number {
  return SNIPPET_LEAD_WORDS;
}
