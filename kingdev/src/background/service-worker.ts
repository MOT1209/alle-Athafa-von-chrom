/**
 * KingDev service worker — settings store, log mirror, and message router.
 *
 * Responsibilities (plan Phase 1):
 *   1. Own `chrome.storage` access. The devtools panel owns provider calls;
 *      this worker owns persisted state, so `chrome.*` surface stays small.
 *   2. Mirror a structured, secret-masked log into `chrome.storage.session`
 *      so the diagnostics page can read what happened across worker restarts.
 *   3. Route panel messages (`PanelToWorkerMessage`) to handlers and answer
 *      with `Result`-shaped replies. A handler that throws must still produce
 *      a reply — the panel must never be left waiting on a promise that never
 *      settles.
 *
 * This file runs in a browser that tears it down aggressively, so every entry
 * point is defensive: storage can fail, the runtime can be gone mid-write, and
 * the logger must work before anything has been read from storage.
 */

import { Logger } from '@/core/logger';
import {
  DEFAULT_SETTINGS,
  type KingDevError,
  type LogEntry,
  type ProviderId,
  type Result,
  type Settings,
  err,
  kingDevError,
  ok,
} from '@/core/types';

/* ------------------------------------------------------------------ *
 * Storage adapters — the only places that touch chrome.storage
 * ------------------------------------------------------------------ */

export const SETTINGS_KEY = 'settings';
export const KEYS_KEY = 'providerKeys';
export const SESSIONS_KEY = 'sessions';
export const LOG_KEY = 'log';

export interface ChromeLike {
  storage: {
    local: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    session: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  runtime?: {
    id?: string;
    lastError?: { message?: string } | undefined;
    onInstalled: { addListener(cb: () => void): void };
    onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
}

const CHROME_GLOBAL = globalThis as { chrome?: ChromeLike };

function storageArea(kind: 'local' | 'session'): ChromeLike['storage']['local'] {
  const chrome = CHROME_GLOBAL.chrome;
  const area = chrome?.storage?.[kind];
  if (!area) {
    throw kingDevError('UNSUPPORTED_ENVIRONMENT', `chrome.storage.${kind} is unavailable here.`, {
      retryable: false,
    });
  }
  return area;
}

export function readLocal(keys: string[]): Promise<Record<string, unknown>> {
  return storageArea('local').get(keys);
}

export function writeLocal(items: Record<string, unknown>): Promise<void> {
  return storageArea('local').set(items);
}

export function readSession(keys: string[]): Promise<Record<string, unknown>> {
  return storageArea('session').get(keys);
}

export function writeSession(items: Record<string, unknown>): Promise<void> {
  return storageArea('session').set(items);
}

/* ------------------------------------------------------------------ *
 * Settings store
 * ------------------------------------------------------------------ */

/** Merges stored settings over defaults; never returns a partial object. */
export function mergeSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function loadSettings(): Promise<Result<Settings, KingDevError>> {
  try {
    const bag = await readLocal([SETTINGS_KEY]);
    return ok(mergeSettings(bag[SETTINGS_KEY]));
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not read settings from storage.', {
        retryable: true,
        cause,
      }),
    );
  }
}

export async function saveSettings(
  patch: Partial<Settings>,
): Promise<Result<Settings, KingDevError>> {
  const current = await loadSettings();
  if (!current.ok) return current;
  const next: Settings = { ...current.value, ...patch };
  try {
    await writeLocal({ [SETTINGS_KEY]: next });
    return ok(next);
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not persist settings.', { retryable: true, cause }),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Provider keys — never leave chrome.storage.local
 * ------------------------------------------------------------------ */

/** providerId -> api key. Written only by `provider/keys/set`. */
export type ProviderKeyMap = Readonly<Record<string, string>>;

export async function loadProviderKeys(): Promise<Result<ProviderKeyMap, KingDevError>> {
  try {
    const bag = await readLocal([KEYS_KEY]);
    const raw = bag[KEYS_KEY];
    if (typeof raw !== 'object' || raw === null) return ok({});
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return ok(out);
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not read provider keys.', {
        retryable: true,
        cause,
      }),
    );
  }
}

export async function setProviderKey(
  providerId: ProviderId,
  key: string | null,
): Promise<Result<ProviderKeyMap, KingDevError>> {
  const current = await loadProviderKeys();
  if (!current.ok) return current;
  const next: Record<string, string> = { ...current.value };
  if (key === null) delete next[providerId];
  else next[providerId] = key;
  try {
    await writeLocal({ [KEYS_KEY]: next });
    return ok(next);
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not persist provider keys.', {
        retryable: true,
        cause,
      }),
    );
  }
}

