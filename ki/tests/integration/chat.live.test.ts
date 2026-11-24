/**
 * LIVE Phase 4 acceptance: transcript-grounded chat with real citations.
 *
 * Skipped by default. Run with: npm run test:live:chat
 * Requires `ollama serve` and a real model (qwen2.5:1.5b preferred).
 *
 * This proves the acceptance path on real hardware: stored transcript ->
 * local lexical retrieval -> one sequential model call -> validated answer ->
 * deterministic citations -> persisted exchange, plus an honest "not in the
 * video" answer that never touches the model. Failure/cancel/retry paths are
 * proven deterministically in the unit/integration suites.
 */
import { describe, expect, it, vi } from 'vitest';
import { nodeFetch } from '../helpers/node-fetch';
import { OllamaProvider } from '../../src/ai/providers/ollama';
import { TaskQueue } from '../../src/ai/queue';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
  TranscriptSegment,
} from '../../src/ai/types';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { ChatRepository, type ChatRecord } from '../../src/chat/repository';
import { ChatService } from '../../src/chat/service';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { segmentsToTranscript } from '../../src/youtube/transcript';

const live =
  process.env.VM_LIVE_OLLAMA === '1' && process.env.VM_LIVE_CHAT === '1';
const baseUrl = process.env.VM_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const provider = live
  ? new OllamaProvider({
      baseUrl,
      requestTimeoutMs: 1_800_000,
      fetchImpl: nodeFetch,
    })
  : undefined;

const installed = live
  ? await provider!.listModels().catch(() => [])
  : [];
const targetModel =
  process.env.VM_LIVE_CHAT_MODEL?.trim() ||
  installed.find((model) => model.name === 'qwen2.5:1.5b')?.name ||
  installed[0]?.name;

/* ---------------- ~3.5-minute fixture ---------------- */

const SCRIPT: string[] = [
  'Welcome back to the balcony garden series.',
  'Today I am growing two tomato plants in containers, and I will explain the exact routine that worked for me.',
  'The first thing people get wrong is the pot size.',
  'Each tomato plant needs at least twenty liters of soil, so a small decorative pot will not work.',
  'I use a fabric grow bag that drains well and keeps the roots cool.',
  'Fill it with a mix of compost and garden soil, not pure potting soil.',
  'Tomatoes are sun-hungry plants.',
  'They need six hours of direct sunlight every day, and eight hours is even better.',
  'On a balcony, that usually means the railing side, not the wall side.',
  'If your balcony gets less than six hours, choose a cherry variety instead of a beefsteak.',
  'Watering is where most balcony tomatoes fail.',
  'Do not water a little every day.',
  'Water deeply twice a week, until water runs out of the bottom of the bag.',
  'Check the soil with your finger before watering; if it is still wet two centimeters down, wait.',
  'Never water the leaves in the evening, because wet leaves invite blight.',
  'In a heat wave you may need to water three times a week, but still deeply.',
  'Start feeding two weeks after planting.',
  'Use a tomato fertilizer once every ten days, and halve the dose in the first month.',
  'Remove the side shoots that grow between the main stem and a branch.',
  'Keep the lower leaves off the soil so air can move under the plant.',
  'Cherry tomatoes are ready sixty to seventy days after planting.',
  'Pick them when they are fully colored and slightly soft.',
  'Harvest every two days in summer, because ripe fruit slows new fruit.',
  'At the end of the season, remove the plants and refresh the soil before planting again.',
  'That is the whole routine: a big container, six hours of sun, deep watering, regular feeding, and steady harvesting.',
  'The full checklist is linked in the description.',
];

const SEGMENTS: TranscriptSegment[] = SCRIPT.map((text, index) => {
  const startMs = index * 8000;
  return { startMs, endMs: startMs + 7500, text };
});
const TRANSCRIPT = segmentsToTranscript(SEGMENTS, 'en');
const DURATION_MS = SEGMENTS[SEGMENTS.length - 1]!.endMs;

