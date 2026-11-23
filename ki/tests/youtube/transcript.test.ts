import { describe, expect, it } from 'vitest';
import {
  closeSegmentGaps,
  decodeXmlEntities,
  parseInnerTubeSegments,
  parseJson3,
  parseTimedTextXml,
  parseTimestampToMs,
  segmentsToTranscript,
} from '../../src/youtube/transcript';

describe('parseJson3', () => {
  it('parses real-shaped json3 events', () => {
    const data = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '\n' }] },
        { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'Second line' }] },
        { tStartMs: 9000 },
      ],
    };
    const segments = parseJson3(data);
    expect(segments).toEqual([
      { startMs: 0, endMs: 2000, text: 'Hello world' },
      { startMs: 2000, endMs: 5000, text: 'Second line' },
    ]);
  });

  it('returns empty for malformed input', () => {
    expect(parseJson3(null)).toEqual([]);
    expect(parseJson3({})).toEqual([]);
    expect(parseJson3({ events: 'x' })).toEqual([]);
  });
});

describe('parseTimedTextXml', () => {
  it('parses legacy XML with entities', () => {
    const xml = '<?xml version="1.0"?><transcript><text start="0.5" dur="2.1">Hello &amp; welcome</text><text start="3" dur="1">&lt;tag&gt; &quot;quoted&quot; &#39;apostrophe&#39;</text></transcript>';
    expect(parseTimedTextXml(xml)).toEqual([
      { startMs: 500, endMs: 2600, text: 'Hello & welcome' },
      { startMs: 3000, endMs: 4000, text: '<tag> "quoted" \'apostrophe\'' },
    ]);
  });

  it('skips entries without start and empty text', () => {
    expect(parseTimedTextXml('<text dur="1">x</text><text start="1"></text>')).toEqual([]);
  });
});

describe('decodeXmlEntities', () => {
  it('decodes numeric and named entities', () => {
    expect(decodeXmlEntities('&#x645;&#x631;&#x62D;&#x628;&#x627;')).toBe('مرحبا');
    expect(decodeXmlEntities('&#1575;&#1604;&#1587;&#1604;&#1575;&#1605;')).toBe('السلام');
    expect(decodeXmlEntities('a &amp; b &lt; c')).toBe('a & b < c');
  });
});

describe('parseInnerTubeSegments', () => {
  it('parses get_transcript initialSegments', () => {
    const data = [
      {
        transcriptSegmentRenderer: {
          startMs: '0',
          endMs: '2000',
          snippet: { runs: [{ text: 'All right ' }, { text: 'everyone' }] },
        },
      },
      {
        transcriptSegmentRenderer: {
          startMs: '2000',
          endMs: '5000',
          snippet: { runs: [{ text: 'welcome' }] },
        },
      },
      { other: true },
    ];
    expect(parseInnerTubeSegments(data)).toEqual([
      { startMs: 0, endMs: 2000, text: 'All right everyone' },
      { startMs: 2000, endMs: 5000, text: 'welcome' },
    ]);
  });

  it('returns empty for non-arrays', () => {
    expect(parseInnerTubeSegments({})).toEqual([]);
    expect(parseInnerTubeSegments(undefined)).toEqual([]);
  });
});

describe('parseTimestampToMs', () => {
  it('parses m:ss and h:mm:ss', () => {
    expect(parseTimestampToMs('0:00')).toBe(0);
    expect(parseTimestampToMs('1:23')).toBe(83000);
    expect(parseTimestampToMs('1:02:03')).toBe(3723000);
  });

  it('rejects malformed timestamps', () => {
    expect(parseTimestampToMs('abc')).toBeUndefined();
    expect(parseTimestampToMs('1:2:3:4')).toBeUndefined();
    expect(parseTimestampToMs('1:xx')).toBeUndefined();
    expect(parseTimestampToMs('')).toBeUndefined();
  });
});

describe('closeSegmentGaps', () => {
  it('derives ends from next starts and keeps real ends', () => {
    const segments = [
      { startMs: 0, endMs: 0, text: 'a' },
      { startMs: 2000, endMs: 2000, text: 'b' },
      { startMs: 5000, endMs: 8000, text: 'c' },
    ];
    expect(closeSegmentGaps(segments)).toEqual([
      { startMs: 0, endMs: 2000, text: 'a' },
      { startMs: 2000, endMs: 5000, text: 'b' },
      { startMs: 5000, endMs: 8000, text: 'c' },
    ]);
  });

  it('gives the last gapless segment a 3s window', () => {
    expect(closeSegmentGaps([{ startMs: 1000, endMs: 1000, text: 'x' }])).toEqual([
      { startMs: 1000, endMs: 4000, text: 'x' },
    ]);
  });
});

describe('segmentsToTranscript', () => {
  it('sorts by start, joins text, records language and source', () => {
    const transcript = segmentsToTranscript(
      [
        { startMs: 2000, endMs: 4000, text: 'second' },
        { startMs: 0, endMs: 2000, text: 'first' },
      ],
      'en',
    );
    expect(transcript.source).toBe('captions');
    expect(transcript.language).toBe('en');
    expect(transcript.text).toBe('first\nsecond');
    expect(transcript.segments[0]?.startMs).toBe(0);
  });

  it('omits language when unknown', () => {
    const transcript = segmentsToTranscript([{ startMs: 0, endMs: 1000, text: 'x' }]);
    expect(transcript.language).toBeUndefined();
  });
});
