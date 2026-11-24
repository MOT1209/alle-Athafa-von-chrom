# Roadmap — videoKING AI (target 1.0.0)

Rule: **no phase starts before the previous one passes its acceptance criteria**
(verify gate + real workflow evidence, not just compilation).

## Phase 1 — Foundation & Local AI Runtime (Module 9) ✅ COMPLETE (v0.1.0)

Scope: WXT+React+TS+Tailwind MV3 scaffold · typed messaging · storage/settings ·
AppError system · sequential TaskQueue (cancel/retry/memory gate/restore) ·
real Ollama provider (version/tags/ps/chat/generate/pull/delete, NDJSON
streaming) · runtime popup EN/AR · icons · package e2e · live + browser tests.

Acceptance (all met — see docs/reports/PHASE-1.md):
- [x] `npm run verify` green (typecheck, 137 tests, build, 42 e2e checks)
- [x] Live generation with qwen2.5:1.5b on the 8 GB reference machine
- [x] Extension loads in real Chrome; popup renders live runtime data; full
      task lifecycle runs inside the real service worker (15/15 smoke checks)
- [x] Sequential execution, cancellation, retry proven by tests
- [x] Docs: README / SETUP / ARCHITECTURE / ROADMAP

## Phase 2 — Browser & YouTube Integration (Module 1) ✅ COMPLETE

Scope: YouTube content script (video metadata, accessible caption tracks via
the player's own caption data — no DRM/access bypass) · transcript ingestion
into storage · "capture this video" action from the popup · per-video knowledge
record · consent gate before any capture · site support matrix (YouTube first;
other sites via user-provided files only until authorized APIs exist).

Acceptance (met — see docs/reports/PHASE-2.md):
- [x] On a YouTube video with captions, one click stores a real transcript
      (segments + timestamps + language) locally; visible in the Library tab
      (pipeline proven with fixtures + live extraction; live capture in a
      normal browser session: manual verification steps in the report)
- [x] Videos without captions report honestly and offer the Phase 7 STT path
- [x] No capture happens before explicit consent; revoking stops capture
      (proven in real Chrome via CDP smoke checks)
- [x] Content script passes the same package/security e2e checks (49/49)
- [x] Real-browser smoke extended with the YouTube workflow (20/20 checks;
      automated sessions are degraded by YouTube — honest typed unavailability
      is the verified correct behavior there, manual evidence documented)

## Phase 3 — AI Video Summarization (Module 3) ✅ COMPLETE

Scope: chunked map-reduce summarization over transcripts through the existing
queue · structured output (overview, key points with timestamps, chapters)
validated against a schema · summary storage + UI · cancellation mid-summary ·
memory-aware chunk sizing for 1.5B/4096 ctx.

Acceptance (met — see docs/reports/PHASE-3.md; quality limits documented):
- [x] A 10+ minute transcript produces a structured summary with timestamped
      key points on the reference machine within the sequential queue
- [x] Invalid model output is rejected/retried, never shown as fact
- [x] Summary persists and reopens; cancel works mid-run

## Phase 4 — Chat With Video (Module 4) ✅ COMPLETE

Scope: retrieval over transcript chunks (local BM25/keyword default; optional
Ollama embeddings when a small embed model is present) · chat UI with cited
timestamps · context budgeting for 4096 ctx · chat history per video.

Acceptance (met — see docs/reports/PHASE-4.md; quality limits documented):
- [x] Questions answer from the actual transcript with clickable citations
- [x] "Not in the video" is answered honestly when retrieval finds nothing
- [x] Chat works fully offline (local retrieval + local LLM)

## Phase 5 — Translation & Transcript Management (Module 5)

Scope: transcript viewer/editor · translation via local LLM (AR↔EN↔others)
segment-aligned · exports: TXT/MD/SRT/VTT · search across stored transcripts.

Acceptance:
- [x] AR↔EN translation of a real transcript keeps segment alignment
- [x] SRT/VTT exports import correctly into a standard player/editor
- [x] Editing + search persist locally

## Phase 6 — AI Learning Tools (Module 6)

Scope: flashcards, quizzes (MCQ + open), key-concept extraction from
transcripts/summaries · schema-validated generation · spaced-repetition-lite
review queue · study session UI.

Acceptance:
- [ ] Generated cards/quizzes are grounded in the source text (spot-checkable
      citations), schema-valid, and reviewable in the UI
- [ ] Review state persists; no paid service involved

## Phase 7 — Audio Processing & Transcription (Module 2)

Scope: whisper.cpp local server provider implementing SttProvider (Whisper Base
Multilingual, CPU) · user-provided audio/video files · FFmpeg (installed, 8.1)
for audio extraction with memory-bounded chunking · progress + cancel through
the existing queue · transcript handoff to Phases 3–6.

Acceptance:
- [ ] A user-provided file transcribes locally with timestamps on 8 GB RAM
- [ ] Long files are chunked sequentially (no parallel model loads)
- [ ] Whisper unavailable → honest error with setup instructions

## Phase 8 — Arabic Kids Content Studio (Module 7)

Scope: original Arabic kids scripts/stories generated from learned concepts ·
Piper TTS provider (Arabic voice) implementing TtsProvider · audio preview +
export · safety filters (age-appropriate vocabulary, no scary content) ·
RTL-first studio UI.

Acceptance:
- [ ] An original Arabic story is generated, voiced locally via Piper, and
      exportable as audio — no third-party content reused
- [ ] Safety filter blocks/reports inappropriate generations
- [ ] Full pipeline runs sequentially within the memory budget

## Phase 9 — Knowledge Management, Optional Sync & Store Readiness (Module 8)

Scope: unified knowledge library (videos, transcripts, summaries, cards,
studio items) with tags/search · optional Supabase free-tier sync (explicit
opt-in, never required) · privacy policy + store listing derived from actual
code behavior · deterministic zip packaging · final security review ·
Chrome Web Store submission package.

Acceptance:
- [ ] Library CRUD + search works offline; sync is opt-in and disableable
- [ ] Privacy policy matches real data flows (audit)
- [ ] `npm run release` produces a store-ready zip; all e2e checks green
- [ ] Version 1.0.0

## Cross-phase guarantees (always on)

- Sequential AI execution · cancellation/retry everywhere · typed errors with
  hints · no fake functionality · local-first · minimal permissions · EN/AR UI
  parity for every new surface · tests + real-workflow evidence per phase.