interface ChatCall {
  index: number;
  promptChars: number;
  latencyMs: number;
}

function instrumentedProvider(): {
  provider: LlmProvider;
  calls: ChatCall[];
} {
  const calls: ChatCall[] = [];
  let callIndex = 0;
  const wrapped: LlmProvider = {
    id: provider!.id,
    health: () => provider!.health(),
    listModels: () => provider!.listModels(),
    loadedModels: () => provider!.loadedModels(),
    async chat(
      messages: ChatMessage[],
      options?: GenerationOptions,
    ): Promise<ChatResult> {
      const index = (callIndex += 1);
      const promptChars = messages.reduce(
        (sum, message) => sum + message.content.length,
        0,
      );
      const startedAt = Date.now();
      console.log(
        `[live-chat] model call ${index} started: promptChars=${promptChars} timeoutMs=${options?.timeoutMs ?? 'provider-default'}`,
      );
      let result: ChatResult;
      try {
        result = await provider!.chat(messages, options);
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'NO_CODE';
        console.log(
          `[live-chat] model call ${index} FAILED after ${latencyMs}ms code=${code} detail=${detail}`,
        );
        throw error;
      }
      const latencyMs = Date.now() - startedAt;
      calls.push({ index, promptChars, latencyMs });
      console.log(
        `[live-chat] model call ${index}: promptChars=${promptChars} latency=${latencyMs}ms evalCount=${result.evalCount ?? '?'}`,
      );
      return result;
    },
    chatStream: (messages, options, onToken) =>
      provider!.chatStream(messages, options, onToken),
  };
  return { provider: wrapped, calls };
}

function fixtureTexts(): Set<string> {
  return new Set(SEGMENTS.map((segment) => segment.text));
}

async function waitForTerminal(
  queue: TaskQueue,
  taskId: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      const view = queue.get(taskId);
      expect(
        view !== undefined &&
          ['succeeded', 'failed', 'cancelled'].includes(view.status),
      ).toBe(true);
    },
    { timeout: 1_500_000, interval: 500 },
  );
}

