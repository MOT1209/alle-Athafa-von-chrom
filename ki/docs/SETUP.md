# Installation & Configuration — videoKING AI

Target machine: Windows 11, 8 GB RAM, any GPU (or none). Everything below is free.

## 1. Install Ollama (local LLM runtime)

1. Download from https://ollama.com/download/windows and install.
2. **Allow browser-extension origins** (required — Ollama blocks `chrome-extension://` origins by default and would answer HTTP 403 to generation requests):
   - Windows Settings → System → About → Advanced system settings → Environment Variables.
   - New **User** variable: `OLLAMA_ORIGINS` = `chrome-extension://*`
   - Optional but recommended on 8 GB machines: `OLLAMA_KEEP_ALIVE` = `5m` (unload idle models after 5 minutes).
   - Restart Ollama (quit the tray app and start it again, or restart `ollama serve`).
   - PowerShell alternative for a terminal session:
     ```powershell
     $env:OLLAMA_ORIGINS = 'chrome-extension://*'
     $env:OLLAMA_KEEP_ALIVE = '5m'
     ollama serve
     ```
3. Pull the default model:
   ```powershell
   ollama pull qwen2.5:1.5b
   ```
   ~1 GB download. On the reference machine (Pentium Silver N5030, CPU-only) a cold load takes ~20–35 s and short generations run at ~2–4 tokens/s. This is expected; videoKING's timeouts and sequential queue are designed around it.

### Model guidance for 8 GB RAM

| Model | Disk | Verdict |
|---|---|---|
| `qwen2.5:1.5b` (Q4_K_M) | ~1 GB | **Default.** Fits comfortably; good multilingual (incl. Arabic) quality for summaries/chat. |
| `qwen2.5:3b` | ~1.9 GB | Works, slower; keep context ≤ 4096. |
| `llama3.2:3b` | ~2 GB | Alternative; weaker Arabic. |
| 7B+ models | 4 GB+ | Not recommended; the memory gate blocks them by default. |

Only one model is loaded at a time — videoKING's queue guarantees sequential execution, and `keep_alive` controls when Ollama unloads it. Enable **Settings → Unload model right after each task** to free RAM immediately after every task.

## 2. Build & load the extension

```powershell
cd ki
npm install
npm run icons
npm run build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select `ki\.output\chrome-mv3`.
4. Pin the videoKING AI icon, open it, press **Test connection**. You should see the Ollama version, model count, and latency.

Development mode: `npm run dev` (WXT hot reload; load the `.output/chrome-mv3-dev` folder it prints).

## 3. Verify everything

```powershell
npm run verify      # typecheck + 137 unit tests + build + 42 package checks
npm run test:live   # real generation against your Ollama (needs ollama serve)
npm run smoke       # loads the extension into real Chrome and runs the full workflow
```

## 4. Capturing YouTube transcripts

1. Open a YouTube video that has captions (most videos do; the Video tab lists
   the available caption tracks and languages).
2. Open the videoKING popup → **Video** tab.
3. First time only: read the consent notice and press **I agree — enable
   capture**. It explains exactly what happens: the caption text YouTube
   itself shows is read and stored locally; no video/audio download, no
   publishing, no external servers.
4. Press **Capture transcript**. The extension tries, in order: the official
   transcript API, the player's caption track, and the official transcript
   panel. The result is saved with timestamps.
5. **Library** tab → open the video → read/search the timestamped transcript;
   delete anytime. Revoking consent (Video tab) immediately blocks further
   captures.

Notes:
- Only YouTube is supported in this phase. Other sites: user-provided files
  arrive with Phase 7. Nothing is captured automatically — every capture is
  an explicit user action after consent.
- If YouTube limits a session (rare, mostly automated/headless windows), the
  extension shows an honest error instead of fake data. Try a normal window.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `NETWORK: Cannot reach Ollama` | Ollama isn't running. Start the Ollama app or `ollama serve`. |
| `HTTP 403` on Test/generation | `OLLAMA_ORIGINS` not set. Set it to `chrome-extension://*` and **restart Ollama**. The error hint in the UI repeats this. |
| `MODEL_NOT_FOUND` | Pull the model: `ollama pull <name>`, or press **Pull model** in the popup. |
| `TIMEOUT` on first generation | Cold model load on CPU can take 30 s+. Retry, or raise Settings → Request timeout. |
| `MEMORY_BUDGET` | Model too large for the estimated budget. Use a smaller model/quantization, lower the reserve, or disable enforcement (explicit warning shown). |
| Task stuck after browser restart | MV3 service workers can be killed; interrupted tasks are marked failed honestly. Press the action again (or Retry where offered). |
| Popup shows old data after SW restart | It reconnects automatically within ~1 s; press ⟳ to force refresh. |

## 6. Later phases (not required today)

- **Whisper Base Multilingual (STT)** — Phase 7. Planned: local `whisper.cpp` server (CPU) behind the existing `SttProvider` contract; FFmpeg 8.x is already installed on the reference machine for audio extraction.
- **Piper TTS** — Phase 8 (Arabic Kids Studio). Planned: local Piper HTTP server behind the existing `TtsProvider` contract, Arabic voice (e.g. `ar_JO-kareem-medium`).
- **Optional Supabase free tier** — Phase 9 knowledge sync. Never required; local storage remains the default.

No step above requires any paid subscription.
