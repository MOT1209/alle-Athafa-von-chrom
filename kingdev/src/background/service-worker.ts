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
  type CaptureState,
  type CapturedError,
  DEFAULT_SETTINGS,
  type KingDevError,
  type LogEntry,
  type PermissionsStatus,
  type ProviderId,
  type Result,
  type Settings,
  err,
  kingDevError,
  ok,
} from '@/core/types';
import {
  type ConsentStore,
  type KeyValueStore,
  createConsentStore,
  grantFeature,
  revokeFeature,
} from '@/security/consent-store';
import {
  type ConsentState,
  FEATURE_IDS,
  MANIFEST_PERMISSIONS,
  effectiveGrantedPermissions,
  evaluateFeatureAccess,
  requiredManifestPermissions,
} from '@/security/permissions';

/* ------------------------------------------------------------------ *
 * Storage adapters — the only places that touch chrome.storage
 * ------------------------------------------------------------------ */

export const SETTINGS_KEY = 'settings';
export const KEYS_KEY = 'providerKeys';
export const SESSIONS_KEY = 'sessions';
export const LOG_KEY = 'log';

export interface ChromeLike {
  permissions?: {
    getAll(): Promise<{ permissions: string[]; origins: string[] }>;
  };
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
 * Ports over chrome.storage — injected so tests pass a plain object
 * ------------------------------------------------------------------ */

export interface StorageAreas {
  local: KeyValueStore;
  session: KeyValueStore;
}

/** Adapts a chrome.storage area to the KeyValueStore port. */
export function keyValueFromArea(area: {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}): KeyValueStore {
  return {
    async get(key) {
      const bag = await area.get([key]);
      return bag[key];
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
  };
}

export function defaultStorageAreas(): StorageAreas {
  return {
    local: keyValueFromArea(storageArea('local')),
    session: keyValueFromArea(storageArea('session')),
  };
}

export function defaultConsentStore(areas: StorageAreas = defaultStorageAreas()): ConsentStore {
  return createConsentStore(areas.local);
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
 * Consent gate + capture store (Phase 2)
 * ------------------------------------------------------------------ */

/**
 * The decision record a feature must clear before any data flows. Both the
 * consent record and the browser's actual grants are checked here — the
 * worker is the single gatekeeper, so the panel cannot accidentally collect
 * by asking a different context.
 */
export interface FeatureGateResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly missingPermissions: readonly string[];
}

export function gateFeature(
  featureId: string,
  consent: ConsentState,
  grantedPermissions: readonly string[],
): FeatureGateResult {
  const decision = evaluateFeatureAccess({
    featureId,
    consent,
    grantedPermissions: grantedPermissions as never[],
  });
  return {
    allowed: decision.allowed,
    ...(decision.reason ? { reason: decision.reason } : {}),
    missingPermissions: decision.missingPermissions,
  };
}

/** Bound, session-scoped capture buffer behind the errorCapture gate. */
export class CaptureStore {
  private errors: CapturedError[] = [];
  private totalOccurrences = 0;
  private lastErrorAt: string | undefined;

  constructor(private readonly limit = 500) {}

  /** Adds an error; ignores non-object shapes instead of trusting the sender. */
  add(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as Partial<CapturedError>;
    if (typeof candidate.fingerprint !== 'string' || candidate.fingerprint === '') return false;
    if (typeof candidate.id !== 'string' || typeof candidate.timestamp !== 'string') return false;

    this.totalOccurrences += typeof candidate.occurrences === 'number' ? candidate.occurrences : 1;
    this.lastErrorAt = candidate.timestamp;

    const knownIndex = this.errors.findIndex((e) => e.fingerprint === candidate.fingerprint);
    if (knownIndex >= 0) {
      const known = this.errors[knownIndex];
      if (known) {
        const merged: CapturedError = {
          ...known,
          occurrences:
            known.occurrences +
            (typeof candidate.occurrences === 'number' ? candidate.occurrences : 1),
        };
        this.errors[knownIndex] = merged;
        return true;
      }
    }

    this.errors.push(candidate as CapturedError);
    if (this.errors.length > this.limit) this.errors.shift();
    return true;
  }

  list(): readonly CapturedError[] {
    return [...this.errors];
  }

  clear(): void {
    this.errors = [];
    this.totalOccurrences = 0;
    this.lastErrorAt = undefined;
  }

  state(): CaptureState {
    return {
      totalErrors: this.totalOccurrences,
      distinctErrors: this.errors.length,
      ...(this.lastErrorAt ? { lastErrorAt: this.lastErrorAt } : {}),
    };
  }
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
  /** Injectable dependencies for tests; defaults to real chrome-backed stores. */
  readonly consentStore?: ConsentStore;
  readonly captureStore?: CaptureStore;
  /** Reads the browser's current grants; defaults to chrome.permissions.getAll. */
  readonly getGrants?: () => Promise<{
    permissions: readonly string[];
    origins: readonly string[];
  }>;
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
  const consentStore = hooks.consentStore ?? defaultConsentStore();
  const captureStore = hooks.captureStore ?? new CaptureStore();

  const readGrants =
    hooks.getGrants ??
    (async () => {
      const area = CHROME_GLOBAL.chrome?.permissions;
      if (!area) return { permissions: [], origins: [] };
      return area.getAll();
    });

  /** Grants normalised to internal ids via the shared policy mapping. */
  const normaliseGrants = (grants: {
    permissions: readonly string[];
    origins: readonly string[];
  }) => effectiveGrantedPermissions(grants);

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

    /* --- Phase 2: consent + permissions ------------------------------ */

    'consent/get': async () => {
      const consent = await consentStore.load();
      return ok(consent);
    },

    'consent/grant': async (message) => {
      const featureId = (message as { featureId?: string }).featureId;
      if (typeof featureId !== 'string' || featureId === '') {
        return err(kingDevError('INVALID_INPUT', 'featureId is required.'));
      }
      const current = await consentStore.load();
      const next = grantFeature(current, featureId);
      await consentStore.save(next);
      return ok(next);
    },

    'consent/revoke': async (message) => {
      const featureId = (message as { featureId?: string }).featureId;
      if (typeof featureId !== 'string' || featureId === '') {
        return err(kingDevError('INVALID_INPUT', 'featureId is required.'));
      }
      const current = await consentStore.load();
      const next = revokeFeature(current, featureId);
      await consentStore.save(next);
      return ok(next);
    },

    'permissions/status': async () => {
      const grants = await readGrants();
      const grantedPermissions = normaliseGrants(grants);
      const consent = await consentStore.load();

      // Feature ids whose optional browser grants are fully present right now.
      // aiExplanation needs nothing optional beyond storage, so it reports via
      // the same mapping rather than a live probe.
      const featuresWithGrants = FEATURE_IDS.filter((featureId) => {
        const needed = requiredManifestPermissions([featureId]);
        const optional = needed.permissions.filter((p) => !MANIFEST_PERMISSIONS.includes(p));
        const held = new Set(grants.permissions);
        const originsHeld = grants.origins.length > 0;
        return (
          optional.every((p) => held.has(p)) && (needed.hostPermissions.length === 0 || originsHeld)
        );
      });

      const status: PermissionsStatus = {
        grantedPermissions,
        rawPermissions: [...grants.permissions],
        rawOrigins: [...grants.origins],
        featuresWithGrants,
        apiAvailable: CHROME_GLOBAL.chrome?.permissions !== undefined,
      };
      void consent;
      return ok(status);
    },

    /* --- Phase 2: capture pipeline ----------------------------------- */

    'capture/errors/get': async () => {
      const consent = await consentStore.load();
      const gate = gateFeature('errorCapture', consent, normaliseGrants(await readGrants()));
      if (!gate.allowed) {
        return err(
          kingDevError('CONSENT_REQUIRED', 'Error capture is not consented and granted.', {
            detail: gate.reason,
          }),
        );
      }
      return ok({ errors: captureStore.list(), state: captureStore.state() });
    },

    'capture/errors/clear': async () => {
      captureStore.clear();
      return ok(true);
    },

    'capture/state/get': async () => {
      // State totals are safe to expose without the gate: they are counts the
      // panel already knows once capture ran, and hiding them would make the
      // consent prompt *less* informed, not more.
      return ok(captureStore.state());
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
  const captureStore = hooks.captureStore ?? new CaptureStore();
  const consentStore = hooks.consentStore ?? defaultConsentStore();
  const readGrants =
    hooks.getGrants ??
    (async () => {
      const area = CHROME_GLOBAL.chrome?.permissions;
      if (!area) return { permissions: [], origins: [] };
      return area.getAll();
    });

  const router = createRouter(defaultHandlers(hooks));

  const attached = attachMessageListenerWithContentGate(router, {
    captureStore,
    consentStore,
    readGrants,
  });
  return { router, attached };
}

/**
 * Extended listener: panel messages go through the router; content-script
 * error envelopes go through the errorCapture gate *before* the store sees
 * them. A page that never consented is dropped here, not buffered — the
 * worker is the enforcement point, not the panel.
 */
export function attachMessageListenerWithContentGate(
  router: WorkerRouter,
  deps: {
    captureStore: CaptureStore;
    consentStore: ConsentStore;
    readGrants: () => Promise<{ permissions: readonly string[]; origins: readonly string[] }>;
  },
): boolean {
  const onMessage = CHROME_GLOBAL.chrome?.runtime?.onMessage;
  if (!onMessage) return false;

  onMessage.addListener((message, _sender, sendResponse) => {
    const envelope = message as { type?: unknown } | null;

    if (envelope?.type === 'kingdev/content-error') {
      void (async () => {
        const consent = await deps.consentStore.load();
        const grants = await deps.readGrants();
        const gate = gateFeature('errorCapture', consent, effectiveGrantedPermissions(grants));
        if (!gate.allowed) {
          // Silently dropped: replying with an error to a page the user never
          // opted into would itself be an interaction. The *UI* surfaces the
          // un-consented state; the worker just refuses to retain data.
          sendResponse({
            ok: false,
            error: { code: 'CONSENT_REQUIRED', message: 'capture not consented' },
          });
          return;
        }
        const error = (envelope as { error?: unknown }).error;
        const accepted = deps.captureStore.add(error);
        sendResponse({ ok: accepted, value: accepted });
      })().catch(() =>
        sendResponse({ ok: false, error: { code: 'INTERNAL', message: 'capture failed' } }),
      );
      return true;
    }

    if (envelope?.type === 'kingdev/capture-ping') {
      // A page may probe whether capture is on. Answering yes/no here is safe:
      // the answer carries no data, and the page is the user's own page.
      void (async () => {
        const consent = await deps.consentStore.load();
        const grants = await deps.readGrants();
        const gate = gateFeature('errorCapture', consent, effectiveGrantedPermissions(grants));
        sendResponse({ ok: true, value: { active: gate.allowed } });
      })().catch(() =>
        sendResponse({ ok: false, error: { code: 'INTERNAL', message: 'ping failed' } }),
      );
      return true;
    }

    const logger = new Logger({ module: 'worker/router' });
    void router.dispatch(message, logger).then(sendResponse);
    return true;
  });
  return true;
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
