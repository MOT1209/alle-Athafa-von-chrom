import { describe, expect, it } from 'vitest';
import {
  bestSegment,
  buildWindows,
  queryTerms,
  searchPassages,
} from '../../../src/ai/chat/retrieval';
import type { Transcript, TranscriptSegment } from '../../../src/ai/types';
import { segmentsToTranscript } from '../../../src/youtube/transcript';

function transcript(
  entries: Array<[number, number, string]>,
  language = 'en',
): Transcript {
  const segments: TranscriptSegment[] = entries.map(
    ([startMs, endMs, text]) => ({ startMs, endMs, text }),
  );
  return segmentsToTranscript(segments, language);
}

const gardening = transcript([
  [0, 5000, 'Welcome to the show.'],
  [5000, 10_000, 'Tomatoes need six hours of sunlight and regular watering.'],
  [10_000, 15_000, 'The harvest happens in late summer.'],
]);

describe('buildWindows', () => {
  it('covers every segment in order with real timestamps', () => {
    const entries: Array<[number, number, string]> = [];
    for (let index = 0; index < 20; index += 1) {
      const start = index * 1000;
      entries.push([
        start,
        start + 1000,
        `Segment number ${index} explains point ${index} in enough words to take space.`,
      ]);
    }
    const windows = buildWindows(transcript(entries), {
      targetChars: 220,
      overlapChars: 80,
    });
    expect(windows.length).toBeGreaterThan(2);

    const covered = new Set<string>();
    for (const [index, window] of windows.entries()) {
      expect(window.index).toBe(index);
      expect(window.segments.length).toBeGreaterThan(0);
      expect(window.startMs).toBe(window.segments[0]!.startMs);
      expect(window.endMs).toBe(window.segments[window.segments.length - 1]!.endMs);
      expect(window.text).toBe(
        window.segments.map((segment) => segment.text).join(' '),
      );
      for (const segment of window.segments) covered.add(segment.text);
    }
    for (const [, , text] of entries) expect(covered.has(text)).toBe(true);
  });

  it('returns no windows for an empty transcript', () => {
    expect(buildWindows(transcript([]))).toEqual([]);
    expect(
      buildWindows(
        transcript([
          [0, 1000, '   '],
          [1000, 2000, ''],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('queryTerms', () => {
  it('deduplicates, removes stopwords and stems', () => {
    expect(queryTerms('What is the sunlight, the sunlight?')).toEqual([
      'sunlight',
    ]);
    expect(queryTerms('ما هو الفيديو')).toEqual(['فيديو']);
    expect(queryTerms('the and of')).toEqual([]);
  });
});

describe('searchPassages', () => {
  it('finds the passage that actually states the answer', () => {
    const windows = buildWindows(gardening);
    const passages = searchPassages(
      windows,
      'How much sunlight do tomatoes need?',
    );
    expect(passages).toHaveLength(1);
    expect(passages[0]!.text).toContain('six hours of sunlight');
    expect(passages[0]!.matchedTerms).toBeGreaterThanOrEqual(2);
    expect(passages[0]!.score).toBeGreaterThan(0);
  });

  it('returns nothing when the transcript does not cover the question', () => {
    const windows = buildWindows(gardening);
    expect(searchPassages(windows, 'What is the capital of France?')).toEqual(
      [],
    );
    expect(searchPassages(windows, 'the and of')).toEqual([]);
    expect(searchPassages([], 'sunlight')).toEqual([]);
  });

  it('requires two distinct terms for a multi-term question by default', () => {
    const windows = buildWindows(gardening);
    expect(searchPassages(windows, 'sunlight banana')).toEqual([]);
    expect(
      searchPassages(windows, 'sunlight banana', { minMatches: 1 }),
    ).toHaveLength(1);
  });

  it('finds a single distinctive term', () => {
    const windows = buildWindows(gardening);
    const passages = searchPassages(windows, 'watering');
    expect(passages).toHaveLength(1);
    expect(passages[0]!.text).toContain('regular watering');
  });

  it('retrieves Arabic questions against an Arabic transcript', () => {
    const arabic = transcript(
      [
        [0, 4000, 'مرحبا بكم في البرنامج.'],
        [4000, 9000, 'تحتاج الطماطم إلى ست ساعات من أشعة الشمس يوميًا.'],
        [9000, 12_000, 'يكون الحصاد في أواخر الصيف.'],
      ],
      'ar',
    );
    const passages = searchPassages(
      buildWindows(arabic),
      'كم ساعة من الشمس تحتاج الطماطم؟',
    );
    expect(passages).toHaveLength(1);
    expect(passages[0]!.text).toContain('أشعة الشمس');
  });

  it('caps the number of returned passages', () => {
    const entries: Array<[number, number, string]> = [];
    for (let index = 0; index < 40; index += 1) {
      const start = index * 1000;
      entries.push([
        start,
        start + 1000,
        `Sunlight note ${index}: tomatoes need sunlight and water every day.`,
      ]);
    }
    const passages = searchPassages(
      buildWindows(transcript(entries), { targetChars: 200, overlapChars: 0 }),
      'sunlight tomatoes',
      { maxPassages: 2 },
    );
    expect(passages.length).toBeLessThanOrEqual(2);
    expect(passages.length).toBeGreaterThan(0);
  });
});

describe('bestSegment', () => {
  it('picks the segment with the most question terms', () => {
    const windows = buildWindows(gardening);
    const passage = searchPassages(
      windows,
      'How much sunlight do tomatoes need?',
    )[0]!;
    const segment = bestSegment(passage, 'How much sunlight do tomatoes need?');
    expect(segment?.startMs).toBe(5000);
    expect(segment?.text).toContain('Tomatoes need six hours of sunlight');
  });

  it('falls back to the first segment when nothing matches', () => {
    const windows = buildWindows(gardening);
    const segment = bestSegment(windows[0]!, 'banana');
    expect(segment).toBe(windows[0]!.segments[0]);
  });
});
