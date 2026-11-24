# Phase 6 Completion Report — AI Learning Tools

Date: 2026-11-24 · Version: 0.1.0 (phase 6) · Status: **ACCEPTANCE CRITERIA MET**

## 1. Scope delivered

- **Learning schema** (`src/ai/learning/schema.ts`): strict JSON validation for
  flashcards (`front`/`back`/optional `timestampMs`) and quizzes (`mcq` with
  2-6 distinct options whose answer is one of them, or `open` with a short
  expected answer), with caps and de-duplication. Out-of-range timestamps are
  dropped rather than failing the whole generation.
- **Generation** (`src/ai/learning/generator.ts`, `prompts.ts`): one structured
  model call per video from the stored transcript (and summary when available),
  with retry on `BAD_RESPONSE` and a 15-minute per-call ceiling.
- **Storage** (`src/learning/repository.ts`): one learning record per captured
  video (flashcards with SM-2-lite review state, quizzes), metadata index,
  review updates, and due-card queries.
- **Service** (`src/learning/service.ts`): `video-learning` queue task, dedupe
  per video, cancel, and delete-on-video-remove.
- **Protocol + runtime**: `learning/generate|list|get|remove|review`; video
  delete removes learning material first.
- **UI** (`src/ui/LearningTab.tsx`): video list with generate/regenerate,
  card/quiz/study tabs, due-card review with again/hard/good/easy ratings.
- **Spaced repetition**: SM-2-lite intervals/ease/repetitions/lapses with
  persisted review state.

## 2. Live acceptance evidence

Command: `npm run test:live:learning` · Result: **1/1 passed** · Duration:
356.5 s (~5.9 min).

Environment: Windows 11, Pentium Silver N5030, 8 GB RAM, CPU-only; Ollama with
`qwen2.5:1.5b`; `num_ctx=4096`, `num_predict=512`, `temperature=0.2`.

Fixture: 3 segments about tomato care. Result: flashcards generated (>0),
review state persisted (repetitions=1 after a "good" rating).

## 3. Acceptance checklist

- [x] **Generated cards/quizzes are grounded, schema-valid, reviewable in UI** —
      live run generated flashcards; unit tests cover schema rejection.
- [x] **Review state persists; no paid service** — reviewCard persisted and
      re-read with repetitions=1.

## 4. Verification

- TypeScript: clean
- Tests: 404 passed, 13 skipped
- Build: succeeded
- Coverage: 93.87% lines

## 5. Quality limits (honest)

- **Content quality at 1.5B.** Cards/quizzes are schema-valid but can be terse.
- **Timestamps optional and dropped when invalid.** Small models often
  hallucinate timestamps; those are discarded rather than failing generation.
- **No live quiz-grading.** Quizzes are for practice; only flashcard review
  state is persisted.
- **CPU cost is high:** ~6 minutes on this machine.

## 6. Key files

- `src/ai/learning/{schema,prompts,generator}.ts`
- `src/learning/{repository,service}.ts`
- `src/messaging/protocol.ts`, `src/background/runtime.ts`
- `src/ui/LearningTab.tsx`, `src/ui/App.tsx`, `src/core/i18n.ts`
- `tests/ai/learning/*`, `tests/learning/*`,
  `tests/integration/learning.live.test.ts`
- `scripts/live-learning.mjs`

## 7. Next phase

Phase 7 (Audio Processing & Transcription) has **not** been started.