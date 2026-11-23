import { describe, expect, it } from 'vitest';
import {
  isSummaryChapter,
  isSummaryKeyPoint,
  parseMapNotes,
  parseStructuredSummary,
  MAX_CHAPTERS,
  MAX_CHAPTER_TITLE_CHARS,
  MAX_KEY_POINTS,
  MAX_KEY_POINT_CHARS,
  MAX_NOTE_SUMMARY_CHARS,
  MAX_OVERVIEW_CHARS,
} from '../../../src/ai/summary/schema';

const LIMIT = 100_000;

function mapJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'The speaker explains the topic.',
    keyPoints: [{ timestampMs: 1000, text: 'A point' }],
    ...overrides,
  });
}

function summaryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    overview: 'The video explains the topic in detail.',
    keyPoints: [{ timestampMs: 0, text: 'First point' }],
    chapters: [{ startMs: 0, title: 'Intro', summary: 'How it starts' }],
    ...overrides,
  });
}

function expectBadResponse(fn: () => unknown, pattern?: RegExp): void {
  expect(fn).toThrowError(
    expect.objectContaining({ code: 'BAD_RESPONSE', retryable: true }),
  );
  if (pattern) {
    expect(fn).toThrowError(pattern);
  }
}

describe('parseMapNotes', () => {
  it('parses valid notes and normalizes whitespace', () => {
    const notes = parseMapNotes(
      JSON.stringify({
        summary: '  A   compact   summary. ',
        keyPoints: [{ timestampMs: 1000, text: '  First   point ' }],
      }),
      LIMIT,
    );
    expect(notes.summary).toBe('A compact summary.');
    expect(notes.keyPoints).toEqual([{ timestampMs: 1000, text: 'First point' }]);
  });

  it('accepts alternate timestamp keys and clock strings', () => {
    const notes = parseMapNotes(
      JSON.stringify({
        summary: 'S',
        keyPoints: [
          { timestamp: '1:00', text: 'one minute' },
          { startMs: '90000', text: 'ninety seconds' },
          { time: '2 s', text: 'two seconds' },
        ],
      }),
      LIMIT,
    );
    expect(notes.keyPoints.map((point) => point.timestampMs)).toEqual([
      2000, 60_000, 90_000,
    ]);
  });

  it('sorts points and drops exact duplicates', () => {
    const notes = parseMapNotes(
      JSON.stringify({
        summary: 'S',
        keyPoints: [
          { timestampMs: 5000, text: 'Later' },
          { timestampMs: 1000, text: 'Earlier' },
          { timestampMs: 1000, text: 'earlier' },
        ],
      }),
      LIMIT,
    );
    expect(notes.keyPoints).toEqual([
      { timestampMs: 1000, text: 'Earlier' },
      { timestampMs: 5000, text: 'Later' },
    ]);
  });

  it('allows an empty key point list for plain notes', () => {
    const notes = parseMapNotes(mapJson({ keyPoints: [] }), LIMIT);
    expect(notes.keyPoints).toEqual([]);
  });

  it('rejects empty, non-JSON and non-object responses', () => {
    expectBadResponse(() => parseMapNotes('', LIMIT), /empty/);
    expectBadResponse(() => parseMapNotes('not json', LIMIT), /not valid JSON/);
    expectBadResponse(() => parseMapNotes('[]', LIMIT), /not a JSON object/);
    expectBadResponse(() => parseMapNotes('null', LIMIT), /not a JSON object/);
  });

  it('rejects missing or invalid summary text', () => {
    expectBadResponse(
      () => parseMapNotes(JSON.stringify({ keyPoints: [] }), LIMIT),
      /summary/,
    );
    expectBadResponse(
      () => parseMapNotes(JSON.stringify({ summary: 5 }), LIMIT),
      /must be a string/,
    );
    expectBadResponse(
      () => parseMapNotes(JSON.stringify({ summary: '   ' }), LIMIT),
      /is empty/,
    );
    expectBadResponse(
      () =>
        parseMapNotes(
          JSON.stringify({ summary: 'x'.repeat(MAX_NOTE_SUMMARY_CHARS + 1) }),
          LIMIT,
        ),
      /longer than/,
    );
  });

  it('rejects a missing or malformed key point list', () => {
    expectBadResponse(
      () => parseMapNotes(JSON.stringify({ summary: 'S' }), LIMIT),
      /keyPoints/,
    );
    expectBadResponse(
      () => parseMapNotes(mapJson({ keyPoints: 'nope' }), LIMIT),
      /must be an array/,
    );
    expectBadResponse(
      () => parseMapNotes(mapJson({ keyPoints: [null] }), LIMIT),
      /must be an object/,
    );
  });

  it('rejects invalid or out-of-range timestamps', () => {
    expectBadResponse(
      () =>
        parseMapNotes(
          mapJson({ keyPoints: [{ text: 'no timestamp' }] }),
          LIMIT,
        ),
      /timestamp is required/,
    );
    expectBadResponse(
      () =>
        parseMapNotes(
          mapJson({ keyPoints: [{ timestampMs: 'later', text: 'x' }] }),
          LIMIT,
        ),
      /milliseconds or a clock value/,
    );
    expectBadResponse(
      () =>
        parseMapNotes(
          mapJson({ keyPoints: [{ timestampMs: LIMIT + 1, text: 'x' }] }),
          LIMIT,
        ),
      /beyond the end/,
    );
  });

  it('rejects empty or oversized point text', () => {
    expectBadResponse(
      () =>
        parseMapNotes(
          mapJson({ keyPoints: [{ timestampMs: 0, text: '  ' }] }),
          LIMIT,
        ),
      /is empty/,
    );
    expectBadResponse(
      () =>
        parseMapNotes(
          mapJson({
            keyPoints: [
              { timestampMs: 0, text: 'x'.repeat(MAX_KEY_POINT_CHARS + 1) },
            ],
          }),
          LIMIT,
        ),
      /longer than/,
    );
  });
});

