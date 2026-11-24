import { describe, expect, it } from 'vitest';
import { planBatches } from '../../../src/ai/translate/translator';
import type { TranscriptSegment } from '../../../src/ai/types';

const segs: TranscriptSegment[] = [
  { startMs: 0, endMs: 1000, text: 'a' },
  { startMs: 1000, endMs: 2000, text: 'b' },
  { startMs: 2000, endMs: 3000, text: 'c' },
];

describe('ai/translate/translator', () => {
  it('plans batches covering all segments', () => {
    const batches = planBatches(segs, 4096);
    const keys = batches.flatMap((b) => b.keys);
    expect(keys).toEqual(['0', '1', '2']);
  });

  it('skips empty segments', () => {
    const withEmpty: TranscriptSegment[] = [
      { startMs: 0, endMs: 1000, text: '   ' },
      { startMs: 1000, endMs: 2000, text: 'x' },
    ];
    const batches = planBatches(withEmpty, 4096);
    expect(batches.flatMap((b) => b.keys)).toEqual(['1']);
  });

  it('splits into multiple batches under small context', () => {
    const big: TranscriptSegment[] = Array.from({ length: 5 }, (_, i) => ({
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      text: 'x'.repeat(200),
    }));
    const batches = planBatches(big, 1024);
    expect(batches.length).toBeGreaterThan(1);
  });
});