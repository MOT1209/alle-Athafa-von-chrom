/**
 * LIVE Phase 3 acceptance: summarize a 10+ minute transcript end to end.
 *
 * Skipped by default. Run with: npm run test:live:summary
 * Requires `ollama serve` and a real model (qwen2.5:1.5b preferred).
 *
 * This proves the acceptance path on real hardware: transcript -> chunking ->
 * sequential map calls -> validated structured summary -> queue -> storage.
 * Invalid-output retries and cancellation are proven deterministically in the
 * unit/integration suites; this run is the real-model evidence.
 */
import { describe, expect, it, vi } from 'vitest';
import { nodeFetch } from '../helpers/node-fetch';
import { OllamaProvider } from '../../src/ai/providers/ollama';
import { TaskQueue } from '../../src/ai/queue';
import { chunkTranscript } from '../../src/ai/summary/chunking';
import type {
  ChatMessage,
  ChatResult,
  GenerationOptions,
  LlmProvider,
  Transcript,
  TranscriptSegment,
} from '../../src/ai/types';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { MemoryStore } from '../../src/storage/kv';
import { SettingsStore } from '../../src/storage/settings';
import { SummaryRepository } from '../../src/summary/repository';
import { SummaryService } from '../../src/summary/service';
import { segmentsToTranscript } from '../../src/youtube/transcript';

const live =
  process.env.VM_LIVE_OLLAMA === '1' &&
  process.env.VM_LIVE_SUMMARY === '1';
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
  process.env.VM_LIVE_SUMMARY_MODEL?.trim() ||
  installed.find((model) => model.name === 'qwen2.5:1.5b')?.name ||
  installed[0]?.name;

/* ---------------- 12.5-minute fixture ---------------- */

interface Section {
  durationSec: number;
  sentences: string[];
}

