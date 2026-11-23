# Architecture — videoKING AI

## Layering

```
┌────────────────────────────────────────────────────────────┐
│ UI (entrypoints/popup, src/ui)                             │
│ React 19 + Tailwind 4 · EN/AR i18n + RTL · no chrome.*     │
│ except through src/messaging/client                        │
├────────────────────────────────────────────────────────────┤
│ Messaging (src/messaging)                                  │
│ protocol.ts  — single typed RequestMap + event contracts   │
│ client.ts    — UI RPC + event port (reconnect-aware)       │
│ router.ts    — background dispatch, centralized error wrap │
├────────────────────────────────────────────────────────────┤
│ Business logic (src/runtime, src/ai, src/summary)          │
│ RuntimeManager — status/test/pull/delete/testModel         │
│ TaskQueue      — sequential lane, cancel, retry, memory    │
│                  gate, persistence/restore, bounded history│
│ memory.ts      — budget heuristic & fit assessment         │
│ SummaryService — queue orchestration, dedupe, persistence, │
│                  cancel-and-delete semantics               │
├────────────────────────────────────────────────────────────┤
│ AI providers + pipelines (src/ai)                          │
│ LlmProvider / SttProvider / TtsProvider contracts          │
│ OllamaProvider — real HTTP + NDJSON streaming (Phase 1)    │
│ summary/       — chunking, map-reduce, strict schema (Ph. 3)│
│ Whisper/Piper providers implement same contracts (Phase 7/8)│
├────────────────────────────────────────────────────────────┤
│ Storage (src/storage)                                      │
│ KeyValueStore port · ChromeStore (local/session) ·         │
│ MemoryStore (tests) · SettingsStore (sanitized, versioned) │
├────────────────────────────────────────────────────────────┤
│ Browser integration (entrypoints/background, src/background)│
│ Composition root only: wires stores/queue/manager/router,  │
│ port broadcasting, keepalive alarm, session persistence    │
└────────────────────────────────────────────────────────────┘
```

Dependency rule: arrows point down only. UI never imports providers or chrome
APIs directly; business logic never imports chrome (ports are injected);
providers never import UI. Everything below the UI is unit-testable in Node.

## Key contracts

- **RequestMap** (`src/messaging/protocol.ts`): every UI↔worker call is a typed
  request/response pair. Router and client derive types from it, so protocol
  drift is a compile error. Responses are `{ok:true,data}` or
  `{ok:false,error:SerializedError}` — never raw exceptions.
- **AppError** (`src/core/errors.ts`): 12 typed codes (NETWORK, TIMEOUT, HTTP,
  BAD_RESPONSE, CANCELLED, NOT_CONFIGURED, MODEL_NOT_FOUND, MEMORY_BUDGET,
  STORAGE, QUEUE_FULL, INVALID_INPUT, INTERNAL), `retryable` flag, user-facing
  `hint`. Serialized across the message boundary and rehydrated in the UI.
- **LlmProvider / SttProvider / TtsProvider** (`src/ai/types.ts`): replacing
  Ollama with another runtime, or adding Whisper/Piper, means writing one
  provider class — queue, storage, UI and business logic stay unchanged.
- **TaskSpec.run(ctx)**: the queue is runtime-agnostic. LLM chat, model pulls,
  transcription and synthesis all share the same sequential lane with the same
  cancellation/retry/progress semantics.

## Hardware-constraint design (8 GB RAM, unknown GPU)

1. **One AI task at a time.** `TaskQueue` has a single running slot; a second
   task waits. This prevents simultaneous model loads (Ollama would otherwise
   keep several models resident).
2. **Memory admission.** `requiredMb ≈ fileSizeMb × 1.4 + 256`. Available =
   `navigator.deviceMemory` (capped 8 GB by the browser) − configurable reserve
   (default 3 GB for OS/browser). Verdicts: ok / warn / block / unknown.
   Unknown device memory never hard-blocks (honest degradation). Enforcement
   can be disabled explicitly; oversize then warns instead of blocking.
3. **Keep-alive control.** Settings expose Ollama `keep_alive`; the
   unload-after-task option sends `keep_alive: "0"` so RAM is freed immediately.
4. **CPU-first.** No code path assumes a GPU. Ollama itself falls back to CPU;
   timeouts (default 120 s) absorb cold loads (~30 s measured on the reference
   Pentium Silver N5030). Summary calls override the default with a dedicated
   30-minute per-call ceiling, because prompt processing a ~9k-character chunk
   can take 10–15 minutes on CPU; cancellation still aborts immediately.
5. **Small defaults.** num_ctx 4096, num_predict 512, temperature 0.3 —
   chosen for a 1.5B model on CPU.

## MV3 service-worker lifetime

- Queue views persist to `chrome.storage.session` on every transition.
- While tasks are pending, a 30 s `chrome.alarms` keepalive touches session
  storage; it is cleared when the queue drains.
- After an SW restart, `restore()` marks in-flight tasks as failed with a
  retryable INTERNAL error and `orphaned: true` — **no fake resumption** of
  work that died with the worker. Terminal history survives.
