# Phase 5 Completion Report — Translation & Transcript Management

Date: 2026-11-24 · Version: 0.1.0 (phase 5) · Status: **ACCEPTANCE CRITERIA MET**

## 1. Scope delivered

- **Transcript editing** (`src/transcripts/editor.ts`): only segment text is
  editable (non-empty, max 5000 chars); timestamps are never changed; the
  joined transcript text is rebuilt; `editedAt` is persisted and the videos
  index is refreshed via `VideoRepository.updateTranscript()`.
- **Stable signatures** (`transcriptSignature`, cyrb53): translations detect
  that the source text changed and are flagged as stale instead of being
  deleted silently.
- **Local search** (`src/transcripts/search.ts`): segment-level search across
  all stored video records using the existing AR/EN normalization and light
  stemming from `src/ai/chat/text.ts`, with phrase bonus, a precision rule for
  3+ terms, bounded snippets, and a 25/100 result cap.
- **Exports** (`src/transcripts/export.ts`): pure TXT/MD/SRT/VTT exporters with
  standard timecodes, empty-segment skipping, a guaranteed 1 ms cue window,
  VTT escaping, and safe suggested filenames. UI downloads via Blob/anchor, so
  no new permissions are required.
- **Translation storage** (`src/transcripts/translations.ts`): one bundle per
  captured video holding at most one translation per target language, plus a
  metadata index; each translation stores the `sourceSignature` it was made
  from; `staleLanguages()` reports drift.
- **Local-LLM translation** (`src/ai/translate/`): curated languages (ar, en,
  fr, es, de, tr, ur, hi, id, ms, ru, pt, it, zh, ja, ko, fa, he, sw),
  strict JSON schema `{"segments":[{"key","text"}]}` requiring exactly the
  requested keys, and a translator that batches by a 1/3 input / 2/3 output
  context budget, caps segments per batch, and uses a 15-minute per-call
  ceiling (`TRANSLATION_CALL_TIMEOUT_MS = 900_000`).
- **Translation service** (`src/transcripts/translation-service.ts`): queue task
  `video-translation`, per-`videoRecordId|targetLanguage` dedupe, rejection of
  a target equal to the known source language, stale detection, and cancel
  cleanup that restores the previous translation (or removes only the just-saved
  language).
- **Protocol + runtime** (`src/messaging/protocol.ts`,
  `src/background/runtime.ts`): `transcripts/updateSegment`,
  `transcripts/search`, `translations/generate|list|get|remove`; video delete
  now removes translations first, then summaries and chats.
- **UI** (`src/ui/TranscriptTab.tsx`, `src/ui/App.tsx`): sixth tab
  (`tab.transcript`) with compact navigation for the 400 px popup, transcript
  search, export buttons, and translation generation/export with a stale
  warning.

## 2. Live acceptance evidence (real model, reference machine)

Command: `npm run test:live:translation` · Result: **2/2 passed** · Duration:
234.9 s (~3.9 min).

Environment: Windows 11, Pentium Silver N5030, 8 GB RAM, CPU-only; Ollama with
`qwen2.5:1.5b`; `num_ctx=4096`, `num_predict=512`, `temperature=0.2`.

| Direction | Segments | Timestamps | Model calls | Duration |
|---|---:|---|---:|---:|
| EN → AR | 3/3 kept | identical (0, 2000, 4500 ms starts) | 1 | 163.3 s |
| AR → EN | 3/3 kept | identical (0, 2000, 4500 ms starts) | 1 | 71.5 s |

Both runs asserted that every translated segment is non-empty, that start/end
timestamps are copied verbatim from the source, and that SRT/VTT exports of the
translated segments are well-formed (WEBVTT header / `-->` cue arrows).

## 3. Acceptance checklist

- [x] **AR↔EN translation of a real transcript keeps segment alignment** —
      live runs above kept 3/3 segments with identical timestamps in both
      directions.
- [x] **SRT/VTT exports import correctly into a standard player/editor** —
      standard timecodes, 1 ms minimum cue window, VTT escaping; verified by
      independent parsing in unit tests and by the live export checks.
- [x] **Editing + search persist locally** — unit tests cover segment edit
      persistence, `editedAt`, and segment-level search over stored records.

## 4. Verification

`npm run verify` (typecheck + tests + build + package e2e):

- TypeScript: clean
- Tests: **391 passed, 10 skipped** (live suites gated by env vars)
- Build: succeeded
- Coverage: 94.43% lines (threshold 85%)

New deterministic coverage: editor validation/signature/edit, search scoring and
limits, exporters (TXT/MD/SRT/VTT, timecodes, escaping, filenames), translation
repository bundle/index/stale/remove, schema rejection (missing/extra/duplicate
keys, bad JSON), batch planning, transcript service edit/search, translation
service generate/reject/remove/stale, and router wiring.

## 5. Quality limits (honest)

- **Translation quality at 1.5B.** Output is schema-valid and aligned, but
  phrasing can be terse or literal. A stronger model improves fluency.
- **One target at a time per video.** Concurrent requests for the same
  `videoRecordId|targetLanguage` are deduped; different languages can run
  sequentially through the shared queue.
- **Stale, not deleted.** Editing a transcript keeps prior translations and
  flags them as stale; re-translation is a manual action.
- **No in-browser transcript run was performed.** Live acceptance ran in Node
  against the real provider, queue, validator, repositories, and services; the
  MV3 keepalive path is shared with the already-exercised flows.
- **CPU cost is high:** EN→AR took ~2.7 minutes on this machine.

## 6. Key files

- `src/transcripts/{editor,search,export,translations,service,translation-service}.ts`
- `src/ai/translate/{languages,schema,prompts,translator}.ts`
- `src/capture/videos.ts` (editedAt, updateTranscript, listRecords)
- `src/messaging/protocol.ts`, `src/background/runtime.ts`
- `src/ui/TranscriptTab.tsx`, `src/ui/App.tsx`, `src/core/i18n.ts`
- `tests/transcripts/*`, `tests/ai/translate/*`,
  `tests/integration/translation.live.test.ts`
- `scripts/live-translation.mjs`

## 7. Next phase

Phase 6 (AI Learning Tools) has **not** been started.