describe('parseStructuredSummary', () => {
  it('parses a valid summary and preserves optional chapter text', () => {
    const summary = parseStructuredSummary(summaryJson(), LIMIT);
    expect(summary.overview).toBe('The video explains the topic in detail.');
    expect(summary.keyPoints).toEqual([{ timestampMs: 0, text: 'First point' }]);
    expect(summary.chapters).toEqual([
      { startMs: 0, title: 'Intro', summary: 'How it starts' },
    ]);
  });

  it('omits empty optional chapter summaries', () => {
    const summary = parseStructuredSummary(
      summaryJson({ chapters: [{ startMs: 0, title: 'Intro', summary: '  ' }] }),
      LIMIT,
    );
    expect(summary.chapters).toEqual([{ startMs: 0, title: 'Intro' }]);
  });

  it('sorts chapters and drops duplicate starts', () => {
    const summary = parseStructuredSummary(
      summaryJson({
        chapters: [
          { startMs: 50_000, title: 'Middle' },
          { startMs: 0, title: 'Start' },
          { startMs: 50_000, title: 'Duplicate' },
        ],
      }),
      LIMIT,
    );
    expect(summary.chapters).toEqual([
      { startMs: 0, title: 'Start' },
      { startMs: 50_000, title: 'Middle' },
    ]);
  });

  it('accepts alternate timestamp keys for chapters', () => {
    const summary = parseStructuredSummary(
      summaryJson({
        chapters: [
          { start: '1:00', title: 'One' },
          { time: '1:20', title: 'Two' },
          { timestamp: 90_000, title: 'Three' },
        ],
      }),
      LIMIT,
    );
    expect(summary.chapters.map((chapter) => chapter.startMs)).toEqual([
      60_000, 80_000, 90_000,
    ]);
  });

  it('rejects a missing or oversized overview', () => {
    expectBadResponse(
      () => parseStructuredSummary(JSON.stringify({}), LIMIT),
      /overview/,
    );
    expectBadResponse(
      () =>
        parseStructuredSummary(
          summaryJson({ overview: 'x'.repeat(MAX_OVERVIEW_CHARS + 1) }),
          LIMIT,
        ),
      /longer than/,
    );
  });

  it('requires at least one key point and rejects oversize lists', () => {
    expectBadResponse(
      () => parseStructuredSummary(summaryJson({ keyPoints: [] }), LIMIT),
      /at least 1/,
    );
    const tooMany = Array.from({ length: MAX_KEY_POINTS + 1 }, (_, index) => ({
      timestampMs: index * 1000,
      text: `point ${index}`,
    }));
    expectBadResponse(
      () => parseStructuredSummary(summaryJson({ keyPoints: tooMany }), LIMIT),
      /at most/,
    );
  });

  it('requires chapters and rejects oversize lists', () => {
    expectBadResponse(
      () => parseStructuredSummary(summaryJson({ chapters: [] }), LIMIT),
      /at least one chapter/,
    );
    const tooMany = Array.from({ length: MAX_CHAPTERS + 1 }, (_, index) => ({
      startMs: index * 1000,
      title: `chapter ${index}`,
    }));
    expectBadResponse(
      () => parseStructuredSummary(summaryJson({ chapters: tooMany }), LIMIT),
      /at most/,
    );
  });

  it('rejects chapter entries without a title or with invalid fields', () => {
    expectBadResponse(
      () =>
        parseStructuredSummary(
          summaryJson({ chapters: [{ startMs: 0 }] }),
          LIMIT,
        ),
      /title/,
    );
    expectBadResponse(
      () =>
        parseStructuredSummary(
          summaryJson({
            chapters: [
              { startMs: 0, title: 'x'.repeat(MAX_CHAPTER_TITLE_CHARS + 1) },
            ],
          }),
          LIMIT,
        ),
      /longer than/,
    );
    expectBadResponse(
      () =>
        parseStructuredSummary(
          summaryJson({ chapters: [{ startMs: 0, title: 42 }] }),
          LIMIT,
        ),
      /must be a string/,
    );
  });
});

describe('stored value guards', () => {
  it('isSummaryKeyPoint accepts valid points only', () => {
    expect(isSummaryKeyPoint({ timestampMs: 0, text: 'ok' })).toBe(true);
    expect(isSummaryKeyPoint({ timestampMs: 1000, text: 'ok' })).toBe(true);
    expect(isSummaryKeyPoint({ timestampMs: -1, text: 'ok' })).toBe(false);
    expect(isSummaryKeyPoint({ timestampMs: Number.NaN, text: 'ok' })).toBe(false);
    expect(isSummaryKeyPoint({ timestampMs: 0, text: '  ' })).toBe(false);
    expect(isSummaryKeyPoint({ timestampMs: '0', text: 'ok' })).toBe(false);
    expect(isSummaryKeyPoint(null)).toBe(false);
  });

  it('isSummaryChapter accepts valid chapters only', () => {
    expect(isSummaryChapter({ startMs: 0, title: 'Intro' })).toBe(true);
    expect(
      isSummaryChapter({ startMs: 0, title: 'Intro', summary: 'text' }),
    ).toBe(true);
    expect(isSummaryChapter({ startMs: 0 })).toBe(false);
    expect(isSummaryChapter({ startMs: -5, title: 'Intro' })).toBe(false);
    expect(
      isSummaryChapter({ startMs: 0, title: 'Intro', summary: 5 }),
    ).toBe(false);
    expect(isSummaryChapter([])).toBe(false);
  });
});
