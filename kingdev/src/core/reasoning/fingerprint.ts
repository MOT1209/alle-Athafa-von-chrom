/**
 * Deterministic error fingerprinting.
 *
 * The fingerprint is the identity of an *error class*, not of an error
 * occurrence. Two `TypeError: Cannot read properties of undefined` throws from
 * the same function must produce the same fingerprint so 30 of them collapse
 * into one issue (spec sections 26 and 27).
 *
 * To get that property the fingerprint must ignore everything that varies
 * between occurrences of the same bug:
 *   - object identity      -> `undefined (reading 'profile')` keeps the
 *                             property name but not the value
 *   - ids, uuids, numbers  -> `user 9182` -> `user <n>`
 *   - hex/urls/paths       -> normalised to a shape
 *   - whitespace, quoting  -> collapsed
 *
 * It must preserve everything that distinguishes *different* bugs:
 *   - the error constructor name
 *   - the normalised message template
 *   - the top application stack frame (file + function), because the same
 *     message thrown from two components is usually two different bugs
 */

import type { CapturedError, CapturedErrorKind, SerializedError, StackFrame } from '@/core/types';

/* ------------------------------------------------------------------ *
 * Message normalisation
 * ------------------------------------------------------------------ */

/** A UUID with or without dashes. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Replaces a hex-looking run of 8+ chars (hashes, ids, build numbers). */
const HEX_RUN = /\b[0-9a-f]{8,}\b/gi;
/** Long base64ish/url-ish tokens. */
const LONG_TOKEN = /\b[A-Za-z0-9_-]{20,}\b/g;
/** Absolute paths and file URLs. */
const PATH_LIKE = /(?:[a-z]+:\/\/|\/)[^\s'"()]{4,}/gi;
/** `:line:col` suffixes. */
const LINE_COL = /:\d+(?::\d+)?/g;
/** Quoted segments, which carry either a property name or an identifier. */
const QUOTED = /'([^']{1,80})'/g;

const WS = /\s+/g;

/**
 * A number not embedded in a larger identifier.
 *
 * The lookbehind keeps `main2` and `v1.2.3` intact — both carry meaning that
 * normalisation should not destroy. The absence of a trailing `\b` is
 * deliberate: `1.5s` must collapse to `<n>`, and a word boundary between `5`
 * and `s` does not exist, so anchoring on the right would split the decimal.
 */
const NUMBER = /(?<![\w$.])-?\d+(?:\.\d+)?/g;

/** A dotted version, e.g. `18.3.1`, `2.0.0-rc.4`. Preserved verbatim. */
const VERSION = /\bv?\d+\.\d+(?:\.\d+)*(?:[-+][0-9a-z.-]+)?\b/gi;

/**
 * Sentinel used to lift a substring out of reach of the destructive rules.
 * Deliberately digit-free and letter-coded so that no numeric or token rule
 * can match inside it.
 */
const SENTINEL = '\u0000';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function sentinelFor(index: number): string {
  return index < 26
    ? `${SENTINEL}${LETTERS[index]}${SENTINEL}`
    : `${SENTINEL}${LETTERS[Math.floor(index / 26) - 1]}${LETTERS[index % 26]}${SENTINEL}`;
}

/** Replaces every match with a sentinel and returns the lifted fragments. */
function lift(text: string, pattern: RegExp, vault: string[]): string {
  return text.replace(new RegExp(pattern.source, pattern.flags), (m) => {
    vault.push(m);
    return sentinelFor(vault.length - 1);
  });
}

/** Puts lifted fragments back verbatim. */
function unlift(text: string, vault: string[]): string {
  if (vault.length === 0) return text;
  return text.replace(new RegExp(`${SENTINEL}([a-z]{1,2})${SENTINEL}`, 'g'), (_m, code: string) => {
    const index =
      code.length === 1
        ? LETTERS.indexOf(code)
        : (LETTERS.indexOf(code[0] ?? '') + 1) * 26 + LETTERS.indexOf(code[1] ?? '');
    return vault[index] ?? '';
  });
}

/**
 * Normalises an error message into a stable template.
 *
 * `reading 'profileName'` is preserved in shape because the property name is a
 * *high-signal* discriminator: `reading 'user'` and `reading 'items'` are
 * almost always genuinely different bugs, whereas
 * `Cannot read properties of undefined` at different line numbers inside the
 * same function is one bug.
 */
