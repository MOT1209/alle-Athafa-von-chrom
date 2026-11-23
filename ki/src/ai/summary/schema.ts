import { AppError } from '../../core/errors';
import { parseTimestampMs } from './time';

/**
 * Strict schemas for model output. Summaries are shown to the user as fact,
 * so anything that does not match the expected shape is rejected with a
 * retryable BAD_RESPONSE. The summarizer retries internally and the queue
 * retries the task; an invalid result is never stored or displayed.
 */

export interface SummaryKeyPoint {
  timestampMs: number;
  text: string;
}

export interface SummaryChapter {
  startMs: number;
  title: string;
  summary?: string;
}

export interface StructuredSummary {
  overview: string;
  keyPoints: SummaryKeyPoint[];
  chapters: SummaryChapter[];
}

/** Intermediate notes exchanged between map and reduce calls. */
export interface TranscriptNotes {
  summary: string;
  keyPoints: SummaryKeyPoint[];
}

export const MAX_OVERVIEW_CHARS = 4000;
export const MAX_NOTE_SUMMARY_CHARS = 3000;
export const MAX_KEY_POINT_CHARS = 500;
export const MAX_CHAPTER_TITLE_CHARS = 200;
export const MAX_CHAPTER_SUMMARY_CHARS = 1000;
export const MAX_KEY_POINTS = 30;
export const MAX_CHAPTERS = 20;
export const MAX_NOTES_KEY_POINTS = 12;

const TIMESTAMP_KEYS = ['timestampMs', 'timestamp', 'startMs', 'start', 'time'] as const;

