# Privacy Policy — videoKING AI

videoKING AI is local-first. All processing happens on your device.

## Data collected
- None by default. The extension does not send telemetry, analytics, or usage
  data to any server.

## Data stored locally
- Captured YouTube transcripts (segments + timestamps + language)
- AI-generated summaries, chat conversations, translations, study material,
  and kids stories
- Settings (Ollama base URL, model, context window, etc.)
- Consent state

All of the above is stored in `chrome.storage.local` on your device.

## Network access
- Loopback only: `http://127.0.0.1:11434` (Ollama) and optionally
  `http://127.0.0.1:8178` (whisper.cpp) and `http://127.0.0.1:5000`
  (Piper TTS). No remote servers are contacted.

## Optional sync
- Not implemented in v1.0.0. No data leaves the device.

## Third parties
- None. No third-party SDKs, ads, or trackers.

## Contact
- Report issues via the project's GitHub repository.