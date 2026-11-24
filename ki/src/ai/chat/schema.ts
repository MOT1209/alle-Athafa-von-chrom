import { AppError } from '../../core/errors';

/**
 * Strict schema for a grounded chat answer.
 *
 * The model returns an answer plus the numbers of the passages it used. It is
 * never asked for timestamps: citations are resolved from those passage
 * numbers against the real retrieved segments, so a wrong citation cannot be
 * invented by a small model. Anything that does not match this shape is
 * rejected with a retryable BAD_RESPONSE and never stored or shown.
 */

export interface ChatCitation {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ChatAnswer {
  found: boolean;
  answer: string;
  /** 1-based passage numbers, sorted and de-duplicated. */
  usedSources: number[];
}

export const MAX_ANSWER_CHARS = 2000;
export const MAX_SOURCES_USED = 4;

function invalid(problem: string, detail?: unknown): AppError {
  return new AppError(
    'BAD_RESPONSE',
    `The local model returned an invalid chat answer: ${problem}`,
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

function normalizeAnswer(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalid('the response was empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('the response was not valid JSON', {
      preview: raw.slice(0, 160),
    });
  }
  if (!isRecord(parsed)) {
    throw invalid('the response was not a JSON object', {
      preview: raw.slice(0, 160),
    });
  }
  return parsed;
}

/**
 * Validate one model reply against the number of passages that were supplied.
 * `sourceCount` bounds `usedSources` so a citation always maps to a real
 * passage; an out-of-range number is a rejected reply, not a guess.
 */
export function parseChatAnswer(raw: string, sourceCount: number): ChatAnswer {
  const source = parseJsonObject(raw);

  const found = source.found;
  if (typeof found !== 'boolean') {
    throw invalid('"found" must be true or false');
  }

  const rawAnswer = source.answer;
  if (
    rawAnswer !== undefined &&
    rawAnswer !== null &&
    typeof rawAnswer !== 'string'
  ) {
    throw invalid('"answer" must be a string');
  }
  const answer = typeof rawAnswer === 'string' ? normalizeAnswer(rawAnswer) : '';

  const rawSources = source.usedSources;
  const entries = rawSources === undefined ? [] : rawSources;
  if (!Array.isArray(entries)) {
    throw invalid('"usedSources" must be an array of passage numbers');
  }

  const seen = new Set<number>();
  const usedSources: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      throw invalid('every used source must be an integer passage number');
    }
    if (entry < 1 || entry > sourceCount) {
      throw invalid(`passage ${entry} is outside 1..${sourceCount}`);
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    usedSources.push(entry);
  }
  usedSources.sort((a, b) => a - b);
  if (usedSources.length > MAX_SOURCES_USED) {
    throw invalid(`at most ${MAX_SOURCES_USED} sources can be used`);
  }

  if (!found) {
    // The refusal text is deliberately discarded; the UI shows a localized
    // "not covered in the transcript" message so both languages stay honest.
    return { found: false, answer: '', usedSources: [] };
  }

  if (answer.length === 0) {
    throw invalid('"answer" is required when "found" is true');
  }
  if (answer.length > MAX_ANSWER_CHARS) {
    throw invalid(`"answer" is longer than ${MAX_ANSWER_CHARS} characters`);
  }
  if (usedSources.length === 0) {
    throw invalid('at least one used passage is required when "found" is true');
  }

  return { found: true, answer, usedSources };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Shared with the chat repository when validating stored citations. */
export function isChatCitation(value: unknown): value is ChatCitation {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.startMs) &&
    isNonNegativeNumber(value.endMs) &&
    value.endMs >= value.startMs &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0
  );
}
