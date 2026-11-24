import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/core/errors';
import {
  answerQuestion,
  CHAT_CALL_TIMEOUT_MS,
  type AnswerOptions,
} from '../../../src/ai/chat/answerer';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
  Transcript,
  TranscriptSegment,
} from '../../../src/ai/types';
import { segmentsToTranscript } from '../../../src/youtube/transcript';

interface ChatCall {
  messages: ChatMessage[];
  options?: GenerationOptions;
}

type Reply = string | Error | ((call: ChatCall) => string | Promise<string>);

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
      throw new AppError('INTERNAL', 'chatStream is not used by chat');
    },
  };
  return { provider, calls };
}

const TRANSCRIPT: Transcript = segmentsToTranscript(
  [
    { startMs: 0, endMs: 5000, text: 'Welcome to the show.' },
    {
      startMs: 5000,
      endMs: 10_000,
      text: 'Tomatoes need six hours of sunlight and regular watering.',
    },
    { startMs: 10_000, endMs: 15_000, text: 'The harvest happens in late summer.' },
  ] satisfies TranscriptSegment[],
  'en',
);

const QUESTION = 'How much sunlight do tomatoes need?';

function options(
  provider: LlmProvider,
  overrides: Partial<AnswerOptions> = {},
): AnswerOptions {
  return {
    provider,
    model: 'fake',
    numCtx: 4096,
    numPredict: 512,
    temperature: 0.2,
    ...overrides,
  };
}

function grounded(): string {
  return JSON.stringify({
    found: true,
    answer: 'Tomatoes need six hours of sunlight.',
    usedSources: [1],
  });
}

describe('answerQuestion', () => {
  it('answers from the retrieved transcript with deterministic citations', async () => {
    const { provider, calls } = fakeProvider([grounded()]);
    const result = await answerQuestion(
      { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
      options(provider),
    );

    expect(result).toMatchObject({
      found: true,
      answer: 'Tomatoes need six hours of sunlight.',
      passageCount: 1,
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      startMs: 5000,
      endMs: 10_000,
    });
    expect(result.citations[0]!.text).toContain('six hours of sunlight');

    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    // All three segments fit in one window, so the passage spans the video.
    expect(prompt).toContain('[1] 0:00-0:15');
    expect(prompt).toContain('Tomatoes need six hours of sunlight');
    expect(prompt).toContain(`Question: ${QUESTION}`);
    expect(calls[0]!.options).toMatchObject({
      model: 'fake',
      numCtx: 4096,
      numPredict: 512,
      temperature: 0.2,
      format: 'json',
      timeoutMs: CHAT_CALL_TIMEOUT_MS,
    });
  });

  it('never calls the model when retrieval finds nothing', async () => {
    const { provider, calls } = fakeProvider([]);
    const result = await answerQuestion(
      {
        title: 'Gardening',
        question: 'What is the capital of France?',
        transcript: TRANSCRIPT,
      },
      options(provider),
    );
    expect(result).toEqual({
      found: false,
      answer: '',
      citations: [],
      passageCount: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it('passes an honest model refusal through without citations', async () => {
    const { provider } = fakeProvider([
      JSON.stringify({ found: false, answer: 'No idea.', usedSources: [] }),
    ]);
    const result = await answerQuestion(
      { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
      options(provider),
    );
    expect(result).toEqual({
      found: false,
      answer: '',
      citations: [],
      passageCount: 1,
    });
  });

  it('retries an invalid reply inside the call and accepts the valid one', async () => {
    const { provider, calls } = fakeProvider(['not json at all', grounded()]);
    const result = await answerQuestion(
      { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
      options(provider),
    );
    expect(result.found).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toHaveLength(3);
    expect(calls[1]!.messages[2]!.content).toContain('previous reply was rejected');
  });

  it('fails with a retryable BAD_RESPONSE after exhausting validation attempts', async () => {
    const { provider, calls } = fakeProvider(['nope', 'still nope']);
    await expect(
      answerQuestion(
        { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
        options(provider),
      ),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE', retryable: true });
    expect(calls).toHaveLength(2);
  });

  it('rejects a citation to a passage that was never supplied', async () => {
    const { provider } = fakeProvider([
      JSON.stringify({ found: true, answer: 'x', usedSources: [9] }),
      JSON.stringify({ found: true, answer: 'x', usedSources: [9] }),
    ]);
    await expect(
      answerQuestion(
        { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
        options(provider),
      ),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('stops before any call when already aborted', async () => {
    const { provider, calls } = fakeProvider([grounded()]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      answerQuestion(
        { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
        options(provider, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an unusable context window and an empty question', async () => {
    const { provider, calls } = fakeProvider([]);
    await expect(
      answerQuestion(
        { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
        options(provider, { numCtx: 512 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      answerQuestion(
        { title: 'Gardening', question: '   ', transcript: TRANSCRIPT },
        options(provider),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });

  it('reports percent-only progress', async () => {
    const { provider } = fakeProvider([grounded()]);
    const seen: Array<number | undefined> = [];
    await answerQuestion(
      { title: 'Gardening', question: QUESTION, transcript: TRANSCRIPT },
      options(provider, {
        onProgress: (progress) => seen.push(progress.percent),
      }),
    );
    expect(seen).toEqual([5, 40, 95]);
  });

  it('includes bounded earlier turns as context, not as evidence', async () => {
    const { provider, calls } = fakeProvider([grounded()]);
    await answerQuestion(
      {
        title: 'Gardening',
        question: QUESTION,
        transcript: TRANSCRIPT,
        history: [
          { role: 'user', text: 'What does the video cover?' },
          { role: 'assistant', text: 'It covers gardening.' },
        ],
      },
      options(provider),
    );
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Earlier turns');
    expect(prompt).toContain('You: What does the video cover?');
    expect(prompt).toContain('Assistant: It covers gardening.');
  });
});
