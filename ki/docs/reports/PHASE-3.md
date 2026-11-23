# Phase 3 Completion Report — AI Video Summarization

Date: 2026-11-23 · Version: 0.1.0 (phase 3) · Status: **ACCEPTANCE CRITERIA MET** (quality limits documented in §5)

## 1. Scope delivered

- **Chunked map-reduce summarization** (`src/ai/summary/`): memory-aware
  chunking for 1.5B / 4096 ctx, strictly sequential map calls, hierarchical
  merges, and one final structured call.
- **Structured output**: `overview`, timestamped `keyPoints`, and `chapters`
  (start time, title, summary) validated by a strict schema before anything is
  shown or stored. Invalid JSON/shape/field bounds are retried and then surface
  as a typed, retryable `BAD_RESPONSE`; unvalidated output never becomes fact.
- **Persistence**: summaries stored locally per video record, indexed for the
  Library/Summary tab, removed when the video is removed, and cleaned up if a
  cancel lands during the save.
- **Queue integration**: summary work runs through the existing sequential
  `TaskQueue` with live progress, cancellation, retry/backoff, and in-flight
  deduplication per video.
- **UI**: Summary tab (EN/AR, RTL) with generate, progress, cancel, reopen, and
  delete states; output follows the transcript language.
- **Long-call transport**: summary calls carry a dedicated 30-minute per-call
  timeout (`SUMMARY_CALL_TIMEOUT_MS`), because CPU prompt processing on the
  reference machine legitimately exceeds the generic 120 s request timeout.
  Cancellation still aborts immediately.

## 2. Live acceptance evidence (real model, reference machine)

Command: `npm run test:live:summary` · Result: **1/1 passed** · Duration:
1,908.98 s (31.8 min).

Environment: Windows 11, Pentium Silver N5030, 8 GB RAM, CPU-only; Ollama
0.40.6; `qwen2.5:1.5b`; `num_ctx=4096`, `num_predict=512`, `temperature=0.2`.

Fixture: **750 s (12.5 min) · 96 segments · 9,716 transcript chars → 2 chunks**.

| Call | Stage | Prompt chars | Latency | Generated tokens |
|---|---|---|---:|---:|
| 1 | map — part 1/2 | 10,238 | 873,017 ms | 163 |
| 2 | map — part 2/2 | 1,509 | 319,442 ms | 422 |
| 3 | final (overview + key points + chapters) | 3,061 | 697,770 ms | 803 |

Task: **succeeded in 1,891,168 ms** through the sequential queue; persisted
`chunkCount=2`, **8 key points**, **8 chapters**, and the summary was listed
back by the service. Timestamps were within the video duration, non-decreasing,
and chapters strictly increasing (asserted by the test).

Overview produced:

> The project introduces a local-first approach to summarizing videos,
> ensuring user privacy and long-term accessibility.

Sample key points:

- `@0s` — The project takes a different approach to summarizing videos by
  keeping the transcript on the user's machine and using a small local model.
- `@114s` — Errors are typed and serialized, which lets the interface show a
  useful message and a retry action.
- `@123s` — The interface is available in English and Arabic, and summary
  output follows the transcript language.

Sample chapters: `@0s Introduction`, `@114s Live Acceptance Test`,
`@115s Persisted Record and Timestamp Ordering`, `@123s Interface Language and
Error Handling`.

**Transport note (test harness only):** Node's global fetch abandons requests
whose response headers take roughly ten minutes; Ollama sends nothing until
prompt evaluation finishes, so a valid summary call on this CPU can exceed that
ceiling. Chrome's fetch has no such ceiling and the extension still uses the
global fetch. The live test injects a test-only `node:http` adapter
(`tests/helpers/node-fetch.ts`) so the Node harness can exercise the real
provider, queue, validator, and storage without an artificial transport limit.

## 3. Acceptance checklist

- [x] **A 10+ minute transcript produces a structured summary with timestamped
      key points on the reference machine within the sequential queue** — live
      run above: 750 s fixture, 2 chunks, 3 sequential calls, validated
      overview/key points/chapters, persisted.
- [x] **Invalid model output is rejected/retried, never shown as fact** —
      schema tests cover wrong types, empty/oversized fields, out-of-range
      timestamps, extra keys, invalid JSON, and dedupe/sort; summarizer tests
      prove retries and final `BAD_RESPONSE`; service tests prove nothing is
      saved on failure. Live calls used JSON mode plus the same validation path.
- [x] **Summary persists and reopens; cancel works mid-run** — repository and
      service tests prove save/reopen/list/delete, cancellation during a call,
      cancellation during save (saved record removed), and video-delete cascade;
      the live test re-read the stored record and the list after completion.

## 4. Verification

`npm run verify` (typecheck + tests + build + package e2e):

- TypeScript: clean
- Tests: **285 passed, 9 skipped** (live suites gated by env vars)
- Build: succeeded
- Package e2e: **49/49 checks passed**

## 5. Quality limits (honest)

- **Timestamp precision is model-limited.** In this live run, 7 of 8 key points
  were schema-valid and ordered but clustered at 114–123 s even though their
  text came from the final section of the 750 s video. Chunking preserves the
  real segment times (verified in code/tests); the 1.5B model failed to copy
  the note timestamps faithfully in the final call. Treat timestamps as
  model-generated until a stronger model or a deterministic grounding step is
  added.
- **Overview/chapter quality is modest** at 1.5B: generic overview, duplicated
  chapter themes (two "Future Work" entries). The schema guarantees shape and
  bounds, not editorial quality.
- **Synthetic English fixture.** Arabic output follows the transcript language,
  but an Arabic live run was not performed in this phase.
- **No diarization, OCR, or audio transcription** in Phase 3. Videos without
  captions still need the Phase 7 STT path.
- **CPU cost is high:** ~4 prompt tokens/s and ~1–2 generated tokens/s; this
  12.5-minute video needed ~31.5 minutes. With other applications running, free
  RAM was ~0.5–1.6 GB; the model stayed loaded at ~940 MB and the run completed
  without an out-of-memory failure.
- **Live acceptance ran in Node** against the real provider, queue, validator,
  repository, and service. A full in-browser 30-minute run was not performed;
  the queue's 30 s alarm keepalive is designed to hold the MV3 worker open while
  tasks are pending, but a real browser-session run on a video this long is
  still the remaining check before claiming production readiness for long
  videos.
- Cancellation and invalid-output retries are proven deterministically, not by
  interrupting this 31-minute live run.

## 6. Key files

- `src/ai/summary/{time,schema,chunking,prompts,summarizer}.ts`
- `src/summary/{repository,service}.ts`
- `src/ai/queue.ts` (task metadata + retry/cancel)
- `src/ai/providers/ollama.ts`, `src/ai/types.ts` (per-call timeout)
- `src/ui/SummaryTab.tsx`, `src/background/runtime.ts`
- `tests/ai/summary/*`, `tests/summary/*`,
  `tests/integration/summary.live.test.ts`, `tests/helpers/node-fetch.ts`
- `scripts/live-summary.mjs`

## 7. Next phase

Phase 4 (Chat With Video) has **not** been started.
