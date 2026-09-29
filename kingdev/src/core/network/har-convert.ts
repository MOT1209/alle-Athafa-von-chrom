/**
 * HAR -> NetworkRequest conversion (plan Phase 3).
 *
 * `chrome.devtools.network.getHAR()` hands us the same W3C HAR document a
 * *.har export contains. KingDev only ever needs the metadata projection the
 * reasoning engine correlates against, and it must be structured-clone safe
 * (`NetworkRequest`), so this module is the single place that flattens the
 * HAR's nested envelope into our flat records.
 *
 * Rules:
 *   - Header *values* are never read. HAR carries them; we keep only the
 *     names, matching the capture contract in types.ts (`SECURITY.md`).
 *   - Malformed entries (no url/method) are dropped, not repaired: an invented
 *     request would poison correlation.
 *   - `outcome` is derived, never guessed: cached responses are `cached`,
 *     3xx is `redirect`, 4xx/5xx map by class, and only a real transport
 *     failure (`error`/`_error` fields or a missing response) becomes
 *     `failed`.
 *   - `startedAt` is the sole causality anchor. HAR gives `_initiator`-style
 *     wall-clock start times only via the private `_start`/`time` pair, so the
 *     public `startedDateTime` is used when present and derived otherwise.
 */

import type { NetworkRequest, RequestOutcome } from '@/core/types';

/** Minimal structural view of a HAR entry we accept (not a full HAR type). */
export interface HarEntry {
  readonly _resourceType?: unknown;
  readonly request?: {
    readonly method?: unknown;
    readonly url?: unknown;
    readonly headers?: readonly { readonly name?: unknown; readonly value?: unknown }[];
    readonly headersSize?: unknown;
  };
  readonly response?: {
    readonly status?: unknown;
    readonly statusText?: unknown;
    readonly content?: { readonly size?: unknown; readonly mimeType?: unknown };
    readonly headers?: readonly { readonly name?: unknown }[];
    readonly _transferSize?: unknown;
    readonly _error?: unknown;
  };
  readonly cache?: unknown;
  readonly startedDateTime?: unknown;
  readonly time?: unknown;
  readonly timings?: { readonly blocked?: unknown; readonly dns?: unknown };
  readonly _initiator?: unknown;
  readonly pageref?: unknown;
}

export interface HarDocument {
  readonly log?: {
    readonly version?: unknown;
    readonly pages?: readonly unknown[];
    readonly entries?: readonly HarEntry[];
  };
}

export interface HarConvertStats {
  total: number;
  converted: number;
  dropped: number;
  fromCache: number;
}

const ID_PREFIX = 'req_';

/** Derives the request outcome from HAR facts; `undefined` fields stay optional. */
export function deriveOutcome(
  statusCode: number | undefined,
  responseError: boolean,
  cacheHit: boolean,
): RequestOutcome {
  if (cacheHit) return 'cached';
  if (statusCode === undefined) return responseError ? 'failed' : 'failed';
  if (statusCode >= 500) return 'server-error';
  if (statusCode >= 400) return 'client-error';
  if (statusCode >= 300 && statusCode < 400) return 'redirect';
  return 'success';
}

/**
 * Best-effort start timestamp. `startedDateTime` is the public HAR field; when
 * it is absent (XHRLiveData-style partial entries) we cannot invent a time, so
 * the epoch sentinel is used and the entry remains correlateable as "unknown
 * start" rather than being dropped.
 */
export function deriveStartedAt(entry: HarEntry): string {
  const raw = entry.startedDateTime;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return '1970-01-01T00:00:00.000Z';
}

function headerNames(
  headers: readonly { readonly name?: unknown }[] | undefined,
): readonly string[] {
  if (!headers) return [];
  const names = new Set<string>();
  for (const header of headers) {
    if (typeof header?.name === 'string' && header.name !== '') {
      names.add(header.name.toLowerCase());
    }
  }
  return [...names];
}

function isCacheHit(entry: HarEntry): boolean {
  // HAR: `cache: {}` means not cached; `cache: { beforeRequest: {...} }` or
  // Chrome's `entry.cache.hit`-ish shapes mean served from cache.
  const cache = entry.cache as Record<string, unknown> | undefined;
  if (cache === undefined || cache === null) return false;
  if (typeof cache === 'object' && 'beforeRequest' in cache && cache.beforeRequest !== null) {
    return true;
  }
  return false;
}

