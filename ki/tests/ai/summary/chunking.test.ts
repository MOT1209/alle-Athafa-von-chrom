import { describe, expect, it } from 'vitest';
import {
  chunkCharBudget,
  chunkTranscript,
  promptCharBudget,
  MAX_CHUNKS,
  MIN_NUM_CTX,
} from '../../../src/ai/summary/chunking';
import type { Transcript, TranscriptSegment } from '../../../src/ai/types';

function transcriptOf(segments: TranscriptSegment[]): Transcript {
  return {
    segments,
    text: segments.map((segment) => segment.text).join('\n'),
    source: 'captions',
  };
}

function words(length: number, word = 'word'): string {
  let text = '';
  while (text.length < length) {
    text += text.length === 0 ? word : ` ${word}`;
  }
  return text.slice(0, length).trimEnd();
}

describe('promptCharBudget', () => {
  it('reserves output and overhead tokens', () => {
    expect(promptCharBudget(4096, 512, 600)).toBe(8952);
    expect(promptCharBudget(2048, 512, 350)).toBe(3558);
  });

  it('clamps to a usable minimum instead of going negative', () => {
    expect(promptCharBudget(1024, 900, 600)).toBe(600);
    expect(promptCharBudget(100, 100, 100)).toBe(600);
  });
});

describe('chunkCharBudget', () => {
  it('computes the default 4096-context budget', () => {
    expect(chunkCharBudget(4096, 512)).toBe(8952);
  });

  it('caps the output reservation at half the context', () => {
    // numPredict above half the context is clamped to numCtx / 2.
    expect(chunkCharBudget(4096, 100_000)).toBe(4344);
  });

  it('clamps tiny output reservations to a useful minimum', () => {
    expect(chunkCharBudget(1024, 1)).toBe(1080);
  });

  it('rejects contexts below the minimum', () => {
    expectBadInput(() => chunkCharBudget(MIN_NUM_CTX - 1, 512));
    expectBadInput(() => chunkCharBudget(Number.NaN, 512));
  });
});

function expectBadInput(fn: () => unknown): void {
  expect(fn).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
}

describe('chunkTranscript', () => {
  it('rejects a transcript without segments or readable text', () => {
    expectBadInput(() => chunkTranscript(transcriptOf([]), { numCtx: 4096, numPredict: 512 }));
    expectBadInput(() =>
      chunkTranscript(
        transcriptOf([
          { startMs: 0, endMs: 1000, text: '   ' },
          { startMs: 1000, endMs: 2000, text: '' },
        ]),
        { numCtx: 4096, numPredict: 512 },
      ),
    );
  });

  it('keeps small transcripts in one chunk with real boundaries', () => {
    const chunks = chunkTranscript(
      transcriptOf([
        { startMs: 0, endMs: 2000, text: ' First  part ' },
        { startMs: 2000, endMs: 4000, text: 'Second\tpart' },
      ]),
      { numCtx: 4096, numPredict: 512 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      startMs: 0,
      endMs: 4000,
      text: 'First part\nSecond part',
    });
  });

  it('splits text when the budget is exceeded and covers every segment once', () => {
    const chunks = chunkTranscript(
      transcriptOf([
        { startMs: 0, endMs: 10_000, text: words(400) },
        { startMs: 10_000, endMs: 20_000, text: words(400) },
        { startMs: 20_000, endMs: 30_000, text: words(400) },
      ]),
      { numCtx: 1024, numPredict: 512 },
    );
    // Each ~399-character segment cannot share a 600-character chunk.
    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.charCount).reduce((a, b) => a + b, 0))
      .toBeGreaterThan(0);
    expect(chunks[0]?.startMs).toBe(0);
    expect(chunks[chunks.length - 1]?.endMs).toBe(30_000);
    expect(chunks.every((chunk) => chunk.charCount <= 600)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('\n')).toBe(
      [words(400), words(400), words(400)].join('\n'),
    );
  });

  it('splits a long segment proportionally inside its own time span', () => {
    const text = words(1200);
    const chunks = chunkTranscript(
      transcriptOf([{ startMs: 10_000, endMs: 40_000, text }]),
      { numCtx: 1024, numPredict: 512 },
    );
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.startMs).toBe(10_000);
    expect(chunks[1]?.endMs).toBe(40_000);
    // The pieces are not exactly equal, so the boundary is proportional to
    // their real character counts (about half of the 30 s span), never
    // invented beyond it.
    const boundary = chunks[0]?.endMs ?? 0;
    expect(boundary).toBeGreaterThan(24_000);
    expect(boundary).toBeLessThan(26_000);
    expect(chunks[1]?.startMs).toBe(boundary);
    expect(chunks.map((chunk) => chunk.text).join(' ')).toBe(text);
    expect(chunks.every((chunk) => chunk.charCount <= 600)).toBe(true);
  });

  it('hard-splits a single unbroken word that exceeds the budget', () => {
    const text = 'x'.repeat(1500);
    const chunks = chunkTranscript(
      transcriptOf([{ startMs: 0, endMs: 15_000, text }]),
      { numCtx: 1024, numPredict: 512 },
    );
    expect(chunks.map((chunk) => chunk.charCount)).toEqual([600, 600, 300]);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.charCount <= 600)).toBe(true);
  });

  it('sorts out-of-order segments and clamps negative starts', () => {
    const chunks = chunkTranscript(
      transcriptOf([
        { startMs: 5000, endMs: 6000, text: 'second' },
        { startMs: -2000, endMs: 1000, text: 'first' },
      ]),
      { numCtx: 4096, numPredict: 512 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('first\nsecond');
    expect(chunks[0]?.startMs).toBe(0);
    expect(chunks[0]?.segments[0]?.startMs).toBe(0);
  });

  it('ignores segments with unusable timestamps or text', () => {
    const chunks = chunkTranscript(
      transcriptOf([
        { startMs: Number.NaN, endMs: 1000, text: 'bad start' },
        { startMs: 0, endMs: Number.POSITIVE_INFINITY, text: 'bad end' },
        { startMs: 1000, endMs: 2000, text: 'good' },
      ]),
      { numCtx: 4096, numPredict: 512 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('good');
  });

  it('refuses transcripts that would need too many model calls', () => {
    const segments: TranscriptSegment[] = [];
    for (let index = 0; index < MAX_CHUNKS; index += 1) {
      segments.push({
        startMs: index * 1000,
        endMs: (index + 1) * 1000,
        text: 'x'.repeat(700),
      });
    }
    expectBadInput(() =>
      chunkTranscript(transcriptOf(segments), {
        numCtx: 1024,
        numPredict: 512,
      }),
    );
  });
});
