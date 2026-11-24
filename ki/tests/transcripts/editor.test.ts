import { describe, expect, it } from 'vitest';
import {
  isTranscript,
  normalizeSegmentText,
  rebuildTranscriptText,
  transcriptSignature,
  updateSegmentText,
  assertTranscript,
} from '../../src/transcripts/editor';
import { AppError } from '../../src/core/errors';
import { segmentsToTranscript } from '../../src/youtube/transcript';

describe('transcripts/editor', () => {
  it('normalizes whitespace', () => {
    expect(normalizeSegmentText('  a   b \n c  ')).toBe('a b c');
  });

  it('validates transcripts', () => {
    const t = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'hello' }],
      'en',
    );
    expect(isTranscript(t)).toBe(true);
    expect(isTranscript({})).toBe(false);
    expect(isTranscript(null)).toBe(false);
  });

  it('assertTranscript throws on invalid', () => {
    expect(() => assertTranscript({})).toThrow(AppError);
  });

  it('rebuilds text', () => {
    const t = segmentsToTranscript(
      [
        { startMs: 0, endMs: 1000, text: 'a' },
        { startMs: 1000, endMs: 2000, text: 'b' },
      ],
      'en',
    );
    expect(rebuildTranscriptText(t.segments)).toBe('a\nb');
  });

  it('signature is stable and changes with text', () => {
    const t1 = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'hello' }],
      'en',
    );
    const t2 = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'hello' }],
      'en',
    );
    const t3 = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'world' }],
      'en',
    );
    expect(transcriptSignature(t1)).toBe(transcriptSignature(t2));
    expect(transcriptSignature(t1)).not.toBe(transcriptSignature(t3));
  });

  it('updates segment text without changing timestamps', () => {
    const t = segmentsToTranscript(
      [{ startMs: 5, endMs: 10, text: 'old' }],
      'en',
    );
    const result = updateSegmentText(t, 0, '  new  text ');
    expect(result.changed).toBe(true);
    expect(result.transcript.segments[0]?.text).toBe('new text');
    expect(result.transcript.segments[0]?.startMs).toBe(5);
    expect(result.transcript.segments[0]?.endMs).toBe(10);
    expect(result.transcript.text).toBe('new text');
  });

  it('rejects empty and too-long text', () => {
    const t = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'old' }],
      'en',
    );
    expect(() => updateSegmentText(t, 0, '   ')).toThrow(AppError);
    expect(() => updateSegmentText(t, 0, 'x'.repeat(5001))).toThrow(AppError);
  });

  it('rejects out-of-range index', () => {
    const t = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'old' }],
      'en',
    );
    expect(() => updateSegmentText(t, 5, 'x')).toThrow(AppError);
  });

  it('returns unchanged when text identical', () => {
    const t = segmentsToTranscript(
      [{ startMs: 0, endMs: 1000, text: 'same' }],
      'en',
    );
    const result = updateSegmentText(t, 0, 'same');
    expect(result.changed).toBe(false);
  });
});