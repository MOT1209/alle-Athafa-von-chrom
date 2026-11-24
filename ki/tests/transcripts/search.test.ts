import { describe, expect, it } from 'vitest';
import { searchTranscripts } from '../../src/transcripts/search';
import { segmentsToTranscript } from '../../src/youtube/transcript';
import type { VideoRecord } from '../../src/capture/videos';

function makeRecord(id: string, texts: string[]): VideoRecord {
  return {
    id,
    platform: 'youtube',
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Video ${id}`,
    segmentCount: texts.length,
    capturedAt: 0,
    transcript: segmentsToTranscript(
      texts.map((text, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, text })),
      'en',
    ),
  };
}

describe('transcripts/search', () => {
  it('returns empty for blank query', () => {
    const records = [makeRecord('a', ['hello world'])];
    expect(searchTranscripts(records, '   ')).toEqual([]);
    expect(searchTranscripts(records, '')).toEqual([]);
  });

  it('finds matching segments', () => {
    const records = [makeRecord('a', ['the quick brown fox', 'lazy dog'])];
    const hits = searchTranscripts(records, 'quick fox');
    expect(hits.length).toBe(1);
    expect(hits[0]?.segmentIndex).toBe(0);
    expect(hits[0]?.videoRecordId).toBe('a');
  });

  it('respects limit', () => {
    const records = [makeRecord('a', ['one two three', 'four five six'])];
    const hits = searchTranscripts(records, 'one', 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('sorts by score descending', () => {
    const records = [makeRecord('a', ['apple apple apple', 'apple'])];
    const hits = searchTranscripts(records, 'apple');
    expect(hits.length).toBe(2);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
  });
});