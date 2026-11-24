import { AppError } from '../../core/errors';
import { normalizeSegmentText } from '../../transcripts/editor';

/**
 * Strict schema for one translation batch. The model must return a JSON object
 * of the form {"segments":[{"key":"0","text":"..."}]} containing exactly the
 * requested keys, no duplicates, and no extras. Timestamps are never part of
 * the model output: the caller copies them from the source segments.
 */

export const MAX_TRANSLATED_SEGMENT_CHARS = 5000;

export interface TranslatedSegment {
  key: string;
  text: string;
}

export interface TranslationBatchResult {
  segments: TranslatedSegment[];
}

function invalid(problem: string, detail?: unknown): AppError {
  return new AppError('BAD_RESPONSE', `The local model returned an invalid translation: ${problem}`, {
    retryable: true,
    hint: 'The invalid result was discarded and will be retried automatically. If this keeps happening, try a more capable model or a larger context window.',
    ...(detail === undefined ? {} : { detail }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTranslationBatch(
  raw: string,
  expectedKeys: readonly string[],
): TranslationBatchResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalid('the response was empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('the response was not valid JSON', { preview: raw.slice(0, 160) });
  }
  if (!isRecord(parsed)) {
    throw invalid('the response was not a JSON object', { preview: raw.slice(0, 160) });
  }
  const segmentsRaw = parsed.segments;
  if (!Array.isArray(segmentsRaw)) {
    throw invalid('"segments" must be an array');
  }

  const expected = new Set(expectedKeys);
  if (expected.size !== expectedKeys.length) {
    throw invalid('duplicate expected keys');
  }
  const seen = new Set<string>();
  const segments: TranslatedSegment[] = [];
  for (const entry of segmentsRaw) {
    if (!isRecord(entry)) {
      throw invalid('each segment must be an object');
    }
    if (typeof entry.key !== 'string' || entry.key.trim().length === 0) {
      throw invalid('each segment must have a non-empty string "key"');
    }
    const key = entry.key.trim();
    if (!expected.has(key)) {
      throw invalid(`unexpected key "${key}"`);
    }
    if (seen.has(key)) {
      throw invalid(`duplicate key "${key}"`);
    }
    if (typeof entry.text !== 'string') {
      throw invalid(`"text" for key "${key}" must be a string`);
    }
    const text = normalizeSegmentText(entry.text);
    if (text.length === 0) {
      throw invalid(`"text" for key "${key}" is empty`);
    }
    if (text.length > MAX_TRANSLATED_SEGMENT_CHARS) {
      throw invalid(
        `"text" for key "${key}" is longer than ${MAX_TRANSLATED_SEGMENT_CHARS} characters`,
      );
    }
    seen.add(key);
    segments.push({ key, text });
  }

  if (seen.size !== expected.size) {
    const missing = expectedKeys.filter((key) => !seen.has(key));
    throw invalid(`missing keys: ${missing.join(', ')}`);
  }
  // Reject any extra top-level keys beyond "segments".
  for (const key of Object.keys(parsed)) {
    if (key !== 'segments') {
      throw invalid(`unexpected top-level key "${key}"`);
    }
  }

  return { segments };
}