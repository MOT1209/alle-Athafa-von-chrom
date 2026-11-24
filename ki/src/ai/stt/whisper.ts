import { AppError } from '../../core/errors';
import type { SttOptions, SttProvider, Transcript, TranscriptSegment } from '../types';

/**
 * whisper.cpp HTTP server provider (SttProvider). Talks to a local
 * whisper-server (default http://127.0.0.1:8178). If the server is not
 * reachable, health() returns ok:false and transcribe() throws a typed
 * STT_UNAVAILABLE error with setup instructions — never a fake transcript.
 */

export interface WhisperProviderOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 1_800_000;

export class WhisperProvider implements SttProvider {
  readonly id = 'whisper';
  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: WhisperProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<{ ok: boolean; version?: string; error?: unknown }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await this.fetchImpl(`${this.baseUrl}/`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        // Some builds expose /health instead.
        const r2 = await this.fetchImpl(`${this.baseUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        if (!r2 || !r2.ok) return { ok: false };
        return { ok: true };
      }
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async transcribe(audio: Blob, options?: SttOptions): Promise<Transcript> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      const form = new FormData();
      form.append('file', audio, 'audio');
      if (options?.language) form.append('language', options.language);
      form.append('response_format', 'json');
      form.append('timestamp_granularities[]', 'segment');

      response = await this.fetchImpl(`${this.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new AppError('CAPTURE_UNAVAILABLE', 'Whisper server is not reachable', {
        hint: 'Install and run whisper.cpp server (whisper-server) on port 8178, then retry. FFmpeg may be required for non-WAV inputs.',
        cause: err,
      });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError('CAPTURE_UNAVAILABLE', `Whisper server returned ${response.status}`, {
        hint: 'Check that whisper-server is running and the model is loaded.',
        detail: text.slice(0, 200),
      });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AppError('BAD_RESPONSE', 'Whisper server returned non-JSON');
    }
    return parseWhisperResponse(data, options?.language);
  }
}

function parseWhisperResponse(data: unknown, language?: string): Transcript {
  if (typeof data !== 'object' || data === null) {
    throw new AppError('BAD_RESPONSE', 'Whisper response is not an object');
  }
  const record = data as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : '';
  const rawSegments = Array.isArray(record.segments) ? record.segments : [];

  const segments: TranscriptSegment[] = [];
  for (const entry of rawSegments) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const segText = typeof e.text === 'string' ? e.text.trim() : '';
    if (segText.length === 0) continue;

    let startMs = 0;
    let endMs = 0;
    if (typeof e.startMs === 'number') startMs = e.startMs;
    else if (typeof e.t0 === 'number') startMs = e.t0 * 10;
    else if (typeof e.start === 'number') startMs = e.start < 10000 ? Math.round(e.start * 1000) : e.start;

    if (typeof e.endMs === 'number') endMs = e.endMs;
    else if (typeof e.t1 === 'number') endMs = e.t1 * 10;
    else if (typeof e.end === 'number') endMs = e.end < 10000 ? Math.round(e.end * 1000) : e.end;

    if (endMs < startMs) endMs = startMs;
    segments.push({ startMs: Math.max(0, Math.round(startMs)), endMs: Math.max(0, Math.round(endMs)), text: segText });
  }

  if (segments.length === 0 && text.trim().length > 0) {
    segments.push({ startMs: 0, endMs: 0, text: text.trim() });
  }
  if (segments.length === 0) {
    throw new AppError('BAD_RESPONSE', 'Whisper returned no transcript');
  }

  return {
    language: language ?? (typeof record.language === 'string' ? record.language : undefined),
    segments,
    text: segments.map((s) => s.text).join('\n'),
    source: 'stt',
  };
}