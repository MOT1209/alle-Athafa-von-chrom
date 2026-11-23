import { AppError } from '../../core/errors';
import { timeoutSignal } from '../../core/abort';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
  LoadedModel,
  ModelInfo,
  ProviderHealth,
} from '../types';

/**
 * Real Ollama HTTP client (https://github.com/ollama/ollama/blob/main/docs/api.md).
 * No simulation: every method performs actual HTTP against the local server.
 * fetch is injectable for tests; production uses the global fetch.
 */

export interface OllamaClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  defaultModel?: string;
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

interface OpenedResponse {
  response: Response;
  dispose: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function nsToMs(value: unknown): number | undefined {
  const ns = asNumber(value);
  return ns === undefined ? undefined : Math.round(ns / 1_000_000);
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly defaultModel: string | undefined;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.defaultModel = options.defaultModel;
  }

  /* ---------------- transport ---------------- */

  private async open(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<OpenedResponse> {
    const timeout = timeoutSignal(
      init.timeoutMs ?? this.requestTimeoutMs,
      init.signal,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers:
          init.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: timeout.signal,
      });
    } catch (err) {
      timeout.dispose();
      if (init.signal?.aborted) {
        throw new AppError('CANCELLED', 'Request cancelled', { cause: err });
      }
      if (timeout.timedOut()) {
        throw new AppError(
          'TIMEOUT',
          `Ollama did not respond within ${init.timeoutMs ?? this.requestTimeoutMs} ms`,
          {
            hint: 'The model may still be loading. Try again, or increase the request timeout in settings.',
            cause: err,
          },
        );
      }
      throw new AppError(
        'NETWORK',
        `Cannot reach Ollama at ${this.baseUrl}`,
        {
          hint: 'Start Ollama first: run "ollama serve" in a terminal (or launch the Ollama app).',
          cause: err,
        },
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        const data: unknown = await response.json();
        if (isRecord(data) && typeof data.error === 'string') {
          detail = data.error;
        } else {
          detail = JSON.stringify(data);
        }
      } catch {
        try {
          detail = await response.text();
        } catch {
          detail = '';
        }
      }
      timeout.dispose();
      if (
        response.status === 404 &&
        /model.*not found|not found.*model/i.test(detail)
      ) {
        throw new AppError('MODEL_NOT_FOUND', detail, {
          hint: 'Pull the model first, e.g. "ollama pull qwen2.5:1.5b".',
          detail: { status: response.status },
        });
      }
      if (response.status === 403) {
        throw new AppError(
          'HTTP',
          'Ollama rejected the request origin (HTTP 403)',
          {
            retryable: false,
            hint: 'Ollama blocks browser-extension origins by default. Allow them: set OLLAMA_ORIGINS=chrome-extension://* (system environment variable), then restart Ollama. See docs/SETUP.md.',
            detail: { status: response.status, body: detail.slice(0, 500) },
          },
        );
      }
      throw new AppError(
        'HTTP',
        `Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        {
          retryable: response.status >= 500 || response.status === 429,
          detail: { status: response.status, body: detail.slice(0, 500) },
        },
      );
    }

    // Header timeout is over; keep the abort link alive for streaming bodies.
    return { response, dispose: timeout.dispose };
  }

  private async requestJson(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const { response, dispose } = await this.open(path, init);
    try {
      let data: unknown;
      try {
        data = await response.json();
      } catch (err) {
        throw new AppError('BAD_RESPONSE', 'Ollama returned invalid JSON', {
          cause: err,
        });
      }
      if (!isRecord(data)) {
        throw new AppError(
          'BAD_RESPONSE',
          'Ollama returned an unexpected JSON shape',
        );
      }
      return data;
    } finally {
      dispose();
    }
  }

  /* ---------------- NDJSON streaming ---------------- */

  private async *streamNdjson(
    response: Response,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    const body = response.body;
    if (!body) {
      throw new AppError('BAD_RESPONSE', 'Ollama response has no body');
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Robust cancellation: cancel the reader directly on abort so a stalled
    // read() unblocks even if the underlying fetch does not tie the signal
    // to the body stream.
    const onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) {
          throw new AppError('CANCELLED', 'Stream cancelled');
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) yield this.parseNdjsonLine(line);
          newline = buffer.indexOf('\n');
        }
      }
      if (signal?.aborted) {
        throw new AppError('CANCELLED', 'Stream cancelled');
      }
      const tail = buffer.trim();
      if (tail.length > 0) yield this.parseNdjsonLine(tail);
    } catch (err) {
      if (signal?.aborted) {
        throw new AppError('CANCELLED', 'Stream cancelled', { cause: err });
      }
      throw AppError.wrap(err, 'NETWORK');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }

  private parseNdjsonLine(line: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new AppError('BAD_RESPONSE', 'Invalid NDJSON line from Ollama', {
        cause: err,
        detail: line.slice(0, 200),
      });
    }
    if (!isRecord(parsed)) {
      throw new AppError('BAD_RESPONSE', 'NDJSON line is not an object');
    }
    if (typeof parsed.error === 'string') {
      throw new AppError('HTTP', `Ollama stream error: ${parsed.error}`, {
        detail: parsed,
      });
    }
    return parsed;
  }

  /* ---------------- management endpoints ---------------- */

  async version(): Promise<string> {
    const data = await this.requestJson('/api/version', { timeoutMs: 8000 });
    const version = asString(data.version);
    if (!version) {
      throw new AppError('BAD_RESPONSE', 'Ollama /api/version missing version');
    }
    return version;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const version = await this.version();
      return { ok: true, version };
    } catch (err) {
      return { ok: false, error: AppError.wrap(err).toJSON() };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.requestJson('/api/tags', { timeoutMs: 15_000 });
    if (!Array.isArray(data.models)) {
      throw new AppError('BAD_RESPONSE', 'Ollama /api/tags missing models[]');
    }
    const models: ModelInfo[] = [];
    for (const entry of data.models) {
      if (!isRecord(entry)) continue;
      const name = asString(entry.name);
      const size = asNumber(entry.size);
      if (!name || size === undefined) continue;
      const details = isRecord(entry.details) ? entry.details : {};
      const model: ModelInfo = { name, sizeBytes: size };
      const family = asString(details.family);
      const parameterSize = asString(details.parameter_size);
      const quantization = asString(details.quantization_level);
      const modifiedAt = asString(entry.modified_at);
      if (family) model.family = family;
      if (parameterSize) model.parameterSize = parameterSize;
      if (quantization) model.quantization = quantization;
      if (modifiedAt) model.modifiedAt = modifiedAt;
      models.push(model);
    }
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadedModels(): Promise<LoadedModel[]> {
    const data = await this.requestJson('/api/ps', { timeoutMs: 10_000 });
    if (!Array.isArray(data.models)) {
      throw new AppError('BAD_RESPONSE', 'Ollama /api/ps missing models[]');
    }
    const loaded: LoadedModel[] = [];
    for (const entry of data.models) {
      if (!isRecord(entry)) continue;
      const name = asString(entry.name);
      if (!name) continue;
      const model: LoadedModel = {
        name,
        sizeBytes: asNumber(entry.size) ?? 0,
        sizeVramBytes: asNumber(entry.size_vram) ?? 0,
      };
      const expiresAt = asString(entry.expires_at);
      if (expiresAt) model.expiresAt = expiresAt;
      loaded.push(model);
    }
    return loaded;
  }

  async deleteModel(model: string): Promise<void> {
    await this.requestJson('/api/delete', {
      method: 'DELETE',
      body: { name: model },
      timeoutMs: 30_000,
    });
  }

  /** Pull a model with real progress events. Resolves when status=success. */
  async pull(
    model: string,
    onProgress?: (progress: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { response, dispose } = await this.open('/api/pull', {
      method: 'POST',
      body: { name: model, stream: true },
      signal,
      // Pulls can take many minutes; the header timeout still applies but the
      // stream itself is not time-limited (Ollama keeps sending status lines).
      timeoutMs: 60_000,
    });
    try {
      let sawSuccess = false;
      for await (const event of this.streamNdjson(response, signal)) {
        const status = asString(event.status) ?? 'unknown';
        const progress: PullProgress = { status };
        const digest = asString(event.digest);
        const total = asNumber(event.total);
        const completed = asNumber(event.completed);
        if (digest) progress.digest = digest;
        if (total !== undefined) progress.total = total;
        if (completed !== undefined) progress.completed = completed;
        if (total !== undefined && total > 0 && completed !== undefined) {
          progress.percent = Math.min(
            100,
            Math.round((completed / total) * 100),
          );
        }
        onProgress?.(progress);
        if (status === 'success') sawSuccess = true;
      }
      if (!sawSuccess) {
        throw new AppError(
          'BAD_RESPONSE',
          'Ollama pull stream ended without a success status',
        );
      }
    } finally {
      dispose();
    }
  }

  /* ---------------- generation ---------------- */

  private resolveModel(options?: GenerationOptions): string {
    const model = options?.model ?? this.defaultModel;
    if (!model || model.trim().length === 0) {
      throw new AppError(
        'NOT_CONFIGURED',
        'No model configured for this request',
        { hint: 'Choose a default model in the VideoMind popup.' },
      );
    }
    return model;
  }

  private buildOptions(options?: GenerationOptions): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (options?.numCtx !== undefined) out.num_ctx = options.numCtx;
    if (options?.temperature !== undefined)
      out.temperature = options.temperature;
    if (options?.numPredict !== undefined)
      out.num_predict = options.numPredict;
    return out;
  }

  private validateMessages(messages: ChatMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AppError('INVALID_INPUT', 'chat requires at least one message');
    }
    for (const message of messages) {
      if (
        !isRecord(message) ||
        !['system', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string'
      ) {
        throw new AppError('INVALID_INPUT', 'Invalid chat message shape');
      }
    }
  }

  async chat(
    messages: ChatMessage[],
    options?: GenerationOptions,
  ): Promise<ChatResult> {
    this.validateMessages(messages);
    const model = this.resolveModel(options);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: this.buildOptions(options),
    };
    if (options?.keepAlive !== undefined) body.keep_alive = options.keepAlive;
    if (options?.format === 'json') body.format = 'json';

    const data = await this.requestJson('/api/chat', {
      method: 'POST',
      body,
      signal: options?.signal,
    });
    return this.parseChatResult(data, model);
  }

  async chatStream(
    messages: ChatMessage[],
    options: GenerationOptions,
    onToken: (token: string) => void,
  ): Promise<ChatResult> {
    this.validateMessages(messages);
    const model = this.resolveModel(options);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      options: this.buildOptions(options),
    };
    if (options.keepAlive !== undefined) body.keep_alive = options.keepAlive;
    if (options.format === 'json') body.format = 'json';

    const { response, dispose } = await this.open('/api/chat', {
      method: 'POST',
      body,
      signal: options.signal,
    });
    try {
      let content = '';
      let finalEvent: Record<string, unknown> | undefined;
      for await (const event of this.streamNdjson(response, options.signal)) {
        const message = isRecord(event.message) ? event.message : undefined;
        const token = message ? asString(message.content) : undefined;
        if (token && token.length > 0) {
          content += token;
          onToken(token);
        }
        if (event.done === true) finalEvent = event;
      }
      if (!finalEvent) {
        throw new AppError(
          'BAD_RESPONSE',
          'Ollama chat stream ended without a done event',
        );
      }
      return this.parseChatResult(finalEvent, model, content);
    } finally {
      dispose();
    }
  }

  async generate(
    prompt: string,
    options?: GenerationOptions,
  ): Promise<ChatResult> {
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new AppError('INVALID_INPUT', 'generate requires a prompt');
    }
    const model = this.resolveModel(options);
    const body: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
      options: this.buildOptions(options),
    };
    if (options?.keepAlive !== undefined) body.keep_alive = options.keepAlive;
    if (options?.format === 'json') body.format = 'json';

    const data = await this.requestJson('/api/generate', {
      method: 'POST',
      body,
      signal: options?.signal,
    });
    const content = asString(data.response);
    if (content === undefined || data.done !== true) {
      throw new AppError(
        'BAD_RESPONSE',
        'Ollama /api/generate returned an unexpected shape',
      );
    }
    const result: ChatResult = { content, model, done: true };
    const evalCount = asNumber(data.eval_count);
    const evalDuration = nsToMs(data.eval_duration);
    const totalDuration = nsToMs(data.total_duration);
    if (evalCount !== undefined) result.evalCount = evalCount;
    if (evalDuration !== undefined) result.evalDurationMs = evalDuration;
    if (totalDuration !== undefined) result.totalDurationMs = totalDuration;
    return result;
  }

  private parseChatResult(
    data: Record<string, unknown>,
    model: string,
    streamedContent?: string,
  ): ChatResult {
    const message = isRecord(data.message) ? data.message : undefined;
    const content =
      streamedContent ?? (message ? asString(message.content) : undefined);
    if (content === undefined) {
      throw new AppError(
        'BAD_RESPONSE',
        'Ollama chat response missing message.content',
      );
    }
    const result: ChatResult = {
      content,
      model: asString(data.model) ?? model,
      done: data.done === true,
    };
    const evalCount = asNumber(data.eval_count);
    const evalDuration = nsToMs(data.eval_duration);
    const totalDuration = nsToMs(data.total_duration);
    if (evalCount !== undefined) result.evalCount = evalCount;
    if (evalDuration !== undefined) result.evalDurationMs = evalDuration;
    if (totalDuration !== undefined) result.totalDurationMs = totalDuration;
    return result;
  }
}
