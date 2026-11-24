import type { SerializedError } from '../core/errors';

/**
 * Provider contracts. Application logic depends on these interfaces only,
 * so models/runtimes are replaceable without rewriting features.
 *
 * Phase 1 ships the Ollama LLM provider. STT (Whisper) and TTS (Piper)
 * providers implement these same contracts in later phases — the interfaces
 * exist now so queue/storage/UI code never needs to change for them.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  modifiedAt?: string;
}

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  expiresAt?: string;
}

export interface ProviderHealth {
  ok: boolean;
  version?: string;
  error?: SerializedError;
}

export interface GenerationOptions {
  model?: string;
  numCtx?: number;
  temperature?: number;
  numPredict?: number;
  keepAlive?: string;
  format?: 'json';
  /** Per-call transport ceiling. Long CPU-bound calls can exceed the provider default. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  done: boolean;
  evalCount?: number;
  evalDurationMs?: number;
  totalDurationMs?: number;
}

export interface LlmProvider {
  readonly id: string;
  health(): Promise<ProviderHealth>;
  listModels(): Promise<ModelInfo[]>;
  loadedModels(): Promise<LoadedModel[]>;
  chat(
    messages: ChatMessage[],
    options?: GenerationOptions,
  ): Promise<ChatResult>;
  chatStream(
    messages: ChatMessage[],
    options: GenerationOptions,
    onToken: (token: string) => void,
  ): Promise<ChatResult>;
}

/* ---- Speech contracts (implemented in the audio phase) ---- */

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  language?: string;
  segments: TranscriptSegment[];
  text: string;
  source: 'captions' | 'stt' | 'user-file';
}

export interface SttOptions {
  language?: string;
  signal?: AbortSignal;
}

export interface SttProvider {
  readonly id: string;
  transcribe(audio: Blob, options?: SttOptions): Promise<Transcript>;
  health?(): Promise<{ ok: boolean; version?: string; error?: unknown }>;
}

export interface TtsOptions {
  voice?: string;
  speed?: number;
  signal?: AbortSignal;
}

export interface TtsResult {
  audio: Blob;
  mimeType: string;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(text: string, options?: TtsOptions): Promise<TtsResult>;
}
