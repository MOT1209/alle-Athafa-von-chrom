# Chrome Web Store — Listing & Review Packet

Everything the store's review form asks for, prepared once instead of
improvised at upload time. Factual claims mirror `docs/privacy-policy.md`,
which mirrors the code.

## Store metadata

| Field | Value |
|---|---|
| Name | KingDev |
| Summary (132-char limit) | AI developer layer for the browser: capture errors and network evidence, mask secrets locally, debug with your own AI provider key. |
| Category | Developer Tools |
| Language | English |
| Regions | All regions |

**Why it fits (132 chars check):** the summary above is 141 characters —
shorten at upload to: *"AI developer layer for the browser — capture errors
and network evidence, mask secrets, debug with your own AI key."* (115).

## Detailed description

KingDev is the AI developer operating layer for your browser. It sits in
DevTools, captures what actually happened on the page, and turns it into
structured, reproducible debugging evidence — without shipping your data
anywhere you did not explicitly approve.

**Evidence, not vibes**

- Captures uncaught errors, promise rejections, and failed resource loads.
- Groups recurring failures by error fingerprint, with a timeline.
- Links each error group to the network requests around it (method, URL,
  status, timing — header names only, never header values).
- Deterministic rules produce ranked root-cause candidates, each with a
  `discriminatingTest`: a concrete check you can run to confirm or refute it.

**AI analysis you control**

- Bring your own provider and key: OpenAI, Anthropic, Google, OpenRouter,
  Ollama (local), or any custom endpoint.
- The prompt is built from the deterministic evidence only — the model never
  replaces it, and contradictions with the evidence are flagged in the UI,
  not silently accepted.
- Every evidence string passes local secret/PII masking before the prompt is
  built. The consent dialog shows you the exact prompt before anything is
  sent. Analysis only runs after your explicit consent, per feature.

**Privacy posture**

- No analytics, no telemetry, no accounts, no tracking.
- One egress path exists: the analysis request to the provider *you*
  configured, behind consent + redaction + key gates, all fail-closed.
- Keys live in `chrome.storage.local`, never synced; the UI can only ever see
  that a key exists, never its value.
- No remote code. Minimal permissions; host access is optional and granted
  per your consent.

**Getting started**

1. Load the extension and open the KingDev panel (DevTools tab, or Ctrl+J).
2. Approve the features you want — error capture needs a browser grant,
   which the consent flow requests using the click as the user gesture.
3. Reproduce a bug on any page, open the Issues tab, and read the evidence.
4. Optional: paste a provider API key in Settings → Providers, approve AI
   analysis, and run model-backed root-cause analysis on any issue.

## Permission justifications (paste into review form)

| Permission | Type | Justification |
|---|---|---|
| `storage` | Required | Stores the consent record, user settings, and the user's own provider API keys locally on the device (`chrome.storage.local` only, never `sync`). The tool is fail-closed: without local storage it cannot verify consent and refuses to operate. |
| `scripting` | Optional | Used solely to inject error-capture listeners into pages the developer is actively debugging. Requested at the moment the user consents to error capture, never at install. |
| Host permissions (`<all_urls>` as optional) | Optional | Requested per-user-consent so the developer can debug any site they choose. Never installed by default; revocable from the extension UI or Chrome settings. |

**Single purpose description (review form):** KingDev is a developer
debugging tool: it captures errors and network evidence from pages the
developer is debugging and analyzes that evidence locally or with the
developer's own configured AI provider.

**Data usage disclosures (review form answers):**

- Does this item collect or use personal data? → No personal data is
  collected by the publisher. The extension stores user-supplied API keys and
  user preferences locally; nothing is transmitted to the developer or any
  KingDev-operated server.
- Does it transfer data for selling/advertising? → No.
- Complies with the "limited use" requirements? → Yes. The only data leaving
  the device is the consented analysis request sent directly by the user's
  browser to the user-configured AI provider, after local redaction.

## Screenshots (capture before upload)

Panel shots to take from a real session:

1. Issues tab — grouped errors with fingerprints, severity, and a
   `discriminatingTest` visible.
2. Analysis tab — deterministic findings plus model analysis side by side,
   with the contradiction warning visible.
3. Consent dialog — the egress warning with the exact prompt preview.
4. Network tab — HAR snapshot with header names only.
5. Settings → Providers — key presence display (masked, not the key).

## Upload checklist

- [ ] `npm run release` — produces `kingdev-vX.Y.Z.zip` with a printed sha256
      (deterministic bytes; re-running changes nothing).
- [ ] Zip contains no `.map` files and no `sourceMappingURL` comments
      (enforced by `scripts/package.mjs` and checked by `npm run e2e`).
- [ ] Zip contains no `eval`, `new Function`, remote `import()`, or
      `document.write` (enforced at package time, checked in e2e).
- [ ] Store listing text matches `docs/store-listing.md` (this file).
- [ ] Privacy policy URL points at the rendered `docs/privacy-policy.md`.
- [ ] Version in `manifest.json` == zip filename == git tag for the release.
- [ ] Bump `CONSENT_VERSION` in `src/security/permissions.ts` only if consent
      semantics changed, and re-run the full gate.
