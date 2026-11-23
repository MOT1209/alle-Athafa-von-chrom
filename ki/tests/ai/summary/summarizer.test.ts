import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/core/errors';
import type { TaskProgress } from '../../../src/ai/queue';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
  Transcript,
  TranscriptSegment,
} from '../../../src/ai/types';
import {
  ensureNotAborted,
  summarizeTranscript,
  SUMMARY_CALL_TIMEOUT_MS,
  type SummarizeOptions,
} from '../../../src/ai/summary/summarizer';

interface ChatCall {
  messages: ChatMessage[];
  options?: GenerationOptions;
}

type Reply =
  | string
  | Error
  | ((call: ChatCall) => string | Promise<string>);

function fakeProvider(script: Reply[]): {
  provider: LlmProvider;
  calls: ChatCall[];
} {
  const calls: ChatCall[] = [];
  const remaining = [...script];
  const provider: LlmProvider = {
    id: 'fake',
    async health() {
      return { ok: true };
    },
    async listModels() {
      return [];
    },
    async loadedModels() {
      return [];
    },
    async chat(messages, options): Promise<ChatResult> {
      const call: ChatCall = { messages };
      if (options !== undefined) call.options = options;
      calls.push(call);
      const next = remaining.shift();
      if (next === undefined) {
        throw new AppError('INTERNAL', 'The test script has no reply left');
      }
      if (next instanceof Error) throw next;
      const content = typeof next === 'function' ? await next(call) : next;
      return { content, model: 'fake', done: true };
    },
    async chatStream(): Promise<ChatResult> {
      throw new AppError('INTERNAL', 'chatStream is not used by summarization');
    },
  };
  return { provider, calls };
}

function words(length: number): string {
  let text = '';
  while (text.length < length) {
    text += text.length === 0 ? 'word' : ' word';
  }
  return text.slice(0, length).trimEnd();
}

function transcriptOf(segments: TranscriptSegment[]): Transcript {
  return {
    segments,
    text: segments.map((segment) => segment.text).join('\n'),
    source: 'captions',
  };
}

function smallTranscript(): Transcript {
  return transcriptOf([
    { startMs: 0, endMs: 2000, text: 'The host introduces the topic.' },
    { startMs: 2000, endMs: 4000, text: 'The guest explains the details.' },
  ]);
}

function twoChunkTranscript(): Transcript {
  return transcriptOf([
    { startMs: 0, endMs: 300_000, text: words(5000) },
    { startMs: 300_000, endMs: 600_000, text: words(5000) },
  ]);
}

function mapReply(summary = 'A factual summary of this part.'): string {
  return JSON.stringify({
    summary,
    keyPoints: [{ timestampMs: 1000, text: 'A factual point.' }],
  });
}

function notesOnly(summary: string): string {
  return JSON.stringify({ summary, keyPoints: [] });
}

function finalReply(): string {
  return JSON.stringify({
    overview: 'A factual overview of the whole video.',
    keyPoints: [
      { timestampMs: 0, text: 'Opening point.' },
      { timestampMs: 2000, text: 'Second point.' },
    ],
    chapters: [
      {
        startMs: 0,
        title: 'Introduction',
        summary: 'The host introduces the topic.',
      },
      {
        startMs: 2000,
        title: 'Details',
        summary: 'The guest explains the details.',
      },
    ],
  });
}

function optionsFor(
  provider: LlmProvider,
  overrides: Partial<SummarizeOptions> = {},
): SummarizeOptions {
  return {
    provider,
    model: 'test-model',
    numCtx: 4096,
    numPredict: 512,
    temperature: 0.2,
    ...overrides,
  };
}

function expectCode(fn: () => Promise<unknown>, code: string) {
  return expect(fn).rejects.toMatchObject({ code });
}