/** Key presence per provider — the only key data the panel may see. */
export function keyPresence(keys: ProviderKeyMap): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, key] of Object.entries(keys)) out[id] = key.length > 0;
  return out;
}

/* ------------------------------------------------------------------ *
 * Session store
 * ------------------------------------------------------------------ */

export async function listSessions(): Promise<Result<readonly string[], KingDevError>> {
  try {
    const bag = await readLocal([SESSIONS_KEY]);
    const raw = bag[SESSIONS_KEY];
    if (!Array.isArray(raw)) return ok([]);
    return ok(raw.filter((id): id is string => typeof id === 'string'));
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not list sessions.', { retryable: true, cause }),
    );
  }
}

export async function getSession(id: string): Promise<Result<unknown | undefined, KingDevError>> {
  try {
    const bag = await readLocal([`session:${id}`]);
    return ok(bag[`session:${id}`]);
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not read the session.', { retryable: true, cause }),
    );
  }
}

export async function saveSession(
  id: string,
  session: unknown,
): Promise<Result<true, KingDevError>> {
  try {
    const ids = await listSessions();
    if (!ids.ok) return ids;
    if (!ids.value.includes(id)) await writeLocal({ [SESSIONS_KEY]: [...ids.value, id] });
    await writeLocal({ [`session:${id}`]: session });
    return ok(true);
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not save the session.', { retryable: true, cause }),
    );
  }
}

export async function deleteSession(id: string): Promise<Result<true, KingDevError>> {
  try {
    const ids = await listSessions();
    if (!ids.ok) return ids;
    // Write `undefined` rather than a tombstone: chrome.storage drops the key
    // entirely when the stored value is `undefined`.
    await writeLocal({ [`session:${id}`]: undefined });
    await writeLocal({
      [SESSIONS_KEY]: ids.value.filter((existing) => existing !== id),
    });
    return ok(true);
  } catch (cause) {
    return err(
      kingDevError('STORAGE_FAILURE', 'Could not delete the session.', {
        retryable: true,
        cause,
      }),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Session log mirror
 * ------------------------------------------------------------------ */

const LOG_LIMIT = 300;

/**
 * Reads the mirrored log. Returns an empty list when storage is unavailable
 * rather than throwing: a diagnostics view that cannot load must not take the
 * worker down with it.
 */
export async function readLogMirror(): Promise<readonly LogEntry[]> {
  try {
    const bag = await readSession([LOG_KEY]);
    const log = bag[LOG_KEY];
    return Array.isArray(log) ? (log as LogEntry[]) : [];
  } catch {
    return [];
  }
}

/** Appends entries to the mirror, dropping the oldest beyond the limit. */
export async function appendLogMirror(entries: readonly LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await readLogMirror();
  const merged = [...existing, ...entries];
  await writeSession({ [LOG_KEY]: merged.slice(Math.max(0, merged.length - LOG_LIMIT)) });
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

export type WorkerHandler = (
  message: Record<string, unknown>,
  logger: Logger,
) => Promise<Result<unknown, KingDevError>>;

export interface RouterHooks {
  readonly onLog?: (entries: readonly LogEntry[]) => void;
}

export interface WorkerRouter {
  dispatch(message: unknown, logger: Logger): Promise<Record<string, unknown>>;
}

export function createRouter(
  handlers: Record<string, WorkerHandler>,
  _hooks: RouterHooks = {},
): WorkerRouter {
  return {
    /** Handles one message and returns the wire response. Never throws. */
    async dispatch(message, logger) {
      const type =
        typeof message === 'object' && message !== null
          ? (message as { type?: unknown }).type
          : undefined;

      if (typeof type !== 'string') {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'message.type missing' } };
      }

      const handler = handlers[type];
      if (!handler) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: `no handler for ${type}` },
        };
      }

      try {
        // The logger is part of the handler contract even when a given handler
        // does not use it, so the parameter is consumed here on purpose.
        void logger;
        const result = await handler(message as Record<string, unknown>, logger);
        if (result.ok) return { ok: true, value: result.value };
        return { ok: false, error: result.error };
      } catch (cause) {
        logger.error('dispatch', cause instanceof Error ? cause.message : String(cause));
        return {
          ok: false,
          error: kingDevError('INTERNAL', 'Unhandled worker failure.', { cause }),
        };
      }
    },
  };
}

