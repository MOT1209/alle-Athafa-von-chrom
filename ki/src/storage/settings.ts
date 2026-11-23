import { isLanguage, type Language } from '../core/i18n';
import type { KeyValueStore } from './kv';

/**
 * Persisted settings with strict sanitization. Any unknown/corrupt input is
 * clamped back to safe defaults instead of crashing the extension.
 */

export interface OllamaSettings {
  baseUrl: string;
  requestTimeoutMs: number;
  keepAlive: string;
}

export interface GenerationSettings {
  model: string;
  numCtx: number;
  temperature: number;
  numPredict: number;
}

export interface QueueSettings {
  maxRetries: number;
  retryBaseDelayMs: number;
  maxQueueSize: number;
}

export interface MemorySettings {
  reserveMb: number;
  enforceBudget: boolean;
  unloadAfterTask: boolean;
}

export interface Settings {
  schemaVersion: 1;
  language: Language;
  ollama: OllamaSettings;
  generation: GenerationSettings;
  queue: QueueSettings;
  memory: MemorySettings;
}

export interface SettingsPatch {
  language?: Language;
  ollama?: Partial<OllamaSettings>;
  generation?: Partial<GenerationSettings>;
  queue?: Partial<QueueSettings>;
  memory?: Partial<MemorySettings>;
}

export const SETTINGS_KEY = 'videoking.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  language: 'en',
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    requestTimeoutMs: 120_000,
    keepAlive: '5m',
  },
  generation: {
    model: 'qwen2.5:1.5b',
    numCtx: 4096,
    temperature: 0.3,
    numPredict: 512,
  },
  queue: {
    maxRetries: 2,
    retryBaseDelayMs: 1500,
    maxQueueSize: 20,
  },
  memory: {
    reserveMb: 3072,
    enforceBudget: true,
    unloadAfterTask: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampFloat(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return trimmed;
  } catch {
    return fallback;
  }
}

const KEEP_ALIVE_PATTERN = /^(-1|0|\d+(\.\d+)?[smh])$/;

function sanitizeKeepAlive(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return KEEP_ALIVE_PATTERN.test(trimmed) ? trimmed : fallback;
}

function sanitizeModel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : fallback;
}

function sanitizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Merge unknown input over defaults, clamping every field. Never throws. */
export function sanitizeSettings(input: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!isRecord(input)) return structuredClone(d);
  const ollama = isRecord(input.ollama) ? input.ollama : {};
  const generation = isRecord(input.generation) ? input.generation : {};
  const queue = isRecord(input.queue) ? input.queue : {};
  const memory = isRecord(input.memory) ? input.memory : {};

  return {
    schemaVersion: 1,
    language: isLanguage(input.language) ? input.language : d.language,
    ollama: {
      baseUrl: sanitizeBaseUrl(ollama.baseUrl, d.ollama.baseUrl),
      requestTimeoutMs: clampInt(
        ollama.requestTimeoutMs,
        1000,
        600_000,
        d.ollama.requestTimeoutMs,
      ),
      keepAlive: sanitizeKeepAlive(ollama.keepAlive, d.ollama.keepAlive),
    },
    generation: {
      model: sanitizeModel(generation.model, d.generation.model),
      numCtx: clampInt(generation.numCtx, 512, 131_072, d.generation.numCtx),
      temperature: clampFloat(
        generation.temperature,
        0,
        2,
        d.generation.temperature,
      ),
      numPredict: clampInt(
        generation.numPredict,
        1,
        8192,
        d.generation.numPredict,
      ),
    },
    queue: {
      maxRetries: clampInt(queue.maxRetries, 0, 5, d.queue.maxRetries),
      retryBaseDelayMs: clampInt(
        queue.retryBaseDelayMs,
        100,
        60_000,
        d.queue.retryBaseDelayMs,
      ),
      maxQueueSize: clampInt(queue.maxQueueSize, 1, 100, d.queue.maxQueueSize),
    },
    memory: {
      reserveMb: clampInt(memory.reserveMb, 512, 8192, d.memory.reserveMb),
      enforceBudget: sanitizeBool(
        memory.enforceBudget,
        d.memory.enforceBudget,
      ),
      unloadAfterTask: sanitizeBool(
        memory.unloadAfterTask,
        d.memory.unloadAfterTask,
      ),
    },
  };
}

export class SettingsStore {
  constructor(private kv: KeyValueStore) {}

  async load(): Promise<Settings> {
    const raw = await this.kv.get<unknown>(SETTINGS_KEY);
    if (raw === undefined) return structuredClone(DEFAULT_SETTINGS);
    // Corrupt settings degrade to safe defaults (settings are not a security
    // boundary; fail-closed consent gates arrive with the capture modules).
    return sanitizeSettings(raw);
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const current = await this.load();
    const merged: unknown = {
      ...current,
      ...patch,
      ollama: { ...current.ollama, ...(patch.ollama ?? {}) },
      generation: { ...current.generation, ...(patch.generation ?? {}) },
      queue: { ...current.queue, ...(patch.queue ?? {}) },
      memory: { ...current.memory, ...(patch.memory ?? {}) },
    };
    const next = sanitizeSettings(merged);
    await this.kv.set(SETTINGS_KEY, next);
    return next;
  }

  async reset(): Promise<Settings> {
    const next = structuredClone(DEFAULT_SETTINGS);
    await this.kv.set(SETTINGS_KEY, next);
    return next;
  }
}