describe('summarizeTranscript — map and final', () => {
  it('summarizes a single-chunk transcript with schema-validated output', async () => {
    const { provider, calls } = fakeProvider([mapReply(), finalReply()]);
    const progress: TaskProgress[] = [];
    const result = await summarizeTranscript(
      { title: 'Test video', durationMs: 4000, transcript: smallTranscript() },
      optionsFor(provider, {
        keepAlive: '0',
        onProgress: (update) => progress.push(update),
      }),
    );

    expect(result.chunkCount).toBe(1);
    expect(result.mergeRounds).toBe(0);
    expect(result.summary.overview).toContain('factual overview');
    expect(result.summary.keyPoints).toHaveLength(2);
    expect(result.summary.chapters).toHaveLength(2);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.messages[0]?.content).toContain(
      'summarize one part of a video transcript',
    );
    expect(calls[0]?.messages[1]?.content ?? '').toContain('Test video');
    expect(calls[0]?.messages[1]?.content ?? '').toContain(
      '[0:00] The host introduces the topic.',
    );
    expect(calls[0]?.options).toMatchObject({
      model: 'test-model',
      numCtx: 4096,
      numPredict: 512,
      temperature: 0.2,
      format: 'json',
      keepAlive: '0',
      timeoutMs: SUMMARY_CALL_TIMEOUT_MS,
    });
    expect(calls[1]?.options?.numPredict).toBe(900);
    expect(calls[1]?.messages[1]?.content ?? '').toContain(
      'Duration: 0:04.',
    );
    expect(calls[1]?.messages[1]?.content ?? '').toContain(
      '[1000 ms | 0:01] A factual point.',
    );

    expect(progress.map((update) => update.percent)).toEqual([
      1, 65, 90, 100,
    ]);
    expect(progress.at(-1)?.message).toBe('Summary ready');
  });

  it('runs one map call per chunk, strictly in order', async () => {
    const { provider, calls } = fakeProvider([
      mapReply(),
      mapReply(),
      finalReply(),
    ]);
    const progress: TaskProgress[] = [];
    const result = await summarizeTranscript(
      { title: 'Long video', transcript: twoChunkTranscript() },
      optionsFor(provider, { onProgress: (update) => progress.push(update) }),
    );

    expect(result.chunkCount).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.messages[1]?.content ?? '').toContain('part 1/2');
    expect(calls[1]?.messages[1]?.content ?? '').toContain('part 2/2');
    expect(progress.some((update) => update.message === 'Summarized part 1/2')).toBe(
      true,
    );
    expect(progress.some((update) => update.message === 'Summarized part 2/2')).toBe(
      true,
    );
  });

  it('merges notes that no longer fit the final prompt budget', async () => {
    const { provider, calls } = fakeProvider([
      notesOnly('a'.repeat(1500)),
      notesOnly('b'.repeat(1500)),
      notesOnly('Merged notes.'),
      finalReply(),
    ]);
    const progress: TaskProgress[] = [];
    const result = await summarizeTranscript(
      {
        title: 'Merge video',
        transcript: transcriptOf([
          { startMs: 0, endMs: 100_000, text: words(2000) },
          { startMs: 100_000, endMs: 200_000, text: words(2000) },
        ]),
      },
      optionsFor(provider, {
        numCtx: 2048,
        onProgress: (update) => progress.push(update),
      }),
    );

    expect(result.chunkCount).toBe(2);
    expect(result.mergeRounds).toBe(1);
    expect(calls).toHaveLength(4);
    expect(calls[2]?.messages[1]?.content ?? '').toContain(
      'Merge round 1/3.',
    );
    expect(progress.some((update) => update.message === 'Merged notes (round 1)')).toBe(
      true,
    );
  });

  it('rejects notes that still exceed the context window', async () => {
    const { provider } = fakeProvider([
      notesOnly('a'.repeat(1500)),
      notesOnly('b'.repeat(1500)),
    ]);
    await expectCode(
      () =>
        summarizeTranscript(
          {
            title: 'Too large',
            transcript: transcriptOf([
              { startMs: 0, endMs: 100_000, text: words(2000) },
              { startMs: 100_000, endMs: 200_000, text: words(2000) },
            ]),
          },
          optionsFor(provider, { numCtx: 2048, maxMergeRounds: 0 }),
        ),
      'INVALID_INPUT',
    );
  });
});