/**
 * Wires `chrome.runtime.onMessage` to the router.
 *
 * Returns `true` from the listener so Chrome keeps the `sendResponse` channel
 * open for the async reply; without it the panel would see `undefined` for
 * every async handler.
 */
export function attachMessageListener(router: WorkerRouter): boolean {
  const chrome = CHROME_GLOBAL.chrome;
  const onMessage = chrome?.runtime?.onMessage;
  if (!onMessage) return false;

  onMessage.addListener((message, _sender, sendResponse) => {
    const logger = new Logger({ module: 'worker/router' });
    void router.dispatch(message, logger).then(sendResponse);
    return true;
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

export function defaultHandlers(hooks: RouterHooks = {}): Record<string, WorkerHandler> {
  return {
    'settings/get': async () => {
      const result = await loadSettings();
      return result.ok ? ok(result.value) : result;
    },
    'settings/update': async (message) => {
      const patch = (message as { patch?: Partial<Settings> }).patch ?? {};
      const result = await saveSettings(patch);
      return result.ok ? ok(result.value) : result;
    },
    'provider/keys/set': async (message) => {
      const { providerId, key } = message as { providerId: ProviderId; key: string | null };
      const result = await setProviderKey(providerId, key);
      return result.ok ? ok(keyPresence(result.value)) : result;
    },
    'provider/keys/list': async () => {
      const keys = await loadProviderKeys();
      return keys.ok ? ok(keyPresence(keys.value)) : keys;
    },
    'session/save': async (message) => {
      const session = (message as { session?: { id?: string } }).session;
      if (typeof session?.id !== 'string') {
        return err(kingDevError('INVALID_INPUT', 'session.id is required.'));
      }
      const result = await saveSession(session.id, session);
      return result.ok ? ok(true) : result;
    },
    'session/list': async () => {
      const result = await listSessions();
      return result.ok ? ok(result.value) : result;
    },
    'session/get': async (message) => {
      const id = (message as { id?: string }).id;
      if (typeof id !== 'string') return err(kingDevError('INVALID_INPUT', 'id is required.'));
      const result = await getSession(id);
      return result.ok ? ok(result.value) : result;
    },
    'session/delete': async (message) => {
      const id = (message as { id?: string }).id;
      if (typeof id !== 'string') return err(kingDevError('INVALID_INPUT', 'id is required.'));
      const result = await deleteSession(id);
      return result.ok ? ok(true) : result;
    },
    'log/write': async (message) => {
      const entries = (message as { entries?: readonly LogEntry[] }).entries ?? [];
      hooks.onLog?.(entries);
      await appendLogMirror(entries);
      return ok(true);
    },
    'diagnostics/get': async () => {
      const entries = await readLogMirror();
      return ok({ entries });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

export interface WorkerBootstrap {
  readonly router: WorkerRouter;
  readonly attached: boolean;
}

/**
 * Builds the worker. Exported for tests; `main()` below is the real entry.
 *
 * `chrome.storage.session` requires the `session` access level to be set at
 * runtime in MV3 (it defaults to trusted contexts only, which excludes content
 * scripts, but the worker and panel are trusted contexts so the default works).
 */
export function bootstrapWorker(hooks: RouterHooks = {}): WorkerBootstrap {
  const router = createRouter(defaultHandlers(hooks));
  const attached = attachMessageListener(router);
  return { router, attached };
}

/** Entry point used by the built bundle. */
export function main(): void {
  const logger = new Logger({ module: 'worker', minLevel: 'info' });
  const { attached } = bootstrapWorker({
    onLog: (entries) => logger.debug('log/write', `${entries.length} entries received`),
  });

  const chrome = CHROME_GLOBAL.chrome;
  chrome?.runtime?.onInstalled?.addListener?.(() => {
    void (async () => {
      // First install: persist defaults so the panel reads a complete object
      // even before the user changes anything.
      const settings = await loadSettings();
      if (settings.ok && !('version' in (await readLocal([SETTINGS_KEY])))) {
        await writeLocal({ [SETTINGS_KEY]: settings.value });
      }
    })().catch((cause) => logger.error('install', String(cause)));
  });

  if (!attached) logger.warn('bootstrap', 'chrome.runtime.onMessage unavailable in this context');
}

if (hasWorkerEntrySemantics()) main();

function hasWorkerEntrySemantics(): boolean {
  // A service worker bundle executes top-level; there is no `require.main`.
  // Guard on the real runtime so importing this module from tests does not
  // attach listeners to a fake chrome object.
  return CHROME_GLOBAL.chrome?.runtime?.id !== undefined;
}