export function normalizeMessage(message: string): string {
  if (typeof message !== 'string') return '';

  // Version strings are lifted out first so that neither the number rule nor
  // the long-token rule can fragment `18.3.1` into `<n>.1`.
  const vault: string[] = [];
  let out = lift(message, VERSION, vault);

  out = out.replace(UUID, '<uuid>');
  out = out.replace(QUOTED, (_m, inner: string) => {
    // A quoted segment that looks like an id is an identifier, not a property.
    return /[0-9a-f]{8,}/i.test(inner) ? "'<id>'" : `'${inner}'`;
  });
  out = out.replace(PATH_LIKE, '<path>');
  out = out.replace(LONG_TOKEN, '<token>');
  out = out.replace(LINE_COL, '');
  out = out.replace(HEX_RUN, '<hex>');
  out = out.replace(NUMBER, '<n>');
  out = unlift(out, vault);
  out = out.replace(WS, ' ').trim();

  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

/* ------------------------------------------------------------------ *
 * Frame normalisation
 * ------------------------------------------------------------------ */

/**
 * Strips the minifier marker (`.min`) and any source-map suffix, keeping the
 * real extension. `b.min.js` and `b.js` must normalise to the same string,
 * otherwise one bug produces two fingerprints depending on whether the
 * developer is looking at a production or a development build.
 */
const MINIFIED_NOISE = /\.min(?=\.[a-z0-9]+$)|\.map$/i;

/**
 * Reduces a frame to a stable locator. Origin is irrelevant to identity; the
 * file name and the function name are what matter.
 */
export function normalizeFrame(frame: StackFrame | undefined): string {
  if (!frame) return '<no-frame>';
  const url = frame.url ?? '';
  let location: string;

  if (!url || url.startsWith('eval')) {
    location = 'inline';
  } else {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1] ?? parsed.hostname;
      location = last.replace(MINIFIED_NOISE, '');
    } catch {
      location = url.slice(-40);
    }
  }

  const fn = frame.functionName || '<anonymous>';
  return `${fn}@${location}`;
}

/* ------------------------------------------------------------------ *
 * Stack parsing
 * ------------------------------------------------------------------ */

/**
 * Parses one stack line in the V8 shape `at fn (url:line:col)` (the fn part
 * is optional). Returns undefined when the line does not match.
 */
function parseV8Line(line: string): StackFrame | undefined {
  const withName = /^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/.exec(line);
  if (!withName) return undefined;
  return {
    functionName: (withName[1] ?? '').trim() || '<anonymous>',
    url: withName[2] ?? '',
    lineNumber: Number(withName[3] ?? 0),
    columnNumber: Number(withName[4] ?? 0),
  };
}

/** Parses one stack line in the Firefox/Safari shape `fn@url:line:col`. */
function parseFirefoxLine(line: string): StackFrame | undefined {
  const firefox = /^(.*?)@(.*?):(\d+):(\d+)$/.exec(line);
  if (!firefox) return undefined;
  return {
    functionName: (firefox[1] ?? '').trim() || '<anonymous>',
    url: firefox[2] ?? '',
    lineNumber: Number(firefox[3] ?? 0),
    columnNumber: Number(firefox[4] ?? 0),
  };
}

/** Parses one stack line in the bare shape `url:line:col` (anonymous frame). */
function parseBareLine(line: string): StackFrame | undefined {
  const bare = /^(.*?):(\d+):(\d+)$/.exec(line);
  if (!bare) return undefined;
  return {
    functionName: '<anonymous>',
    url: bare[1] ?? '',
    lineNumber: Number(bare[2] ?? 0),
    columnNumber: Number(bare[3] ?? 0),
  };
}

/** Parses one non-empty stack line with the first matching shape. */
function parseStackLine(line: string): StackFrame | undefined {
  if (line.startsWith('at ')) {
    const v8 = parseV8Line(line);
    if (v8) return v8;
  }
  return parseFirefoxLine(line) ?? parseBareLine(line);
}

/**
 * Parses a V8 `Error.stack` string into frames.
 *
 * Handles both the `at fn (url:line:col)` and the bare `url:line:col` shapes,
 * plus the Firefox/Safari `fn@url:line:col` shape. Skips the leading
 * `Name: message` header line that V8 puts first in the stack string.
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack || typeof stack !== 'string') return [];

  const frames: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const frame = parseStackLine(line);
    if (frame) frames.push(frame);
  }

  return frames;
}

/* ------------------------------------------------------------------ *
 * Application-frame selection
 * ------------------------------------------------------------------ */

const FRAMEWORK_FRAME =
  /^(?:next|react|react-dom|vue|@angular|svelte|solid-js|remix|nuxt|astro|scheduler)\b/i;

/**
 * Picks the frame most likely to be *application* code, i.e. where the fix
 * belongs. Skips V8 internals, node builtins, extension internals, bundler
 * runtime, and framework internals.
 */