function responseError(entry: HarEntry): boolean {
  const response = entry.response;
  if (!response) return true;
  if (response._error !== undefined && response._error !== null && response._error !== false) {
    return true;
  }
  return false;
}

/** Extracts the response status, or undefined when there is no usable one. */
function statusCodeOf(entry: HarEntry): number | undefined {
  const status = entry.response?.status;
  return typeof status === 'number' && status > 0 ? status : undefined;
}

/** Transfer size, preferring Chrome's `_transferSize` over content size. */
function totalBytesOf(entry: HarEntry): number | undefined {
  const transferSize = entry.response?._transferSize;
  if (typeof transferSize === 'number' && transferSize > 0) return transferSize;
  const contentSize = entry.response?.content?.size;
  if (typeof contentSize === 'number' && contentSize >= 0) return contentSize;
  return undefined;
}

/**
 * Third-party-ness: an initiator origin disagreeing with the request origin.
 * Without a usable initiator (or URL) the honest answer is `false`, not a
 * guess.
 */
function isThirdPartyOf(entry: HarEntry, url: string): boolean {
  const initiator = entry._initiator;
  const initiatorUrl =
    initiator && typeof initiator === 'object' ? (initiator as { url?: unknown }).url : undefined;
  if (typeof initiatorUrl !== 'string') return false;
  try {
    return new URL(initiatorUrl).origin !== new URL(url).origin;
  } catch {
    return false;
  }
}

/** Converts one entry; returns undefined when the entry is unusable. */
export function convertEntry(entry: HarEntry, idSeed: () => string): NetworkRequest | undefined {
  const request = entry.request;
  if (!request) return undefined;

  const url = request.url;
  const method = request.method;
  if (typeof url !== 'string' || url === '' || typeof method !== 'string' || method === '') {
    return undefined;
  }

  const statusCode = statusCodeOf(entry);
  const statusText =
    typeof entry.response?.statusText === 'string' ? entry.response.statusText : undefined;
  const cacheHit = isCacheHit(entry);
  const outcome = deriveOutcome(statusCode, responseError(entry), cacheHit);
  const mimeType =
    typeof entry.response?.content?.mimeType === 'string'
      ? entry.response.content.mimeType
      : undefined;
  const startedAt = deriveStartedAt(entry);
  const time = typeof entry.time === 'number' && entry.time >= 0 ? entry.time : undefined;
  const resourceType = typeof entry._resourceType === 'string' ? entry._resourceType : undefined;
  const totalBytes = totalBytesOf(entry);

  return {
    id: `${ID_PREFIX}${idSeed()}`,
    url,
    method: method.toUpperCase(),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(statusText !== undefined && statusText !== '' ? { statusText } : {}),
    outcome,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(resourceType !== undefined ? { resourceType } : {}),
    startedAt,
    ...(time !== undefined ? { durationMs: Math.round(time) } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    fromCache: cacheHit,
    requestHeaderNames: headerNames(request.headers),
    responseHeaderNames: headerNames(entry.response?.headers),
    isThirdParty: isThirdPartyOf(entry, url),
  };
}

export interface HarConvertResult {
  readonly requests: readonly NetworkRequest[];
  readonly stats: HarConvertStats;
}

/** Converts a full HAR document, preserving entry order. */
export function convertHar(har: HarDocument): HarConvertResult {
  const entries = har.log?.entries;
  if (!Array.isArray(entries)) {
    return { requests: [], stats: { total: 0, converted: 0, dropped: 0, fromCache: 0 } };
  }

  let seed = 0;
  const idSeed = (): string => (++seed).toString(36);

  const requests: NetworkRequest[] = [];
  let fromCache = 0;

  for (const entry of entries) {
    const request = convertEntry(entry, idSeed);
    if (request) {
      requests.push(request);
      if (request.fromCache) fromCache += 1;
    }
  }

  return {
    requests,
    stats: {
      total: entries.length,
      converted: requests.length,
      dropped: entries.length - requests.length,
      fromCache,
    },
  };
}
