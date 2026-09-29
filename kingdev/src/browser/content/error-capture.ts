/**
 * Error-capture content script (plan Phase 1).
 *
 * Runs in the isolated world and installs two hooks on the inspected page:
 *   - `window.addEventListener('error', …, true)`            -> script + resource failures
 *   - `window.addEventListener('unhandledrejection', …)`     -> dropped promises
 *
 * Design constraints:
 *   - Must be injected at `document_start`, so an error thrown while the page
 *     boots is captured, not just errors thrown after KingDev opened.
 *   - Crosses the isolation boundary only through structured-clone-safe
 *     `CapturedError` objects from `@/core/types` — never live `Error`s,
 *     elements, or functions.
 *   - Never touches page globals it does not own: no patched `console`, no
 *     monkey-patched constructors. A debugger that changes page behaviour is
 *     a debugger that reports on itself.
 *
 * Delivery: messages go to the service worker over `chrome.runtime.sendMessage`.
 * Relaying them to the devtools panel is Phase 2 (consent wiring), so this
 * script stays honest about what it can do right now: capture and dispatch.
 */

import { fingerprintSerialized, serializeError } from '@/core/reasoning/fingerprint';
import type { CapturedError, CapturedErrorKind, SerializedError } from '@/core/types';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The wire envelope this script sends to the service worker. */
export interface ErrorCaptureEnvelope {
  readonly type: 'kingdev/content-error';
  readonly error: CapturedError;
}

/** Worker reply to a capture envelope: accepted, or refused with a reason. */
export interface CaptureAck {
  readonly ok: boolean;
  readonly value?: boolean;
  readonly error?: { code?: string; message?: string };
}

export interface ErrorCaptureOptions {
  /** Defaults to the real `window` when omitted. */
  readonly win?: Window;
  /** Defaults to `chrome.runtime.sendMessage` when available, else no-op. */
  readonly send?: (envelope: ErrorCaptureEnvelope) => void;
  /** Distinct errors retained before the oldest is dropped. */
  readonly maxBuffer?: number;
  readonly now?: () => number;
  /**
   * Worker acknowledgement listener. When the worker refuses an envelope
   * (consent revoked mid-session) the capture deactivates itself instead of
   * continuing to buffer and send into a closed gate.
   */
  readonly onAck?: (ack: CaptureAck) => void;
}

export interface ErrorCaptureHandle {
  readonly uninstall: () => void;
  /** Captured-but-not-yet-flushed errors, oldest first. For diagnostics. */
  readonly buffered: readonly CapturedError[];
  /** False once the worker refused capture (consent revoked) or uninstall ran. */
  readonly isActive: () => boolean;
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */ function defaultSend(
  onAck: ((ack: CaptureAck) => void) | undefined,
): (envelope: ErrorCaptureEnvelope) => void {
  const runtime = (
    globalThis as {
      chrome?: { runtime?: { sendMessage?: (message: unknown) => unknown } };
    }
  ).chrome?.runtime;

  if (typeof runtime?.sendMessage !== 'function') {
    // No channel: capture into the buffer only. Swallowing this silently is
    // correct here — a page without the extension runtime still runs tests.
    return () => undefined;
  }

  const sendMessage = runtime.sendMessage.bind(runtime);
  return (envelope) => {
    try {
      // A closed port or a refusing worker must not throw here; the ack (when
      // anyone listens) carries the outcome instead.
      void Promise.resolve(sendMessage(envelope))
        .then((reply) => onAck?.(reply as CaptureAck))
        .catch(() => onAck?.({ ok: false, error: { code: 'PORT_CLOSED' } }));
    } catch {
      // Extension context invalidated mid-session — nothing to do.
    }
  };
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

const INSTALL_FLAG = Symbol.for('kingdev.error-capture.installed');

/** Builds a stable per-context id: monotonic within a document lifetime. */
function idFactory(now: () => number): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `err_${now().toString(36)}_${counter.toString(36)}`;
  };
}

function resourceError(url: string, tagName: string): SerializedError {
  return {
    name: 'ResourceLoadError',
    message: `Failed to load ${tagName.toLowerCase()} resource: ${url}`,
    frames: [],
  };
}

/**
 * Installs the capture hooks. Idempotent: a second call returns the first
 * handle instead of double-reporting every error.
 */
