# Phase 4 Completion Report — Chat With Video

Date: 2026-11-24 · Version: 0.1.0 (phase 4) · Status: **ACCEPTANCE CRITERIA MET** (quality limits documented in §5)

## 1. Scope delivered

- **Offline retrieval** (`src/ai/chat/`): the stored transcript is grouped into
  overlapping windows that keep real segment timestamps, then ranked with BM25
  over normalized AR/EN stems. No embedding model, no network, no second model
  load on the 8 GB reference machine.
- **Grounded answers**: one structured model call per question with
  `{found, answer, usedSources}` validated by a strict schema. The model only
  chooses passage numbers; timestamps and quoted text are resolved afterwards
  from the real transcript segments (`bestSegment`), so a citation always points
  at a real moment.
- **Honest refusal**: when retrieval finds no meaningful overlap, the model is
  not called at all and the turn is stored as "not in the video". A model
  `found:false` reply is also stored as a refusal; the model's wording is
  discarded and the UI shows a localized message.
- **Chat storage** (`src/chat/repository.ts`): one conversation per captured
  video, capped at 60 messages and trimmed to start on a user turn, with a
  metadata-only index (capped at 200) for the conversation list. Corrupt records
  fail closed with a typed `STORAGE` error.
- **Queue integration** (`src/chat/service.ts`): questions run as
  `kind: "video-chat"` through the existing single-slot queue with progress,
  cancellation, retry/backoff, and one in-flight question per video. A turn is
  persisted only after a validated answer; a cancel that races the save removes
  the just-written messages. Deleting a video clears its conversation.
- **UI** (`src/ui/ChatTab.tsx`): video list, conversation view, ask, live
  progress, cancel, retry after failure, clickable timestamp citations that open
  the video at that second, and clear-conversation. EN/AR with RTL.
- **Long-call transport**: chat calls carry a dedicated 15-minute per-call
  ceiling (`CHAT_CALL_TIMEOUT_MS`), because CPU prompt processing on the
  reference machine can take minutes; cancellation still aborts immediately.

## 2. Live acceptance evidence (real model, reference machine)

Command: `npm run test:live:chat` · Result: **1/1 passed** · Duration:
238.3 s (~4.0 min).

Environment: Windows 11, Pentium Silver N5030, 8 GB RAM, CPU-only; Ollama with
`qwen2.5:1.5b`; `num_ctx=4096`, `num_predict=512`, `temperature=0.2`.

Fixture: **208 s (3.5 min) · 26 segments · 1,812 transcript chars**, a balcony
tomato guide with one explicit fact: "They need six hours of direct sunlight
every day, and eight hours is even better."

| Step | Model calls | Prompt chars | Latency | Result |
|---|---|---:|---:|---|
| "How many hours of direct sunlight do tomato plants need?" | 1 | 2,283 | 236,488 ms | `answered=true`, answer `"six hours"` |
| "What is the capital of France?" | **0** | — | — | `answered=false`, stored as not-in-video |

Citation returned by the app (resolved from the transcript, not written by the
model):

> `56s–64s` — "They need six hours of direct sunlight every day, and eight
> hours is even better."

The test asserted that the answer contains "six"/"6", that every citation is a
real fixture segment with `0 ≤ start ≤ end ≤ duration`, that at least one
citation is the sunlight sentence, that the exchange was persisted and listed
(`messageCount=2`), and that the off-topic question produced no model call and
a stored `notInVideo` assistant message (`messageCount=4`).

## 3. Acceptance checklist

- [x] **Questions answer from the actual transcript with clickable citations** —
      live run above answered from the stored transcript; the citation was
      resolved deterministically from the real segment at 56 s and the UI links
      to `watch?v=…&t=56s`.
- [x] **"Not in the video" is answered honestly when retrieval finds nothing** —
      live miss question produced zero model calls and a stored refusal; unit
      tests also cover the model-refusal path and empty retrieval.
- [x] **Chat works fully offline (local retrieval + local LLM)** — retrieval is
      lexical BM25 with no embedding model; the only network call is loopback
      Ollama, already required by the extension's host permissions.

## 4. Verification

`npm run verify` (typecheck + tests + build + package e2e):

- TypeScript: clean
- Tests: **346 passed, 10 skipped** (live suites gated by env vars; 61 new chat
  tests)
- Build: succeeded
- Package e2e: **49/49 checks passed**

New deterministic coverage: AR/EN normalization and stemming, window building,
BM25 ranking, single-term vs multi-term thresholds, schema rejection (bad JSON,
wrong types, out-of-range sources, empty/oversized answers), prompt budget and
history bounds, deterministic citation resolution, repository trim/index/
corruption/cancel-cleanup, service dedupe/cancel/delete/failure semantics, and
the router wiring.

## 5. Quality limits (honest)

- **Terse answer at 1.5B.** The live answer was correct but only "six hours",
  not a full sentence. The schema enforces shape and grounding, not prose
  quality; a stronger model or a prompt tweak can improve style.
- **Lexical retrieval, not semantic.** Synonyms and paraphrases that share no
  stem can miss (e.g. "cost" vs "price"). Multi-term questions require at least
  two distinct matching terms, which favors precision over recall. A miss is
  reported honestly, but it can be a false "not in the video" when the wording
  differs a lot.
- **Segment-level citations.** A citation is the best-matching transcript
  segment inside the retrieved window, not an exact character range of the
  answer. Long segments are quoted up to 320 characters.
- **No streaming.** The answer appears after the model finishes; progress is
  percent-only and localized by the UI.
- **One question per video at a time.** A second question while one is running
  returns the active task instead of queueing a second call.
- **CPU cost is high:** one question took ~4 minutes on this machine. Chat is
  usable but not conversational-fast at 1.5B.
- **English live run only.** Arabic normalization/retrieval and AR UI strings are
  unit-tested, but an Arabic live model run was not performed in this phase.
- **Live acceptance ran in Node** against the real provider, queue, validator,
  repository, and service. A full in-browser chat run was not performed; the MV3
  keepalive path is shared with the already-exercised summary flow.

## 6. Key files

- `src/ai/chat/{text,retrieval,schema,prompts,answerer}.ts`
- `src/chat/{repository,service}.ts`
- `src/messaging/protocol.ts`, `src/background/runtime.ts`
- `src/ui/ChatTab.tsx`, `src/ui/App.tsx`, `src/core/i18n.ts`
- `tests/ai/chat/*`, `tests/chat/*`,
  `tests/integration/chat.live.test.ts`
- `scripts/live-chat.mjs`

## 7. Next phase

Phase 5 (Translation & Transcript Management) has **not** been started.