describe('summarizeTranscript — validation retries', () => {
  it('retries invalid JSON inside the same model call', async () => {
    const { provider, calls } = fakeProvider([
      'this is not json',
      mapReply(),
      finalReply(),
    ]);
    const result = await summarizeTranscript(
      { title: 'Retry video', transcript: smallTranscript() },
      optionsFor(provider),
    );
    expect(result.chunkCount).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.messages).toHaveLength(2);
    expect(calls[1]?.messages).toHaveLength(3);
    expect(calls[1]?.messages.at(-1)?.content ?? '').toContain('rejected');
    expect(calls[1]?.messages.at(-1)?.content ?? '').toContain(
      'ONLY one valid JSON object',
    );
  });

  it('retries a BAD_RESPONSE thrown by the provider', async () => {
    const { provider, calls } = fakeProvider([
      new AppError('BAD_RESPONSE', 'broken stream'),
      mapReply(),
      finalReply(),
    ]);
    const result = await summarizeTranscript(
      { title: 'Retry video', transcript: smallTranscript() },
      optionsFor(provider),
    );
    expect(result.chunkCount).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('fails permanently with a retryable BAD_RESPONSE after exhausting attempts', async () => {
    const { provider, calls } = fakeProvider(['bad', 'still bad']);
    await expect(
      summarizeTranscript(
        { title: 'Bad video', transcript: smallTranscript() },
        optionsFor(provider),
      ),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE', retryable: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.messages).toHaveLength(2);
    expect(calls[1]?.messages).toHaveLength(3);
  });

  it('honors an explicit attempt limit', async () => {
    const { provider, calls } = fakeProvider(['bad']);
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Bad video', transcript: smallTranscript() },
          optionsFor(provider, { internalAttempts: 1 }),
        ),
      'BAD_RESPONSE',
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects an invalid final summary and never returns it', async () => {
    const { provider, calls } = fakeProvider([
      mapReply(),
      JSON.stringify({ overview: 'missing points and chapters' }),
      JSON.stringify({ overview: 'still missing' }),
    ]);
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Bad final', transcript: smallTranscript() },
          optionsFor(provider),
        ),
      'BAD_RESPONSE',
    );
    expect(calls).toHaveLength(3);
  });
});

describe('summarizeTranscript — error and cancellation paths', () => {
  it('does not internally retry network failures', async () => {
    const { provider, calls } = fakeProvider([
      new AppError('NETWORK', 'connection refused'),
    ]);
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Offline', transcript: smallTranscript() },
          optionsFor(provider),
        ),
      'NETWORK',
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid input before any model call', async () => {
    const { provider, calls } = fakeProvider([]);
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Empty', transcript: transcriptOf([]) },
          optionsFor(provider),
        ),
      'INVALID_INPUT',
    );
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Blank model', transcript: smallTranscript() },
          optionsFor(provider, { model: '   ' }),
        ),
      'INVALID_INPUT',
    );
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Small context', transcript: smallTranscript() },
          optionsFor(provider, { numCtx: 512 }),
        ),
      'INVALID_INPUT',
    );
    expect(calls).toHaveLength(0);
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = fakeProvider([]);
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Cancelled', transcript: smallTranscript() },
          optionsFor(provider, { signal: controller.signal }),
        ),
      'CANCELLED',
    );
    expect(calls).toHaveLength(0);
  });

  it('stops between map calls when cancellation arrives mid-run', async () => {
    const controller = new AbortController();
    const { provider, calls } = fakeProvider([
      () => {
        controller.abort();
        return mapReply();
      },
    ]);
    await expectCode(
      () =>
        summarizeTranscript(
          { title: 'Cancelled mid-run', transcript: twoChunkTranscript() },
          optionsFor(provider, { signal: controller.signal }),
        ),
      'CANCELLED',
    );
    expect(calls).toHaveLength(1);
  });

  it('ensureNotAborted only throws for aborted signals', () => {
    expect(() => ensureNotAborted(undefined)).not.toThrow();
    expect(() => ensureNotAborted(new AbortController().signal)).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() => ensureNotAborted(controller.signal)).toThrowError(
      expect.objectContaining({ code: 'CANCELLED' }),
    );
  });
});