function invalid(stage: string, problem: string, detail?: unknown): AppError {
  return new AppError(
    'BAD_RESPONSE',
    `The local model returned an invalid ${stage}: ${problem}`,
    {
      retryable: true,
      hint: 'The invalid result was discarded and will be retried automatically. If this keeps happening, try a more capable model or a larger context window.',
      ...(detail === undefined ? {} : { detail }),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readText(
  source: Record<string, unknown>,
  key: string,
  options: { max: number; required: boolean; stage: string },
): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (options.required) throw invalid(options.stage, `"${key}" is required`);
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw invalid(options.stage, `"${key}" must be a string`);
  }
  const text = normalizeText(raw);
  if (text.length === 0) {
    if (options.required) throw invalid(options.stage, `"${key}" is empty`);
    return undefined;
  }
  if (text.length > options.max) {
    throw invalid(
      options.stage,
      `"${key}" is longer than ${options.max} characters`,
    );
  }
  return text;
}

function readTimestamp(
  source: Record<string, unknown>,
  maxTimestampMs: number,
  stage: string,
): number {
  let raw: unknown;
  for (const key of TIMESTAMP_KEYS) {
    if (key in source) {
      raw = source[key];
      break;
    }
  }
  if (raw === undefined) {
    throw invalid(stage, 'a timestamp is required');
  }
  const ms = parseTimestampMs(raw);
  if (ms === undefined) {
    throw invalid(
      stage,
      'timestamp must be milliseconds or a clock value like 12:34',
    );
  }
  if (ms > maxTimestampMs) {
    throw invalid(
      stage,
      `timestamp ${ms} ms is beyond the end of the video (${maxTimestampMs} ms)`,
    );
  }
  return ms;
}

function readKeyPoints(
  source: Record<string, unknown>,
  options: {
    stage: string;
    maxTimestampMs: number;
    max: number;
    min: number;
  },
): SummaryKeyPoint[] {
  const raw = source.keyPoints;
  if (!Array.isArray(raw)) {
    throw invalid(options.stage, '"keyPoints" must be an array');
  }
  if (raw.length < options.min) {
    throw invalid(
      options.stage,
      `"keyPoints" must contain at least ${options.min} point(s)`,
    );
  }
  if (raw.length > options.max) {
    throw invalid(
      options.stage,
      `"keyPoints" must contain at most ${options.max} points`,
    );
  }
  const seen = new Set<string>();
  const points: SummaryKeyPoint[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      throw invalid(options.stage, 'each key point must be an object');
    }
    const timestampMs = readTimestamp(
      entry,
      options.maxTimestampMs,
      options.stage,
    );
    const text = readText(entry, 'text', {
      max: MAX_KEY_POINT_CHARS,
      required: true,
      stage: options.stage,
    });
    if (text === undefined) continue;
    const dedupeKey = `${timestampMs}|${text.toLocaleLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    points.push({ timestampMs, text });
  }
  return points.sort((a, b) => a.timestampMs - b.timestampMs);
}

function parseJsonObject(raw: string, stage: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalid(stage, 'the response was empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid(stage, 'the response was not valid JSON', {
      preview: raw.slice(0, 160),
    });
  }
  if (!isRecord(parsed)) {
    throw invalid(stage, 'the response was not a JSON object', {
      preview: raw.slice(0, 160),
    });
  }
  return parsed;
}

/** Parse and validate one map/merge call's notes. */
export function parseMapNotes(
  raw: string,
  maxTimestampMs: number,
): TranscriptNotes {
  const stage = 'transcript notes';
  const source = parseJsonObject(raw, stage);
  const summary = readText(source, 'summary', {
    max: MAX_NOTE_SUMMARY_CHARS,
    required: true,
    stage,
  });
  if (summary === undefined) throw invalid(stage, '"summary" is required');
  return {
    summary,
    keyPoints: readKeyPoints(source, {
      stage,
      maxTimestampMs,
      max: MAX_NOTES_KEY_POINTS,
      min: 0,
    }),
  };
}

/** Parse and validate the final structured summary. */
export function parseStructuredSummary(
  raw: string,
  maxTimestampMs: number,
): StructuredSummary {
  const stage = 'summary';
  const source = parseJsonObject(raw, stage);
  const overview = readText(source, 'overview', {
    max: MAX_OVERVIEW_CHARS,
    required: true,
    stage,
  });
  if (overview === undefined) throw invalid(stage, '"overview" is required');

  const keyPoints = readKeyPoints(source, {
    stage,
    maxTimestampMs,
    max: MAX_KEY_POINTS,
    min: 1,
  });

  const rawChapters = source.chapters;
  if (!Array.isArray(rawChapters)) {
    throw invalid(stage, '"chapters" must be an array');
  }
  if (rawChapters.length < 1) {
    throw invalid(stage, '"chapters" must contain at least one chapter');
  }
  if (rawChapters.length > MAX_CHAPTERS) {
    throw invalid(
      stage,
      `"chapters" must contain at most ${MAX_CHAPTERS} chapters`,
    );
  }
  const seenStarts = new Set<number>();
  const chapters: SummaryChapter[] = [];
  for (const entry of rawChapters) {
    if (!isRecord(entry)) {
      throw invalid(stage, 'each chapter must be an object');
    }
    const startMs = readTimestamp(entry, maxTimestampMs, stage);
    const title = readText(entry, 'title', {
      max: MAX_CHAPTER_TITLE_CHARS,
      required: true,
      stage,
    });
    if (title === undefined) continue;
    const chapterSummary = readText(entry, 'summary', {
      max: MAX_CHAPTER_SUMMARY_CHARS,
      required: false,
      stage,
    });
    if (seenStarts.has(startMs)) continue;
    seenStarts.add(startMs);
    const chapter: SummaryChapter = { startMs, title };
    if (chapterSummary !== undefined) chapter.summary = chapterSummary;
    chapters.push(chapter);
  }
  chapters.sort((a, b) => a.startMs - b.startMs);

  return { overview, keyPoints, chapters };
}

/** Shared by the repository and the service when validating stored data. */
export function isSummaryKeyPoint(value: unknown): value is SummaryKeyPoint {
  return (
    isRecord(value) &&
    typeof value.timestampMs === 'number' &&
    Number.isFinite(value.timestampMs) &&
    value.timestampMs >= 0 &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0
  );
}

export function isSummaryChapter(value: unknown): value is SummaryChapter {
  return (
    isRecord(value) &&
    typeof value.startMs === 'number' &&
    Number.isFinite(value.startMs) &&
    value.startMs >= 0 &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    (value.summary === undefined || typeof value.summary === 'string')
  );
}