describe.skipIf(!live || !targetModel)('Chat LIVE acceptance', () => {
  it(
    'answers from the real transcript with citations, then refuses a miss honestly',
    async () => {
      const model = targetModel;
      if (!model) throw new Error('No local Ollama model is installed.');

      const kv = new MemoryStore();
      const settings = new SettingsStore(kv);
      await settings.update({
        generation: {
          model,
          numCtx: 4096,
          numPredict: 512,
          temperature: 0.2,
        },
        memory: { unloadAfterTask: false },
      });

      const videoId = 'live-chat-fixture';
      const recordId = videoIdFor(videoId);
      const videos = new VideoRepository(kv);
      await videos.save({
        id: recordId,
        platform: 'youtube',
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: 'Balcony tomatoes (live chat fixture)',
        channel: 'videoKING AI',
        durationMs: DURATION_MS,
        language: 'en',
        captionKind: 'manual',
        segmentCount: SEGMENTS.length,
        capturedAt: Date.now(),
        transcript: TRANSCRIPT,
      });

      const { provider: llm, calls } = instrumentedProvider();
      const queue = new TaskQueue({
        maxRetries: 1,
        retryBaseDelayMs: 1000,
      });
      const chats = new ChatRepository(kv);
      const service = new ChatService({
        settings,
        videos,
        chats,
        queue,
        makeProvider: () => llm,
      });

      console.log(
        `[live-chat] fixture: duration=${Math.round(DURATION_MS / 1000)}s segments=${SEGMENTS.length} chars=${TRANSCRIPT.text.length} model=${model}`,
      );

      /* -------- grounded question -------- */
      const question =
        'How many hours of direct sunlight do tomato plants need?';
      const startedAt = Date.now();
      const first = await service.ask({ videoRecordId: recordId, question });
      expect(first.deduped).toBe(false);
      await waitForTerminal(queue, first.taskId);
      const firstTask = queue.get(first.taskId);
      if (firstTask?.status !== 'succeeded') {
        throw new Error(
          `Chat task ended as ${firstTask?.status}: ${JSON.stringify(firstTask?.error)}`,
        );
      }
      const elapsedMs = Date.now() - startedAt;
      expect(firstTask.kind).toBe('video-chat');
      expect(firstTask.meta).toEqual({ videoRecordId: recordId });
      expect(firstTask.result).toMatchObject({
        videoRecordId: recordId,
        answered: true,
      });
      expect(calls.length).toBeGreaterThanOrEqual(1);

      const afterAnswer = await service.history(recordId);
      if (!afterAnswer) throw new Error('Chat exchange was not persisted.');
      expect(afterAnswer.messages).toHaveLength(2);
      const assistant = afterAnswer.messages[1]!;
      expect(assistant.role).toBe('assistant');
      expect(assistant.notInVideo).toBeUndefined();
      expect(assistant.text.trim().length).toBeGreaterThan(0);
      expect(assistant.text).toMatch(/six|6/i);
      expect(assistant.citations?.length ?? 0).toBeGreaterThanOrEqual(1);

      const texts = fixtureTexts();
      let citesSunlight = false;
      for (const citation of assistant.citations ?? []) {
        expect(citation.startMs).toBeGreaterThanOrEqual(0);
        expect(citation.endMs).toBeGreaterThanOrEqual(citation.startMs);
        expect(citation.endMs).toBeLessThanOrEqual(DURATION_MS);
        expect(texts.has(citation.text)).toBe(true);
        if (/six hours of direct sunlight/i.test(citation.text)) {
          citesSunlight = true;
        }
      }
      expect(citesSunlight).toBe(true);

      const listAfterAnswer = await service.list();
      expect(listAfterAnswer).toHaveLength(1);
      expect(listAfterAnswer[0]).toMatchObject({
        videoRecordId: recordId,
        messageCount: 2,
      });

      console.log(
        `[live-chat] answered in ${elapsedMs}ms with ${calls.length} model call(s); answer="${assistant.text}"`,
      );
      for (const citation of assistant.citations ?? []) {
        console.log(
          `[live-chat] citation ${Math.round(citation.startMs / 1000)}s-${Math.round(citation.endMs / 1000)}s: ${citation.text}`,
        );
      }

      /* -------- honest miss: no model call, no invented answer -------- */
      const callsBeforeMiss = calls.length;
      const miss = await service.ask({
        videoRecordId: recordId,
        question: 'What is the capital of France?',
      });
      await waitForTerminal(queue, miss.taskId);
      const missTask = queue.get(miss.taskId);
      if (missTask?.status !== 'succeeded') {
        throw new Error(
          `Miss task ended as ${missTask?.status}: ${JSON.stringify(missTask?.error)}`,
        );
      }
      expect(missTask.result).toMatchObject({
        videoRecordId: recordId,
        answered: false,
        citationCount: 0,
      });
      expect(calls.length).toBe(callsBeforeMiss);

      const afterMiss = await service.history(recordId);
      if (!afterMiss) throw new Error('Chat exchange disappeared.');
      expect(afterMiss.messages).toHaveLength(4);
      const refusal = afterMiss.messages[3]!;
      expect(refusal).toMatchObject({
        role: 'assistant',
        notInVideo: true,
        text: '',
      });
      expect(refusal.citations).toBeUndefined();

      console.log(
        '[live-chat] honest miss recorded without a model call',
      );
      assertStoredShape(afterMiss, recordId);
    },
    1_800_000,
  );
});

function assertStoredShape(record: ChatRecord, recordId: string): void {
  expect(record.videoRecordId).toBe(recordId);
  expect(record.videoTitle.length).toBeGreaterThan(0);
  expect(record.messages.every((message) => message.id.length > 0)).toBe(true);
  expect(record.messages[0]?.role).toBe('user');
  expect(record.messages[record.messages.length - 1]?.role).toBe('assistant');
}
