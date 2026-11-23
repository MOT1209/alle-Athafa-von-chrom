# Phase 1 Completion Report — Foundation & Local AI Runtime

Date: 2026-11-23 · Version: 0.1.0 · Status: **ACCEPTANCE CRITERIA MET**

## 1. Scope delivered

Project created from scratch in `ki/` (confirmed empty before start; no other
repo code reused). Phase 1 implements Module 9 (Local AI Runtime Management)
plus the shared foundation every later phase depends on:

- WXT 0.20 + React 19 + TypeScript strict + Tailwind 4, Chrome MV3 build.
- Typed messaging protocol (single RequestMap), router with centralized error
  wrapping, UI RPC client + reconnecting event port.
- Storage abstraction (KeyValueStore) with Chrome local/session adapters and
  sanitized, versioned settings.
- AppError system: 12 typed codes, retryable flags, user hints, serialization.
- Sequential TaskQueue: one running slot, AbortSignal cancellation, exponential
  backoff retries, memory gate, progress events, bounded history, session
  persistence + honest restore after SW restarts.
- Real Ollama provider: version/tags/ps/chat/generate/pull/delete, NDJSON
  streaming with chunk-boundary parsing, mid-stream error surfacing, header
  timeouts, origin-403 guidance.
- Memory-aware admission: fileSize×1.4+256 MB heuristic vs deviceMemory−reserve;
  ok/warn/block/unknown verdicts; enforcement toggle; unload-after-task option.
- Runtime popup (EN/AR + RTL): connection test, model list/pull/delete/test,
  default model selection, live queue with cancel/retry, full settings form.
- Deterministic dependency-free icon generator; 42-check package e2e;
  live Ollama integration tests; real-Chrome CDP smoke test.
- Docs: README, SETUP, ARCHITECTURE, ROADMAP (9 phases), this report.

## 2. Evidence (all commands run on the target machine)

Reference hardware discovered during testing: **Intel Pentium Silver N5030
@ 1.10 GHz, 7.8 GiB RAM, Intel UHD 605 (dropped by Ollama → pure CPU inference)**
— exactly the constrained-hardware case the project targets.

| Gate | Result |
|---|---|
| `npm run typecheck` | clean, 0 errors (strict + noUncheckedIndexedAccess) |
| `npm test` | **137 passed**, 6 live skipped by default (12 files) |
| `npm run test:coverage` | **97.98% stmts / 90.07% branch / 99.13% funcs** (thresholds 85/80/85/85 enforced; UI/background wiring excluded, covered by smoke instead) |
| `npm run build` | MV3 output 289.82 kB total |
| `npm run e2e` | **42/42** package/Web-Store-readiness checks |
| `npm run verify` | full chain green in one run |
| `npm run test:live` | **6/6** against real Ollama 0.40.6: version, health, tags, ps, real chat (`reply="OK"`, cold 33.3 s / warm 8.6 s), real streaming ("One Two Three Four Five", 5 chunks) |
| `npm run smoke` | **15/15** in real headless Chrome: extension loaded via CDP, popup renders live runtime data, Ollama reachable from inside the extension (260 ms), typed RPC round-trips, **full model-test task lifecycle in the real service worker (reply="OK", attempts=1)**, zero page exceptions/console errors |

## 3. Defects found by tests and fixed (not worked around)

1. `keep_alive: "0"` (unload immediately) rejected by settings validation →
   regex fixed; regression test added.
2. `enqueue`/`retry` returned a snapshot taken after the pump had already
   started the task → snapshot now captured before pumping (stable receipt).
3. Stream cancellation could hang when the transport doesn't tie the abort
   signal to the body → reader is now cancelled directly on abort; regression
   test with a never-closing stream added.
4. Ollama HTTP 403 for `chrome-extension://` origins (discovered by the real
   browser smoke test) → dedicated typed hint explaining `OLLAMA_ORIGINS`,
   documented in SETUP/README, unit test added; local server configured and
   the full workflow re-verified green.
5. Test-harness issues fixed: wrong timeout expectation for `/api/version`
   (fixed 8 s header timeout); smoke script initially matched a component
   extension's SW (Hangouts/Gemini) instead of ours → identity now verified by
   manifest name / CDP-loaded id; branded Chrome ≥ 137 ignores
   `--load-extension` → loading via CDP `Extensions.loadUnpacked` with
   forward-slash paths.

## 4. Acceptance criteria checklist

- [x] Real functionality only — every popup action performs a real operation;
      no placeholder buttons (the footer explicitly states which modules are
      future phases).
- [x] Sequential AI execution proven (unit test asserts max concurrency = 1;
      real worker runs tasks one at a time).
- [x] Cancellation + retry proven (unit tests incl. cancel during retry wait;
      typed failures surfaced in UI and smoke).
- [x] Memory-aware processing implemented and tested (gate blocks oversize).
- [x] CPU fallback / no GPU assumption — verified live on a CPU-only machine.
- [x] Zero paid API dependency — only loopback Ollama; permissions minimal.
- [x] Provider abstraction ready for Whisper/Piper (contracts defined).
- [x] Installation/configuration documented (docs/SETUP.md incl. OLLAMA_ORIGINS).
- [x] Roadmap maintained (docs/ROADMAP.md, 9 phases with acceptance criteria).
- [x] Completion evidenced by real workflows, not compilation alone.

## 5. Known limitations (carried forward honestly)

- MV3 worker can still be killed during very long pulls; interrupted tasks are
  reported as failed (retryable) — never silently "resumed". Ollama resumes
  partial downloads server-side on re-pull.
- `navigator.deviceMemory` is coarse; budget is a conservative heuristic.
- UI/background wiring excluded from coverage thresholds; the real-browser
  smoke test is their gate.
- Manual visual check of the popup in a headed Chrome session is recommended
  before store submission (automated smoke covers function, not aesthetics).

## 6. Next phase

Phase 2 — Browser & YouTube Integration (Module 1). Not started, per the
phase-gate rule. Acceptance criteria are defined in docs/ROADMAP.md.
