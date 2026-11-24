import { describe, expect, it } from 'vitest';
import {
  exportTranscript,
  suggestExportFilename,
  EXPORT_MIME_TYPES,
} from '../../src/transcripts/export';
import type { TranscriptSegment } from '../../src/ai/types';

const segments: TranscriptSegment[] = [
  { startMs: 0, endMs: 1000, text: 'Hello <world> & friends' },
  { startMs: 1500, endMs: 1500, text: 'zero length cue' },
];

describe('transcripts/export', () => {
  it('exports txt with timestamps', () => {
    const out = exportTranscript('txt', { title: 'T', segments });
    expect(out).toContain('[0:00]');
    expect(out).toContain('Hello');
  });

  it('exports srt with incrementing indices', () => {
    const out = exportTranscript('srt', { title: 'T', segments });
    expect(out).toContain('1\n');
    expect(out).toContain('-->');
  });

  it('exports vtt with WEBVTT header and escaping', () => {
    const out = exportTranscript('vtt', { title: 'T', segments });
    expect(out.startsWith('WEBVTT')).toBe(true);
    expect(out).toContain('&lt;world&gt;');
    expect(out).toContain('&amp;');
  });

  it('guarantees cue end > start', () => {
    const out = exportTranscript('srt', { title: 'T', segments });
    // zero-length cue should have at least 1ms window
    expect(out).toContain('00:00:01,500 --> 00:00:01,501');
  });

  it('skips empty segments', () => {
    const out = exportTranscript('txt', {
      title: 'T',
      segments: [{ startMs: 0, endMs: 1000, text: '   ' }],
    });
    expect(out.trim()).toBe('T');
  });

  it('suggests safe filenames', () => {
    const name = suggestExportFilename('My Video: Test', 'srt', 'ar');
    expect(name).not.toContain(':');
    expect(name.endsWith('.srt')).toBe(true);
    expect(name).toContain('-ar');
  });

  it('has mime types for all formats', () => {
    for (const format of ['txt', 'md', 'srt', 'vtt'] as const) {
      expect(EXPORT_MIME_TYPES[format]).toBeTruthy();
    }
  });
});