export function installErrorCapture(options: ErrorCaptureOptions = {}): ErrorCaptureHandle {
  const win = options.win ?? (globalThis as unknown as Window);
  const state = win as unknown as Record<symbol, unknown>;
  const existing = state[INSTALL_FLAG] as ErrorCaptureHandle | undefined;
  if (existing) return existing;

  const now = options.now ?? (() => Date.now());
  const nextId = idFactory(now);
  let active = true;

  // Consent is revocable at any moment. When the worker refuses an envelope,
  // deactivate rather than keep buffering: continuing to collect after a
  // refusal would violate the fail-closed contract one layer up.
  // Installed before `send` is built so the default transport wires the ack.
  let acknowledge: ((ack: CaptureAck) => void) | undefined = options.onAck;
  if (!acknowledge) {
    acknowledge = (ack) => {
      if (ack?.ok === false && ack.error?.code === 'CONSENT_REQUIRED') {
        active = false;
      }
    };
  }

  const send = options.send ?? defaultSend(acknowledge);
  const maxBuffer = options.maxBuffer ?? 200;

  const buffer: CapturedError[] = [];
  const byFingerprint = new Map<string, CapturedError>();

  const pageUrl = safePageUrl(win);
  const pageTitle = safePageTitle(win);

  function capture(kind: CapturedErrorKind, serialized: SerializedError, sourceUrl?: string): void {
    if (!active) return;
    const fingerprint = fingerprintSerialized(serialized, kind);

    // Consecutive duplicates collapse into occurrences: 200 throws from one
    // loop must stay one record, exactly like `groupErrors` expects upstream.
    const known = byFingerprint.get(fingerprint);
    if (known) {
      const updated: CapturedError = { ...known, occurrences: known.occurrences + 1 };
      const index = buffer.indexOf(known);
      if (index >= 0) buffer[index] = updated;
      byFingerprint.set(fingerprint, updated);
      send({ type: 'kingdev/content-error', error: updated });
      return;
    }

    const error: CapturedError = {
      id: nextId(),
      kind,
      name: serialized.name,
      message: serialized.message,
      ...(serialized.stack ? { stack: serialized.stack } : {}),
      frames: serialized.frames,
      timestamp: new Date(now()).toISOString(),
      fingerprint,
      occurrences: 1,
      origin: 'content-script',
      relatedConsoleIds: [],
      relatedRequestIds: [],
      pageUrl,
      pageTitle,
      ...(sourceUrl ? {} : {}),
    };
    void sourceUrl;

    buffer.push(error);
    byFingerprint.set(fingerprint, error);
    if (buffer.length > maxBuffer) {
      const dropped = buffer.shift();
      if (dropped) byFingerprint.delete(dropped.fingerprint);
    }

    send({ type: 'kingdev/content-error', error });
  }

  const onError = (event: ErrorEvent): void => {
    if (event.error !== undefined && event.error !== null) {
      capture('javascript', serializeError(event.error), event.filename || undefined);
      return;
    }
    // A script-level syntax error often carries only the message + location.
    const serialized: SerializedError = {
      name: 'Error',
      message: event.message || 'Unknown script error',
      frames: event.filename
        ? [
            {
              functionName: '<anonymous>',
              url: event.filename,
              lineNumber: event.lineno ?? 0,
              columnNumber: event.colno ?? 0,
            },
          ]
        : [],
    };
    capture('javascript', serialized, event.filename || undefined);
  };

  const onResourceError = (event: Event): void => {
    // Resource `error` events do not bubble; the capture-phase listener is how
    // they reach window at all. Only element targets are resource failures —
    // the window's own error event is handled by `onError`.
    const target = event.target;
    if (!target || target === win) return;
    const element = target as { tagName?: string; src?: string; href?: string };
    const tagName = element.tagName;
    if (typeof tagName !== 'string') return;
    const url = element.src ?? element.href ?? '';
    if (url === '') return;
    capture('resource', resourceError(url, tagName), url);
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    capture('unhandledrejection', serializeError(event.reason));
  };

  win.addEventListener('error', onError, true);
  win.addEventListener('error', onResourceError, true);
  win.addEventListener('unhandledrejection', onUnhandledRejection);

  const handle: ErrorCaptureHandle = {
    uninstall: () => {
      active = false;
      win.removeEventListener('error', onError, true);
      win.removeEventListener('error', onResourceError, true);
      win.removeEventListener('unhandledrejection', onUnhandledRejection);
      delete state[INSTALL_FLAG];
    },
    buffered: buffer,
    isActive: () => active,
  };

  state[INSTALL_FLAG] = handle;
  return handle;
}

/* ------------------------------------------------------------------ *
 * Page accessors — defensive because tests pass fake windows
 * ------------------------------------------------------------------ */

function safePageUrl(win: Window): string {
  try {
    return win.location.href;
  } catch {
    return '';
  }
}

function safePageTitle(win: Window): string {
  try {
    return win.document.title;
  } catch {
    return '';
  }
}
