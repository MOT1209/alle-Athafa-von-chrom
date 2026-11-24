import type { Transcript, TranscriptSegment } from '../ai/types';
import { AppError } from '../core/errors';

/**
 * Transcript editing and change detection.
 *
 * Only segment text is editable; timestamps are owned by the capture and never
 * move. A stable signature over the segments lets translations detect that the
 * source text changed, so stale work can be flagged instead of silently shown
 * as current.
 */

export const MAX_SEGMENT_CHARS = 5000;
export const MAX_SEGMENTS = 5000;

export function normalizeSegmentText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const segment = value as Record<string, unknown>;
  return (
    typeof segment.startMs === 'number' &&
    Number.isFinite(segment.startMs) &&
    segment.startMs >= 0 &&
    typeof segment.endMs === 'number' &&
    Number.isFinite(segment.endMs) &&
    segment.endMs >= segment.startMs &&
    typeof segment.text === 'string' &&
    normalizeSegmentText(segment.text).length > 0
  );
}

export function isTranscript(value: unknown): value is Transcript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const transcript = value as Record<string, unknown>;
  if (
    !Array.isArray(transcript.segments) ||
    transcript.segments.length === 0 ||
    transcript.segments.length > MAX_SEGMENTS ||
    !transcript.segments.every(isTranscriptSegment) ||
    typeof transcript.text !== 'string' ||
    (transcript.source !== 'captions' &&
      transcript.source !== 'stt' &&
      transcript.source !== 'user-file') ||
    (transcript.language !== undefined &&
      typeof transcript.language !== 'string')
  ) {
    return false;
  }
  return true;
}

export function assertTranscript(
  value: unknown,
  message = 'The transcript is invalid',
): asserts value is Transcript {
  if (!isTranscript(value)) {
    throw new AppError('INVALID_INPUT', message, {
      hint: 'The stored transcript is missing readable timestamped segments.',
    });
  }
}

/** Rebuild the joined plain-text view from the segment list. */
export function rebuildTranscriptText(
  segments: readonly TranscriptSegment[],
): string {
  return segments.map((segment) => segment.text).join('\n');
}

/**
 * Stable content signature (cyrb53). It changes when any timestamp or text
 * changes and is short enough to persist as metadata.
 */
export function transcriptSignature(transcript: Transcript): string {
  const parts: string[] = [
    `v1|${transcript.language ?? ''}|${transcript.source}|${transcript.segments.length}`,
  ];
  for (const segment of transcript.segments) {
    const text = normalizeSegmentText(segment.text);
    parts.push(`${segment.startMs}|${segment.endMs}|${text.length}|${text}`);
  }
  return `v1:${hash53(parts.join('\n')).toString(36)}`;
}

function hash53(value: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0);
}

export interface EditSegmentResult {
  transcript: Transcript;
  changed: boolean;
}

/**
 * Replace one segment's text. The segment's time span and every other segment
 * stay byte-identical; the joined transcript text is rebuilt.
 */
export function updateSegmentText(
  transcript: Transcript,
  index: number,
  text: string,
): EditSegmentResult {
  assertTranscript(transcript, 'The transcript cannot be edited because it is invalid');
  if (!Number.isInteger(index) || index < 0 || index >= transcript.segments.length) {
    throw new AppError(
      'INVALID_INPUT',
      `Segment ${String(index)} is outside the transcript`,
    );
  }
  if (typeof text !== 'string') {
    throw new AppError('INVALID_INPUT', 'The segment text must be a string');
  }
  const normalized = normalizeSegmentText(text);
  if (normalized.length === 0) {
    throw new AppError('INVALID_INPUT', 'The segment text cannot be empty', {
      hint: 'Type the corrected text, or delete the video if the segment should not exist.',
    });
  }
  if (normalized.length > MAX_SEGMENT_CHARS) {
    throw new AppError(
      'INVALID_INPUT',
      `The segment text is longer than ${MAX_SEGMENT_CHARS} characters`,
      { hint: 'Shorten the text and try again.' },
    );
  }

  const current = transcript.segments[index];
  if (!current) {
    throw new AppError(
      'INVALID_INPUT',
      `Segment ${String(index)} is outside the transcript`,
    );
  }
  if (current.text === normalized) {
    return { transcript, changed: false };
  }

  const segments = transcript.segments.map((segment, segmentIndex) =>
    segmentIndex === index ? { ...segment, text: normalized } : segment,
  );
  const next: Transcript = {
    ...transcript,
    segments,
    text: rebuildTranscriptText(segments),
  };
  return { transcript: next, changed: true };
}
