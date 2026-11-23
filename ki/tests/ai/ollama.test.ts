import { describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/ai/providers/ollama';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ndjsonResponse(events: unknown[]): Response {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  return new Response(body, { status: 200 });
}

function chunkedResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function makeProvider(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  options: { requestTimeoutMs?: number; defaultModel?: string } = {},
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  const provider = new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434/',
    fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs ?? 5000,
    defaultModel: options.defaultModel ?? 'qwen2.5:1.5b',
  });
  return { provider, calls };
}

describe('OllamaProvider — management endpoints', () => {
  it('version() reads /api/version', async () => {
    const { provider, calls } = makeProvider(() => jsonResponse({ version: '0.40.6' }));
    expect(await provider.version()).toBe('0.40.6');
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/version');
  });

  it('version() rejects malformed payloads', async () => {
    const { provider } = makeProvider(() => jsonResponse({}));
    await expect(provider.version()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('health() reports ok with version', async () => {
    const { provider } = makeProvider(() => jsonResponse({ version: '0.40.6' }));
    expect(await provider.health()).toEqual({ ok: true, version: '0.40.6' });
  });

  it('health() reports typed failure instead of throwing', async () => {
    const { provider } = makeProvider(() => Promise.reject(new TypeError('fetch failed')));
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.error?.code).toBe('NETWORK');
    expect(health.error?.hint).toContain('ollama serve');
  });

  it('listModels() maps, sorts and skips malformed entries', async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({
        models: [
          {
            name: 'qwen2.5:3b',
            size: 1_900_000_000,
            modified_at: '2026-01-01T00:00:00Z',
            details: { family: 'qwen2', parameter_size: '3.1B', quantization_level: 'Q4_K_M' },
          },
          { name: 'qwen2.5:1.5b', size: 986_000_000, details: {} },
          { size: 5 },
          null,
        ],
      }),
    );
    const models = await provider.listModels();
    expect(models.map((m) => m.name)).toEqual(['qwen2.5:1.5b', 'qwen2.5:3b']);
    expect(models[1]?.parameterSize).toBe('3.1B');
    expect(models[1]?.quantization).toBe('Q4_K_M');
    expect(models[1]?.family).toBe('qwen2');
    expect(models[1]?.modifiedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('listModels() rejects missing models array', async () => {
    const { provider } = makeProvider(() => jsonResponse({ nope: true }));
    await expect(provider.listModels()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('loadedModels() maps /api/ps including VRAM', async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({
        models: [
          { name: 'qwen2.5:1.5b', size: 986_000_000, size_vram: 0, expires_at: '2026-01-01T00:05:00Z' },
        ],
      }),
    );
    const loaded = await provider.loadedModels();
    expect(loaded[0]?.name).toBe('qwen2.5:1.5b');
    expect(loaded[0]?.sizeVramBytes).toBe(0);
    expect(loaded[0]?.expiresAt).toBe('2026-01-01T00:05:00Z');
  });

  it('deleteModel() sends DELETE with the model name', async () => {
    const { provider, calls } = makeProvider(() => jsonResponse({}));
    await provider.deleteModel('qwen2.5:1.5b');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/api/delete');
    expect(calls[0]?.body).toEqual({ name: 'qwen2.5:1.5b' });
  });
});

describe('OllamaProvider — error mapping', () => {
  it('network failure becomes NETWORK with a start-Ollama hint', async () => {
    const { provider } = makeProvider(() => Promise.reject(new TypeError('fetch failed')));
    await expect(provider.listModels()).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
    });
  });

  it('404 model-not-found becomes MODEL_NOT_FOUND', async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ error: "model 'qwen2.5:1.5b' not found, try pulling it first" }, 404),
    );
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false });
  });

  it('5xx is retryable, 4xx is not', async () => {
    const server = makeProvider(() => jsonResponse({ error: 'boom' }, 500));
    await expect(server.provider.listModels()).rejects.toMatchObject({
      code: 'HTTP',
      retryable: true,
    });
    const client = makeProvider(() => jsonResponse({ error: 'bad request' }, 400));
    await expect(client.provider.listModels()).rejects.toMatchObject({
      code: 'HTTP',
      retryable: false,
    });
  });

  it('403 origin rejection explains OLLAMA_ORIGINS', async () => {
    const { provider } = makeProvider(() => new Response('', { status: 403 }));
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({
      code: 'HTTP',
      retryable: false,
      hint: expect.stringContaining('OLLAMA_ORIGINS'),
    });
  });

  it('invalid JSON body becomes BAD_RESPONSE', async () => {
    const { provider } = makeProvider(() => new Response('not json', { status: 200 }));
    await expect(provider.version()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('external cancellation becomes CANCELLED', async () => {
    const controller = new AbortController();
    const { provider } = makeProvider((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const promise = provider.chat([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('header timeout becomes TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const { provider } = makeProvider(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
        { requestTimeoutMs: 1000 },
      );
      const promise = provider.version();
      const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      // /api/version uses a fixed 8s header timeout.
      await vi.advanceTimersByTimeAsync(8100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('no model configured becomes NOT_CONFIGURED', async () => {
    const { provider } = makeProvider(() => jsonResponse({}), { defaultModel: undefined });
    const bare = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434' });
    await expect(bare.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(provider).toBeDefined();
  });

  it('invalid messages become INVALID_INPUT', async () => {
    const { provider } = makeProvider(() => jsonResponse({}));
    await expect(provider.chat([])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      provider.chat([{ role: 'tool', content: 'x' } as never]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('OllamaProvider — chat', () => {
  it('sends the documented /api/chat body and parses the reply', async () => {
    const { provider, calls } = makeProvider(() =>
      jsonResponse({
        model: 'qwen2.5:1.5b',
        message: { role: 'assistant', content: 'OK' },
        done: true,
        eval_count: 2,
        eval_duration: 20_000_000,
        total_duration: 1_500_000_000,
      }),
    );
    const result = await provider.chat(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'say OK' },
      ],
      { numCtx: 2048, temperature: 0, numPredict: 8, keepAlive: '0' },
    );
    expect(result.content).toBe('OK');
    expect(result.done).toBe(true);
    expect(result.evalCount).toBe(2);
    expect(result.evalDurationMs).toBe(20);
    expect(result.totalDurationMs).toBe(1500);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.model).toBe('qwen2.5:1.5b');
    expect(body.stream).toBe(false);
    expect(body.keep_alive).toBe('0');
    expect(body.options).toEqual({ num_ctx: 2048, temperature: 0, num_predict: 8 });
    expect(body.messages).toHaveLength(2);
  });

  it('rejects a response without message.content', async () => {
    const { provider } = makeProvider(() => jsonResponse({ done: true }));
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('chatStream accumulates tokens and emits each one', async () => {
    const { provider } = makeProvider(() =>
      ndjsonResponse([
        { message: { content: 'Hel' }, done: false },
        { message: { content: 'lo' }, done: false },
        { message: { content: '' }, done: true, eval_count: 2 },
      ]),
    );
    const tokens: string[] = [];
    const result = await provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      {},
      (token) => tokens.push(token),
    );
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(result.content).toBe('Hello');
    expect(result.done).toBe(true);
    expect(result.evalCount).toBe(2);
  });

  it('chatStream handles NDJSON split across chunk boundaries', async () => {
    const { provider } = makeProvider(() =>
      chunkedResponse([
        '{"message":{"content":"A"},"done":false}\n{"mess',
        'age":{"content":"B"},"done":false}\n',
        '{"message":{"content":""},"done":true}',
      ]),
    );
    const result = await provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      {},
      () => {},
    );
    expect(result.content).toBe('AB');
  });

  it('chatStream fails when no done event arrives', async () => {
    const { provider } = makeProvider(() =>
      ndjsonResponse([{ message: { content: 'x' }, done: false }]),
    );
    await expect(
      provider.chatStream([{ role: 'user', content: 'hi' }], {}, () => {}),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('chatStream surfaces mid-stream error events', async () => {
    const { provider } = makeProvider(() =>
      ndjsonResponse([{ error: 'model requires more system memory' }]),
    );
    await expect(
      provider.chatStream([{ role: 'user', content: 'hi' }], {}, () => {}),
    ).rejects.toMatchObject({ code: 'HTTP' });
  });

  it('invalid NDJSON line becomes BAD_RESPONSE', async () => {
    const { provider } = makeProvider(() => chunkedResponse(['{broken\n']));
    await expect(
      provider.chatStream([{ role: 'user', content: 'hi' }], {}, () => {}),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('OllamaProvider — generate', () => {
  it('parses /api/generate responses', async () => {
    const { provider, calls } = makeProvider(() =>
      jsonResponse({ model: 'qwen2.5:1.5b', response: 'summary text', done: true }),
    );
    const result = await provider.generate('summarize this');
    expect(result.content).toBe('summary text');
    expect((calls[0]?.body as Record<string, unknown>).prompt).toBe('summarize this');
  });

  it('rejects empty prompts and malformed responses', async () => {
    const { provider } = makeProvider(() => jsonResponse({ done: true }));
    await expect(provider.generate('')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.generate('x')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('OllamaProvider — pull', () => {
  it('streams progress with percentages and resolves on success', async () => {
    const { provider, calls } = makeProvider(() =>
      ndjsonResponse([
        { status: 'pulling manifest' },
        { status: 'downloading', digest: 'sha256:abc', total: 1000, completed: 250 },
        { status: 'downloading', digest: 'sha256:abc', total: 1000, completed: 1000 },
        { status: 'verifying sha256 digest' },
        { status: 'success' },
      ]),
    );
    const progress: Array<{ status: string; percent?: number }> = [];
    await provider.pull('qwen2.5:1.5b', (p) => progress.push(p));
    expect((calls[0]?.body as Record<string, unknown>).name).toBe('qwen2.5:1.5b');
    expect(progress[1]?.percent).toBe(25);
    expect(progress[2]?.percent).toBe(100);
    expect(progress.at(-1)?.status).toBe('success');
  });

  it('fails when the stream ends without success', async () => {
    const { provider } = makeProvider(() =>
      ndjsonResponse([{ status: 'downloading', total: 10, completed: 1 }]),
    );
    await expect(provider.pull('x')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('cancellation during pull becomes CANCELLED', async () => {
    const controller = new AbortController();
    const { provider } = makeProvider(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"status":"downloading"}\n'));
          // Never closes; cancellation must break the read.
        },
      });
      return new Response(stream, { status: 200 });
    });
    const promise = provider.pull('x', undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