export function findApplicationFrame(frames: readonly StackFrame[]): StackFrame | undefined {
  if (frames.length === 0) return undefined;
  for (const frame of frames) {
    const url = frame.url ?? '';
    if (!url) continue;
    if (url.startsWith('node:') || url.startsWith('chrome-extension://')) continue;
    if (/node_modules/.test(url)) continue;
    if (FRAMEWORK_FRAME.test(url)) continue;
    if (/^\/?(webpack|vite)\//.test(url) || /runtime\.[a-f0-9]{6,}\.js/.test(url)) continue;
    return frame;
  }
  // Every frame was framework or runtime code: fall back to the deepest frame.
  // In V8 ordering `frames[0]` is the frame where the throw originated; later
  // entries are its callers, so the first entry is the deepest, not the last.
  return frames[0];
}

/* ------------------------------------------------------------------ *
 * Fingerprint
 * ------------------------------------------------------------------ */

/** FNV-1a 32-bit, rendered as 8 lowercase hex chars. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept inside uint32 without BigInt.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface FingerprintInput {
  readonly name: string;
  readonly message: string;
  readonly kind: CapturedErrorKind;
  readonly frames: readonly StackFrame[];
}

/**
 * Computes the stable identity of an error class.
 *
 * The stack contributes exactly one component — the application frame — because
 * folding in the full stack would change the fingerprint on every unrelated
 * call-path edit, defeating de-duplication entirely.
 */
export function fingerprintError(input: FingerprintInput): string {
  const name = (input.name || 'Error').trim();
  const message = normalizeMessage(input.message);
  const appFrame = findApplicationFrame(input.frames);
  const frameKey = normalizeFrame(appFrame);
  const canonical = `${input.kind}|${name}|${message}|${frameKey}`;
  return `${fnv1a(canonical)}:${name.toLowerCase()}`;
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable thrown value]';
  }
}

/**
 * Normalises a non-`Error` throwable into a `SerializedError`. `throw { code:
 * 401 }` and `throw 'boom'` are both common in application code and are
 * exactly the cases a debugger must not drop on the floor.
 */
function serializeNonError(cause: Exclude<unknown, Error>, maxFrames: number): SerializedError {
  if (typeof cause === 'string') {
    return { name: 'Error', message: cause, frames: [] };
  }

  if (typeof cause === 'object' && cause !== null) {
    const record = cause as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : 'ThrownObject';
    const message =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : safeStringify(record);
    const stack = typeof record.stack === 'string' ? record.stack : undefined;
    return {
      name,
      message,
      ...(stack ? { stack } : {}),
      frames: parseStack(stack).slice(0, maxFrames),
    };
  }

  return { name: 'Error', message: String(cause), frames: [] };
}

/**
 * Converts a live `Error` into a structured-clone-safe `SerializedError`.
 *
 * Non-`Error` throwables are normalised rather than rejected, because
 * `throw { code: 401 }` and `throw 'boom'` are both common in application code
 * and are exactly the cases a debugger must not drop on the floor.
 */
export function serializeError(cause: unknown, maxFrames = 40): SerializedError {
  if (cause instanceof Error) {
    const stack = typeof cause.stack === 'string' ? cause.stack : undefined;
    return {
      name: cause.name || 'Error',
      message: cause.message ?? '',
      ...(stack ? { stack } : {}),
      frames: parseStack(stack).slice(0, maxFrames),
    };
  }
  return serializeNonError(cause, maxFrames);
}

/** Convenience: fingerprint a `SerializedError` directly. */
export function fingerprintSerialized(
  error: SerializedError,
  kind: CapturedErrorKind = 'javascript',
): string {
  return fingerprintError({
    name: error.name,
    message: error.message,
    kind,
    frames: error.frames,
  });
}

/* ------------------------------------------------------------------ *
 * Human-readable location
 * ------------------------------------------------------------------ */

export function fileNameOf(url: string): string {
  if (!url) return 'unknown';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || parsed.hostname;
  } catch {
    const cleaned = url.split('?')[0] ?? url;
    return cleaned.split('/').filter(Boolean).pop() ?? cleaned;
  }
}

/**
 * Renders a `file:line` locator for display, preferring the application frame
 * and falling back to the page host when the stack carried no usable frame.
 */
export function describeLocation(error: Pick<CapturedError, 'frames' | 'pageUrl'>): string {
  const frame = findApplicationFrame(error.frames);
  if (frame) return `${fileNameOf(frame.url)}:${frame.lineNumber}`;
  try {
    return new URL(error.pageUrl).hostname;
  } catch {
    return 'unknown location';
  }
}