const SECTIONS: Section[] = [
  {
    durationSec: 115,
    sentences: [
      'Most people watch a long video once and remember only a small part of what was said.',
      'A forty minute interview can contain ten useful ideas, but finding them again means scrubbing through the timeline by hand.',
      'Cloud summarizers solve that problem by uploading the transcript, yet the transcript is private viewing data and the service is usually paid.',
      'Many users also work offline, or on a laptop that cannot run a large hosted model.',
      'This project takes a different route: the transcript stays on the machine and a small local model does the reading.',
      'The result is a private knowledge base that can be searched and reopened months later.',
      'In this tour I explain how capture, queuing, and map-reduce summarization fit together.',
      'I also show where the current implementation stops, so the demo never pretends to do more than it does.',
      'The demo covers three phases: runtime status, YouTube capture, and structured summaries.',
      'Each phase is tested, and every model reply is validated before it is shown as fact.',
      'A good summary should answer three questions: what the video covers, which moments matter, and where each idea appears.',
      'That last part is why plain text summaries are not enough for a knowledge tool.',
      'A timestamp turns a claim into a verifiable pointer back to the source.',
      'The interface keeps that link visible, and the stored record keeps the original video identity.',
      'Later phases add more inputs, but the same capture and summarize pipeline should remain.',
    ],
  },
  {
    durationSec: 120,
    sentences: [
      'The first design rule is local-first execution.',
      'The product is a Chrome extension built on Manifest V3, and it requests only the storage and alarms permissions.',
      'The single host permission is loopback Ollama at one two seven dot zero dot zero dot one on port eleven four three four.',
      'There is no telemetry, no analytics endpoint, and no remote code.',
      'Transcripts, settings, and summaries live in chrome dot storage dot local on the user machine.',
      'Capture requires explicit consent for the current site, and the consent decision is stored locally.',
      'The reference machine for this phase has eight gigabytes of memory and runs a one point five billion parameter model.',
      'That hardware target shapes every later decision about chunk size, output length, and queue concurrency.',
      'If the model server is unreachable, the extension reports a typed error instead of falling back to a cloud service.',
      'Local-first is therefore an architectural constraint, not a marketing slogan.',
      'Settings are validated and clamped before they reach the model, so a malformed value cannot silently change the context window.',
      'The default model, context size, temperature, and keep-alive are all visible in the runtime tab.',
      'If the user raises the queue retry count, the change applies to new tasks without restarting the extension.',
      'Unloading the model after a task is optional, because reloading costs time on slower disks.',
      'The design keeps every dependency injectable, which is why the unit tests can run without a browser or a model.',
    ],
  },
  {
    durationSec: 125,
    sentences: [
      'Capture starts when the user opens a YouTube watch page and presses the capture button.',
      'A content script reads the player response that the page already loaded, so no extra network request is needed for metadata.',
      'The transcript may arrive as json three timed text events, as legacy timed text XML, or from the rendered transcript panel.',
      'All three formats are normalized into segments with a start time, an end time, and cleaned text.',
      'Real timestamps are preserved because the summary needs to point back to the exact moment in the video.',
      'The extension records whether captions were manual or automatically generated, and it records the caption language.',
      'No audio or video ever leaves the browser, and no speech-to-text model is involved in this phase.',
      'If the page has no usable captions, capture fails with a clear message rather than inventing a transcript.',
      'The stored record contains the video metadata plus the full transcript, and the library index keeps only a small summary of each record.',
      'This separation keeps the library list fast even when stored transcripts are large.',
      'Duplicate captures replace the previous record instead of creating a second copy.',
      'The record id is derived from the platform video id, so the same video maps to the same local entry.',
      'If a transcript format changes, the parser fails closed and the capture reports that no transcript was found.',
      'The content script only runs on YouTube watch pages and only after consent.',
      'This narrow surface is deliberate: fewer permissions mean fewer ways to break user trust.',
    ],
  },
  {
    durationSec: 125,
    sentences: [
      'The next design rule is one model call at a time.',
      'On an eight gigabyte machine, two concurrent generations would fight for memory and make both slower.',
      'A single sequential task queue owns every model-backed job, including capture follow-ups and summaries.',
      'Tasks move through queued, running, succeeded, failed, and cancelled states, and progress events update the interface.',
      'Each running task receives an abort signal, so cancelling a summary interrupts the active request instead of waiting for it to finish.',
      'Failures are classified: retryable errors are attempted again with backoff, while invalid input fails immediately.',
      'A memory gate can refuse a task before it starts when the estimated footprint would exceed the configured budget.',
      'After a service worker restart, restored tasks are marked as orphaned because their original function cannot be recovered.',
      'The queue also deduplicates summary requests for the same video, so pressing the button twice never starts two jobs.',
      'This queue is the only path to the model, which keeps the whole application predictable under load.',
      'Progress is reported as a percentage plus a human-readable message, for example summarized part one of two.',
      'The queue exposes its state through events, so the popup can render live status without polling.',
      'A task that exceeds its retry budget ends as failed with the last typed error preserved.',
      'The same queue also protects the machine from a burst of user clicks.',
      'Sequential execution is slower than parallel execution in theory, but it is far more reliable on the target hardware.',
    ],
  },
  {
    durationSec: 140,
    sentences: [
      'Summarization is a map-reduce process over the stored transcript.',
      'First the transcript is split into chunks that fit the model context window.',
      'With a four thousand ninety six token context and five hundred twelve requested output tokens, the transcript budget is about eight thousand nine hundred characters.',
      'The calculation reserves space for the system prompt, the instructions, the timestamps, and the model reply.',
      'Every chunk keeps the real start and end times of its segments, and a long single segment is split proportionally inside its own time span.',
      'Each map call returns a compact summary plus a short list of timestamped key points.',
      'If the collected notes no longer fit the final prompt, a merge round condenses them hierarchically before the final call.',
      'The final call produces one overview, the merged key points, and a chapter list with start times.',
      'Because the model is small, every call uses JSON mode and a strict schema.',
      'A reply that is not a valid object, or that contains an empty or oversized field, is rejected and retried inside the same stage.',
      'If the retries are exhausted, the task fails with a retryable bad response error and nothing is saved.',
      'The engine never displays unvalidated model output as if it were a real summary.',
      'This map-reduce shape keeps memory bounded while still covering the entire video.',
      'Chunk boundaries follow segment boundaries whenever possible, which keeps the timestamps honest.',
      'The map stage deliberately asks for a short note rather than polished prose, because compression is the goal.',
      'Merge rounds repeat until the notes fit or the configured round limit is reached.',
      'The final prompt repeats the duration and the timestamp rules so the model cannot drift outside the timeline.',
      'All calls share the same model and generation settings, so behavior does not change between stages.',
    ],
  },
  {
    durationSec: 125,
    sentences: [
      'Validation is the part that turns a language model into a dependable feature.',
      'The overview is length-bounded, key points must be non-empty and timestamped, and chapters need a title and a start time.',
      'Timestamps must fall inside the video duration plus a small tolerance, and the output is sorted and deduplicated.',
      'Unknown shapes and wrong types are rejected instead of being coerced silently.',
      'The storage layer checks records again before writing, so a corrupt value cannot enter the library.',
      'If a summary is cancelled while it is being saved, the saved record is removed and the task ends as cancelled.',
      'When a video is deleted, its summary and every queued or running task for it are removed as well.',
      'The test suite covers chunking, schema rejection, merge behavior, queue cancellation, persistence, and the live model path.',
      'The one point five billion parameter model can still miss nuance, merge two similar ideas, or choose an imperfect chapter boundary.',
      'There is no speaker diarization, no OCR for slides, and no audio transcription in this phase.',
      'The interface is available in English and Arabic, and summary output follows the transcript language.',
      'Those limits are documented because honest scope is more useful than a demo that hides its edges.',
      'Errors are typed and serialized, which lets the interface show a useful message and a retry action.',
      'The live acceptance test uses a synthetic twelve minute transcript and the real local model, not a mock.',
      'The test checks the persisted record, the timestamp ordering, and the chunk count reported by the engine.',
      'A passing run is evidence for one machine and one model, not a universal quality claim.',
      'Future work can add speaker labels, slide text, and audio transcription without changing the stored summary shape.',
      'The next phase is intentionally out of scope for this report.',
    ],
  },
];

