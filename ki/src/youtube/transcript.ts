import type { Transcript, TranscriptSegment } from '../ai/types';
import { isRecord } from './extract';

/**
 * Pure transcript parsers for the three real caption formats YouTube serves:
 *  - json3 timedtext events
 *  - legacy timedtext XML
 *  - InnerTube get_transcript initialSegments
 * plus the rendered transcript-panel DOM timestamps.
 */

export interface RawSegment {
  startMs: number;
  endMs: number;
  text: string;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** json3: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] } */
export function parseJson3(data: unknown): RawSegment[] {
  if (!isRecord(data) || !Array.isArray(data.events)) return [];
  const segments: RawSegment[] = [];
  for (const event of data.events) {
    if (!isRecord(event) || !Array.isArray(event.segs)) continue;
    const startMs = asNumber(event.tStartMs);
    if (startMs === undefined) continue;
    const text = cleanText(
      event.segs
        .map((seg) => (isRecord(seg) && typeof seg.utf8 === 'string' ? seg.utf8 : ''))
        .join(''),
    );
    if (!text) continue;
    const duration = asNumber(event.dDurationMs) ?? 0;
    segments.push({ startMs, endMs: startMs + duration, text });
  }
  return segments;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&#39;/g, (e) => XML_ENTITIES[e] ?? e);
}

/** Legacy timedtext XML: <transcript><text start="0.5" dur="2.1">..</text></transcript> */
export function parseTimedTextXml(xml: string): RawSegment[] {
  const segments: RawSegment[] = [];
  const pattern = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const start = asNumber(/start="([^"]*)"/.exec(attrs)?.[1]);
    if (start === undefined) continue;
    const dur = asNumber(/dur="([^"]*)"/.exec(attrs)?.[1]) ?? 0;
    const text = cleanText(decodeXmlEntities(body.replace(/<[^>]*>/g, '')));
    if (!text) continue;
    segments.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round((start + dur) * 1000),
      text,
    });
  }
  return segments;
}

/** InnerTube get_transcript initialSegments. */
export function parseInnerTubeSegments(data: unknown): RawSegment[] {
  if (!Array.isArray(data)) return [];
  const segments: RawSegment[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const renderer = isRecord(entry.transcriptSegmentRenderer)
      ? entry.transcriptSegmentRenderer
      : undefined;
    if (!renderer) continue;
    const startMs = asNumber(renderer.startMs);
    if (startMs === undefined) continue;
    const snippet = isRecord(renderer.snippet) ? renderer.snippet : undefined;
    const runs = Array.isArray(snippet?.runs) ? snippet.runs : [];
    const text = cleanText(
      runs
        .map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : ''))
        .join(''),
    );
    if (!text) continue;
    const endMs = asNumber(renderer.endMs) ?? startMs;
    segments.push({ startMs, endMs, text });
  }
  return segments;
}

/** "1:23" / "1:23:45" (transcript panel timestamps) → milliseconds. */
export function parseTimestampToMs(timestamp: string): number | undefined {
  const parts = timestamp.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) return undefined;
    return parseInt(part, 10);
  });
  if (numbers.some((n) => n === undefined)) return undefined;
  const [a, b, c] = numbers as number[];
  const seconds =
    numbers.length === 3 ? (a ?? 0) * 3600 + (b ?? 0) * 60 + (c ?? 0) : (a ?? 0) * 60 + (b ?? 0);
  return seconds * 1000;
}

/**
 * DOM-scraped segments only carry start timestamps; derive ends from the next
 * segment's start (last segment gets a conservative 3s window).
 */
export function closeSegmentGaps(segments: RawSegment[]): RawSegment[] {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const endMs =
      segment.endMs > segment.startMs
        ? segment.endMs
        : next
          ? next.startMs
          : segment.startMs + 3000;
    return { ...segment, endMs };
  });
}

export function segmentsToTranscript(
  segments: RawSegment[],
  language?: string,
): Transcript {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  const transcriptSegments: TranscriptSegment[] = ordered.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));
  const transcript: Transcript = {
    segments: transcriptSegments,
    text: ordered.map((segment) => segment.text).join('\n'),
    source: 'captions',
  };
  if (language) transcript.language = language;
  return transcript;
}