- The popup's event port reconnects automatically after disconnect and
  refreshes state; a 4 s queue poll is the safety net.

## Streaming

Ollama answers NDJSON. `streamNdjson` parses incrementally across chunk
boundaries, surfaces mid-stream `{error}` events as typed errors, and cancels
the reader directly on abort so a stalled read unblocks even if the transport
doesn't tie the signal to the body. Header timeouts are separate from stream
lifetime (pulls can run for minutes while emitting progress).

## Summarization pipeline (Phase 3)

Summarization is a bounded map-reduce job over an already-stored transcript.
It never uploads content and never runs a second model call in parallel.

1. **Chunk** (`src/ai/summary/chunking.ts`): character budget is
   `(num_ctx − output_tokens − overhead_tokens) × 3`, clamped to at least 600.
   The default 4096/512 configuration yields ~8.9k characters per map call.
   Segments keep their real timestamps; a single segment longer than the budget
   is split proportionally inside its own span (its last piece keeps the
   original end time). Contexts below 1024 tokens are rejected with a typed
   `INVALID_INPUT` and a settings hint.
2. **Map** (`summarizer.ts`): one sequential call per chunk. Each reply must be
   a JSON object `{summary, keyPoints:[{timestampMs,text}]}` validated by
   `schema.ts`; map calls use `num_predict` as requested. Every summary call
   carries a dedicated 30-minute transport ceiling
   (`SUMMARY_CALL_TIMEOUT_MS`) so CPU prompt processing can finish; the abort
   signal is still honored immediately.
3. **Merge** (only when needed): collected notes are grouped to fit the merge
   prompt; each group is condensed by another validated call, up to
   `maxMergeRounds` (default 3). This keeps the final prompt inside the context
   window instead of truncating evidence.
4. **Reduce**: one final call produces `{overview, keyPoints, chapters}`. All
   fields are length-bounded, timestamps must fall inside the video duration
   plus 30 s of tolerance, and points/chapters are sorted and de-duplicated.
5. **Failure semantics**: empty, non-JSON, wrong-shape or out-of-range replies
   are rejected with a retryable `BAD_RESPONSE`; the stage retries internally
   (default 2 attempts), then the queue owns retries. Invalid output is never
   returned or stored.
6. **Cancellation**: the abort signal is checked before every model call and
   forwarded to the provider. If cancellation lands during the storage write,
   the just-saved summary is removed and the task ends as cancelled.
7. **Persistence** (`src/summary/repository.ts`): one current summary per video
   record id, plus a metadata-only index (capped at 200, newest first) so the
   Summary tab can list entries without reading transcript-sized records.
   Corrupt records fail closed; corrupt index rows are dropped from display.
8. **Service semantics** (`src/summary/service.ts`): generation is enqueued as
   `kind: "video-summary"` with `meta.videoRecordId`. Concurrent requests for
   the same video dedupe to the live task. Settings and the source video are
   re-read at task start and again before saving; deleting a video removes its
   summary first and cancels any in-flight generation.

Prompt design keeps one language rule: the summary is written in the
transcript's language, while the UI chrome follows the selected EN/AR language.

## Security & privacy posture (Phases 1–3)

- Permissions: `storage`, `alarms`. Host permissions: loopback Ollama only.
  Future remote providers must be `optional_host_permissions` + explicit consent.
- No secrets exist in Phase 1 (local server needs no key). The key-vault pattern
  (presence-only reads) arrives with optional remote providers.
- No telemetry, no remote code, no eval/new Function (enforced by e2e checks).
- No content scripts yet — YouTube integration (Phase 2) will use accessible
  captions and user-authorized media only; no DRM bypass, no redistribution.

## Testing strategy

- **Unit (vitest, Node):** all business logic with injected ports — fake fetch
  for the provider, MemoryStore for storage, fake wait/now for the queue,
  stubbed chrome for the client. Coverage thresholds enforced (85/80/85/85)
  over src minus UI/background wiring.
- **Package e2e (scripts/e2e.mjs):** 42 checks on the built output — manifest
  validity, minimal permissions, loopback-only hosts, icons, no source maps,
  no eval/remote code, asset references.
- **Live integration (tests/integration):** real Ollama version/tags/ps/chat/
  stream, gated by `VM_LIVE_OLLAMA=1` (`npm run test:live`).
- **Real-browser smoke (scripts/browser-smoke.mjs):** loads the built extension
  into headless Chrome via CDP `Extensions.loadUnpacked` (branded Chrome ≥ 137
  ignores `--load-extension`), opens the popup, asserts rendered runtime data,
  round-trips typed RPCs, and runs a full model-test task through the real
  worker queue. Zero page exceptions/console errors required.

## Known limitations (documented, not hidden)

- UI components and background wiring are excluded from coverage thresholds;
  they are verified by the real-browser smoke test instead.
- Long model pulls can outlive the MV3 worker despite the keepalive alarm;
  interrupted pulls are reported honestly and can be re-run (Ollama resumes
  partial downloads server-side).
- `navigator.deviceMemory` is coarse (capped, rounded); the budget is a
  conservative heuristic, not a measurement.
