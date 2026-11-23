# videoKING AI

**AI-powered Chrome extension that turns video content into searchable knowledge, learning materials, and original educational content — running entirely on local AI. Zero paid API dependency.**

- Version: 0.1.0 (Phase 1 complete — target 1.0.0 after all phases)
- Platform: Chrome Manifest V3 (minimum Chrome 120)
- Stack: WXT · React 19 · TypeScript (strict) · Tailwind CSS 4 · Ollama · Qwen 2.5 1.5B
- Target hardware: Windows 11, 8 GB RAM, **no GPU assumption** (CPU fallback is the default path)

## Current status (Phase 1 — Foundation & Local AI Runtime)

| Module | Status |
|---|---|
| 9. Local AI Runtime Management | ✅ Complete: Ollama provider, sequential task queue, memory budget, model management UI (EN/AR) |
| 1. Browser & YouTube Integration | ⏳ Phase 2 |
| 2. Audio Processing & Transcription | ⏳ Phase 7 (Whisper + FFmpeg contracts already defined) |
| 3. AI Video Summarization | ⏳ Phase 3 |
| 4. Chat With Video | ⏳ Phase 4 |
| 5. Translation & Transcript Management | ⏳ Phase 5 |
| 6. AI Learning Tools | ⏳ Phase 6 |
| 7. Arabic Kids Content Studio | ⏳ Phase 8 (Piper TTS contract already defined) |
| 8. Knowledge Management | ⏳ Phase 9 (+ optional Supabase free tier) |

Nothing is simulated: every button in the popup performs a real operation against the local Ollama server, and every unavailable capability is reported honestly.

## What works today

- **Runtime dashboard** (popup, English/العربية with RTL): connection test with latency, Ollama version, installed models, models currently loaded in memory/VRAM, memory budget.
- **Model management**: pull any model with live progress + cancel, delete (blocked while a task uses it), choose the default model, run a real tiny generation to prove a model works.
- **Sequential task queue**: one AI task at a time (hardware constraint), cancellation via AbortSignal, exponential-backoff retries, typed failures, bounded history, honest recovery after service-worker restarts.
- **Memory-aware admission**: estimates model RAM need (file size × 1.4 + 256 MB) against `navigator.deviceMemory` minus a configurable system reserve; blocks oversize tasks by default, warns when device memory is unknown.
- **Settings**: endpoint, keep-alive, timeout, context window, temperature, output tokens, retry policy, memory reserve, unload-after-task — all persisted, sanitized, and applied live.

## Quick start

```bash
cd ki
npm install
npm run icons        # generate extension icons (deterministic, no deps)
npm run build        # produces .output/chrome-mv3
```

1. Start Ollama with extension origins allowed (required once, see `docs/SETUP.md`):
   - Windows: set system env `OLLAMA_ORIGINS=chrome-extension://*`, restart Ollama.
2. `ollama pull qwen2.5:1.5b`
3. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `ki/.output/chrome-mv3`.
4. Click the videoKING icon → **Test connection**.

## Commands

```bash
npm run typecheck      # tsc --noEmit (strict)
npm test               # unit tests (vitest)
npm run test:coverage  # coverage with enforced thresholds (85/80/85/85)
npm run build          # production MV3 build
npm run e2e            # 42 package-integrity / Web Store readiness checks
npm run verify         # typecheck + tests + build + e2e (the phase gate)
npm run smoke          # loads the built extension into real Chrome via CDP and
                       # exercises the full user workflow (needs Chrome; Ollama
                       # running makes it a live end-to-end proof)
npm run test:live      # live integration tests against a running Ollama
npm run dev            # WXT dev mode with HMR
```

## Documentation

- `docs/SETUP.md` — installation & configuration (Ollama, origins, models; later: Whisper/Piper/FFmpeg)
- `docs/ARCHITECTURE.md` — layers, contracts, decisions, hardware-constraint design
- `docs/ROADMAP.md` — all 9 phases with acceptance criteria
- `docs/reports/PHASE-1.md` — Phase 1 completion report with evidence

## Principles (non-negotiable)

1. **No fake functionality.** Unavailable = explicit typed error, never a simulated result.
2. **Local-first.** All core AI runs on the user's machine; no paid API is ever required.
3. **Sequential AI execution.** Never load several models simultaneously on 8 GB RAM.
4. **Copyright & privacy.** Accessible captions / authorized media / user files only; no DRM bypass; private media processed locally; no automatic redistribution.
5. **Minimal permissions.** `storage` + `alarms` only; host access limited to loopback Ollama.