interface Fixture {
  transcript: Transcript;
  durationMs: number;
  segmentCount: number;
  charCount: number;
}

function buildFixture(): Fixture {
  const segments: TranscriptSegment[] = [];
  let sectionStartMs = 0;
  for (const section of SECTIONS) {
    const sectionSpanMs = section.durationSec * 1000;
    const totalChars = section.sentences.reduce(
      (sum, sentence) => sum + sentence.length,
      0,
    );
    let consumed = 0;
    for (const sentence of section.sentences) {
      const startMs = Math.round(
        sectionStartMs + (consumed / totalChars) * sectionSpanMs,
      );
      consumed += sentence.length;
      const endMs = Math.round(
        sectionStartMs + (consumed / totalChars) * sectionSpanMs,
      );
      segments.push({
        startMs,
        endMs: Math.max(startMs + 1000, endMs),
        text: sentence,
      });
    }
    sectionStartMs += sectionSpanMs;
  }
  const transcript = segmentsToTranscript(segments, 'en');
  return {
    transcript,
    durationMs: sectionStartMs,
    segmentCount: segments.length,
    charCount: transcript.text.length,
  };
}

const fixture = buildFixture();
const expectedChunks = chunkTranscript(fixture.transcript, {
  numCtx: 4096,
  numPredict: 512,
});

