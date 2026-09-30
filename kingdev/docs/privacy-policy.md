# KingDev Privacy Policy

**Effective date: 2026-09-30 · Applies to the KingDev browser extension, all versions.**

KingDev ("the extension") is a developer tool that runs entirely inside your
browser. This policy describes exactly what the extension stores, what leaves
your device, and what it never does. Every claim here is enforced by code in
the open-source repository, not by promise.

## The short version

- **No analytics. No telemetry. No accounts. No tracking.** The extension
  makes network requests to exactly one category of destination: the AI
  provider *you* configure, and only when *you* trigger an analysis.
- All data stays in your browser's local extension storage.
- Captured error and network data is masked before it can ever leave the
  device, and only after your explicit consent.

## What the extension stores (and where)

Everything is stored in `chrome.storage.local` — on your device, never synced,
never transmitted by the extension itself:

| What | Key | Contents |
|---|---|---|
| Consent record | `consent` | Which features you approved, a schema version, and a timestamp. |
| Provider API keys | `providerKeys` | The API keys you paste in Settings, per provider. Never in `sync`, never rendered back — the UI shows only *whether* a key exists. |
| Settings | settings key | Redaction toggles and similar preferences. |
| Session log mirror | `chrome.storage.session` | A bounded diagnostics log, cleared when the browser closes. |
| Captured errors | worker memory | Captured errors live in the service worker's memory for the session; they are written to persistent storage only when you save a session explicitly. |

Uninstalling the extension removes all of the above.

## What leaves your device (the only egress path)

There is exactly one way data leaves your device:

**AI analysis.** When you click "Analyze" in the Analysis tab, the extension
sends a prompt built from the captured evidence (error messages, stack traces,
and network request metadata for the issue you are analyzing) to the AI
provider you configured, using the API key you supplied. The request goes
directly from your browser to that provider — KingDev operates no servers and
no intermediary.

Before that send happens, three gates run in order, and the request is
refused if any of them fails:

1. **Consent gate** — AI analysis must be explicitly approved by you, and the
   approval must match the current consent schema version. A stale or missing
   consent denies the request (fail-closed).
2. **Redaction gate** — every piece of evidence is passed through secret and
   PII masking before it enters the prompt. API-key-shaped strings, bearer
   tokens, passwords, emails, and (when PII redaction is on) other personal
   identifiers are replaced with masked placeholders. You can verify the
   masking in the consent dialog, which shows the exact prompt text with an
   explicit egress warning before you confirm.
3. **Key gate** — a provider key must exist. A failed storage read is treated
   as "cannot know", not as "no key", and refuses the request (fail-closed).

Network request metadata captured from DevTools is limited to method, URL,
status, timing, and **header names only — never header values** — so cookies,
authorization headers, and similar secrets never enter the evidence at all.

## What the extension never does

- Never sends page content, browsing history, or captured data anywhere on
  its own — every transfer requires your explicit click and prior consent.
- Never transmits your provider API keys anywhere except to the provider you
  chose, as part of that provider's normal authentication.
- Never loads remote code. All JavaScript ships inside the extension package.
- Never uses `eval`, `new Function`, or remote `import()`.
- Never includes header values, request/response bodies, cookies, or storage
  contents in captured network evidence.
- Never contacts KingDev developers. There is no telemetry endpoint, no
  analytics SDK, no crash reporting.

## Permissions the extension requests

- **`storage`** (required) — to keep your consent record, settings, and API
  keys on your device. Without it the extension cannot remember your choices
  and refuses to operate (fail-closed by design).
- **`scripting`** (optional) — only after you consent to error capture, so
  error listeners can be injected into the pages you are debugging.
- **Host access to sites you choose** (optional) — only after you consent;
  you can revoke it at any time from the extension's Settings tab or from
  Chrome's extension settings.

The extension never requests broad host access at install time.

## Data deletion

- Toggle any feature off in Settings → its consent and its data collection
  stop immediately.
- "Revoke" in the consent dialog also withdraws the browser-level grants.
- Removing a provider key in Settings deletes it from local storage.
- Uninstalling the extension deletes everything stored.

## Changes to this policy

Material changes will be reflected in the extension's open-source repository
and in the version shipped on the Chrome Web Store. The consent schema
version is bumped whenever consent-relevant behavior changes, so existing
approvals fail closed until you re-confirm.

## Contact

Open an issue in the project's repository — that is the only channel; there
is no server to email.
