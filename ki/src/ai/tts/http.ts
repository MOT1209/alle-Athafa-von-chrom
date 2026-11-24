import { AppError } from '../../core/errors';
import type { TtsOptions, TtsProvider, TtsResult } from '../types';

/**
 * Generic HTTP TTS provider. POSTs text to a local TTS server and expects
 * audio bytes back. Used for Piper (or any local TTS) fronted by a small
 * HTTP wrapper. If the server is unreachable, synthesize() throws a typed
 * error with setup instructions.
 */

export interface HttpTtsProviderOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpTtsProvider implements TtsProvider {
  readonly id = 'http-tts';
  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: HttpTtsProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: options?.voice, speed: options?.speed }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new AppError('CAPTURE_UNAVAILABLE', 'TTS server is not reachable', {
        hint: 'Run a local TTS server (Piper) on port 5000, then retry.',
        cause: err,
      });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const t = await response.text().catch(() => '');
      throw new AppError('CAPTURE_UNAVAILABLE', `TTS server returned ${response.status}`, {
        hint: 'Check that the TTS server is running and the voice is available.',
        detail: t.slice(0, 200),
      });
    }

    const blob = await response.blob();
    const mimeType = response.headers.get('Content-Type') || 'audio/wav';
    return { audio: blob, mimeType };
  }
}