describe.skipIf(!live || !targetModel)('Summary LIVE acceptance', () => {
  it(
    'summarizes a 10+ minute transcript through the queue and persists it',
    async () => {
      const model = targetModel;
      if (!model) throw new Error('No local Ollama model is installed.');

      expect(fixture.durationMs).toBeGreaterThanOrEqual(10 * 60_000);
      expect(fixture.charCount).toBeGreaterThan(9000);
      expect(expectedChunks.length).toBeGreaterThanOrEqual(2);

      const calls: Array<{
        index: number;
        promptChars: number;
        latencyMs: number;
      }> = [];
      let callIndex = 0;
      const instrumented: LlmProvider = {
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
            `[live-summary] model call ${index} started: promptChars=${promptChars} timeoutMs=${options?.timeoutMs ?? 'provider-default'}`,
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
              `[live-summary] model call ${index} FAILED after ${latencyMs}ms code=${code} detail=${detail}`,
            );
            throw error;
          }
          const latencyMs = Date.now() - startedAt;
          calls.push({ index, promptChars, latencyMs });
          console.log(
            `[live-summary] model call ${index}: promptChars=${promptChars} latency=${latencyMs}ms evalCount=${result.evalCount ?? '?'}`,
          );
          return result;
        },
        chatStream: (messages, options, onToken) =>
          provider!.chatStream(messages, options, onToken),
      };

      const kv = new MemoryStore();
      const settings = new SettingsStore(kv);
      await settings.update({
        generation: {
          model,
          numCtx: 4096,
          numPredict: 512,
          temperature: 0.2,
        },
        memory: { unloadAfterTask: true },
      });

      const videoId = 'live-summary-fixture';
      const recordId = videoIdFor(videoId);
      const videos = new VideoRepository(kv);
      await videos.save({
        id: recordId,
        platform: 'youtube',
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: 'Local-first video summaries (12 minute live fixture)',
        channel: 'videoKING AI',
        durationMs: fixture.durationMs,
        language: 'en',
        captionKind: 'manual',
        segmentCount: fixture.segmentCount,
        capturedAt: Date.now(),
        transcript: fixture.transcript,
      });

      const summaries = new SummaryRepository(kv);
      const queue = new TaskQueue({ maxRetries: 2, retryBaseDelayMs: 1000 });
      const service = new SummaryService({
        settings,
        videos,
        summaries,
        queue,
        makeProvider: () => instrumented,
      });

      console.log(
        `[live-summary] fixture: duration=${Math.round(fixture.durationMs / 1000)}s segments=${fixture.segmentCount} chars=${fixture.charCount} chunks=${expectedChunks.length} model=${model}`,
      );

      const startedAt = Date.now();
      const { taskId, deduped } = await service.generate(recordId);
      expect(deduped).toBe(false);

      await vi.waitFor(
        () => {
          const view = queue.get(taskId);
          expect(
            view !== undefined &&
              ['succeeded', 'failed', 'cancelled'].includes(view.status),
          ).toBe(true);
        },
        { timeout: 7_200_000, interval: 500 },
      );

      const task = queue.get(taskId);
      if (task?.status !== 'succeeded') {
        throw new Error(
          `Summary task ended as ${task?.status}: ${JSON.stringify(task?.error)}`,
        );
      }
      const elapsedMs = Date.now() - startedAt;

      const stored = await service.get(recordId);
      expect(stored).toBeDefined();
      if (!stored) throw new Error('Summary was not persisted.');

      expect(stored.model).toBe(model);
      expect(stored.chunkCount).toBe(expectedChunks.length);
      expect(stored.segmentCount).toBe(fixture.segmentCount);
      expect(stored.durationMs).toBe(fixture.durationMs);
      expect(stored.overview.trim().length).toBeGreaterThan(20);
      expect(stored.keyPoints.length).toBeGreaterThanOrEqual(3);
      expect(stored.chapters.length).toBeGreaterThanOrEqual(1);

      const limit = fixture.durationMs + 30_000;
      for (let index = 0; index < stored.keyPoints.length; index += 1) {
        const point = stored.keyPoints[index]!;
        expect(point.text.trim().length).toBeGreaterThan(0);
        expect(point.timestampMs).toBeGreaterThanOrEqual(0);
        expect(point.timestampMs).toBeLessThanOrEqual(limit);
        if (index > 0) {
          expect(point.timestampMs).toBeGreaterThanOrEqual(
            stored.keyPoints[index - 1]!.timestampMs,
          );
        }
      }
      for (let index = 0; index < stored.chapters.length; index += 1) {
        const chapter = stored.chapters[index]!;
        expect(chapter.title.trim().length).toBeGreaterThan(0);
        expect(chapter.startMs).toBeGreaterThanOrEqual(0);
        expect(chapter.startMs).toBeLessThanOrEqual(limit);
        if (index > 0) {
          expect(chapter.startMs).toBeGreaterThan(
            stored.chapters[index - 1]!.startMs,
          );
        }
      }

      const list = await service.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.videoRecordId).toBe(recordId);

      console.log(
        `[live-summary] task succeeded in ${elapsedMs}ms with ${calls.length} model calls; chunkCount=${stored.chunkCount} keyPoints=${stored.keyPoints.length} chapters=${stored.chapters.length}`,
      );
      console.log(`[live-summary] overview: ${stored.overview}`);
      for (const [index, point] of stored.keyPoints.entries()) {
        console.log(
          `[live-summary] point ${index + 1} @${Math.round(point.timestampMs / 1000)}s: ${point.text}`,
        );
      }
      for (const chapter of stored.chapters) {
        console.log(
          `[live-summary] chapter @${Math.round(chapter.startMs / 1000)}s: ${chapter.title}`,
        );
      }
    },
    7_200_000,
  );
});
