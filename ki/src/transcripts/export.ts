import type { TranscriptSegment } from '../ai/types';
import { formatClock } from '../ai/summary/time';
import { normalizeSegmentText } from './editor';

/**
 * Pure transcript exporters. Every format is produced locally from the stored
 * segments; no network, no permissions, and no hidden cleanup. SRT and VTT use
 * standard timecodes so the files import into ordinary players and editors.
 */

export type TranscriptExportFormat = 'txt' | 'md' | 'srt' | 'vtt';

export interface TranscriptExportInput {
  title: string;
  segments: readonly TranscriptSegment[];
  language?: string;
  sourceUrl?: string;
}

export const EXPORT_FORMATS: readonly TranscriptExportFormat[] = [
  'txt',
  'md',
  'srt',
  'vtt',
];

export const EXPORT_MIME_TYPES: Readonly<Record<TranscriptExportFormat, string>> =
  {
    txt: 'text/plain;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
    srt: 'application/x-subrip;charset=utf-8',
    vtt: 'text/vtt;charset=utf-8',
  };

const FILE_EXTENSIONS: Readonly<Record<TranscriptExportFormat, string>> = {
  txt: 'txt',
  md: 'md',
  srt: 'srt',
  vtt: 'vtt',
};

const MAX_FILE_STEM_CHARS = 80;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function safeMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Subtitle timecode with millisecond precision. SRT uses a comma, VTT a dot.
 */
export function formatSubtitleTime(
  ms: number,
  separator: ',' | '.' = ',',
): string {
  const total = safeMs(ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`;
}

/** Cue end must be after its start; zero-length segments get a 1 ms window. */
function cueEnd(startMs: number, endMs: number): number {
  const start = safeMs(startMs);
  const end = safeMs(endMs);
  return Math.max(start + 1, end);
}

function cleanText(text: string): string {
  return normalizeSegmentText(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function escapeVtt(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function usableSegments(
  input: TranscriptExportInput,
): Array<{ startMs: number; endMs: number; text: string }> {
  const segments: Array<{ startMs: number; endMs: number; text: string }> = [];
  for (const segment of input.segments) {
    const text = cleanText(segment.text);
    if (text.length === 0) continue;
    const startMs = safeMs(segment.startMs);
    segments.push({
      startMs,
      endMs: cueEnd(startMs, segment.endMs),
      text,
    });
  }
  return segments;
}

function headerLines(input: TranscriptExportInput): string[] {
  const lines: string[] = [];
  if (input.language) lines.push(`Language: ${input.language}`);
  if (input.sourceUrl) lines.push(`Source: ${input.sourceUrl}`);
  return lines;
}

export function exportTxt(input: TranscriptExportInput): string {
  const lines: string[] = [input.title.trim() || 'Transcript', ''];
  lines.push(...headerLines(input));
  if (lines[lines.length - 1] !== '') lines.push('');
  for (const segment of usableSegments(input)) {
    lines.push(`[${formatClock(segment.startMs)}] ${segment.text}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function escapeMarkdownInline(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

export function exportMarkdown(input: TranscriptExportInput): string {
  const lines: string[] = [`# ${escapeMarkdownInline(input.title.trim() || 'Transcript')}`, ''];
  const header = headerLines(input);
  if (header.length > 0) {
    for (const line of header) lines.push(`- ${line}`);
    lines.push('');
  }
  lines.push('## Transcript', '');
  for (const segment of usableSegments(input)) {
    lines.push(`**[${formatClock(segment.startMs)}]** ${escapeMarkdownInline(segment.text)}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function exportSrt(input: TranscriptExportInput): string {
  const cues: string[] = [];
  usableSegments(input).forEach((segment, index) => {
    cues.push(
      `${index + 1}`,
      `${formatSubtitleTime(segment.startMs, ',')} --> ${formatSubtitleTime(segment.endMs, ',')}`,
      segment.text,
      '',
    );
  });
  return `${cues.join('\n').trimEnd()}\n`;
}

export function exportVtt(input: TranscriptExportInput): string {
  const cues: string[] = ['WEBVTT', ''];
  for (const segment of usableSegments(input)) {
    cues.push(
      `${formatSubtitleTime(segment.startMs, '.')} --> ${formatSubtitleTime(segment.endMs, '.')}`,
      escapeVtt(segment.text),
      '',
    );
  }
  return `${cues.join('\n').trimEnd()}\n`;
}

export function exportTranscript(
  format: TranscriptExportFormat,
  input: TranscriptExportInput,
): string {
  switch (format) {
    case 'txt':
      return exportTxt(input);
    case 'md':
      return exportMarkdown(input);
    case 'srt':
      return exportSrt(input);
    case 'vtt':
      return exportVtt(input);
  }
}

function sanitizeFileStem(title: string): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '');
  const chars = Array.from(cleaned);
  const stem = chars.slice(0, MAX_FILE_STEM_CHARS).join('').trim();
  return stem.length > 0 ? stem : 'transcript';
}

/** A safe download name; no path separators or Windows-reserved characters. */
export function suggestExportFilename(
  title: string,
  format: TranscriptExportFormat,
  language?: string,
): string {
  const suffix = language ? `-${language}` : '';
  return `${sanitizeFileStem(title)}${suffix}.${FILE_EXTENSIONS[format]}`;
}
