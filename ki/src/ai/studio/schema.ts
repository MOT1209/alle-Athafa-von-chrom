import { AppError } from '../../core/errors';

export interface StorySegment {
  text: string;
  emotion?: string;
}

export interface KidsStory {
  title: string;
  segments: StorySegment[];
}

export const MAX_TITLE_CHARS = 120;
export const MAX_SEGMENT_CHARS = 400;
export const MAX_SEGMENTS = 12;

function invalid(problem: string): AppError {
  return new AppError('BAD_RESPONSE', `Invalid kids story: ${problem}`, { retryable: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseKidsStory(raw: string): KidsStory {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw invalid('empty response');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid('not valid JSON'); }
  if (!isRecord(parsed)) throw invalid('not an object');
  for (const key of Object.keys(parsed)) {
    if (key !== 'title' && key !== 'segments') throw invalid(`unexpected key ${key}`);
  }
  if (typeof parsed.title !== 'string' || parsed.title.trim().length === 0) throw invalid('title required');
  const title = parsed.title.replace(/\s+/g, ' ').trim();
  if (title.length > MAX_TITLE_CHARS) throw invalid('title too long');
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) throw invalid('segments required');
  if (parsed.segments.length > MAX_SEGMENTS) throw invalid('too many segments');

  const segments: StorySegment[] = [];
  for (const entry of parsed.segments) {
    if (!isRecord(entry) || typeof entry.text !== 'string') throw invalid('segment must have text');
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > MAX_SEGMENT_CHARS) throw invalid('segment text invalid');
    const seg: StorySegment = { text };
    if (typeof entry.emotion === 'string') seg.emotion = entry.emotion.trim();
    segments.push(seg);
  }
  return { title, segments };
}