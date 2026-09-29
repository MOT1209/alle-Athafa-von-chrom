/**
 * DevTools HAR bridge (plan Phase 3).
 *
 * `chrome.devtools.network` is only reachable inside the panel's own context.
 * This module wraps it behind two honest surfaces:
 *
 *   - `isHarAvailable()` — the capability check the panel renders verbatim
 *     (plan principle: no capability is ever implied to exist).
 *   - `getRequests()` / `onRequestCompleted` — snapshot + live feed, both
 *     converted through `convertHar`/`convertEntry` so the rest of the code
 *     sees only `NetworkRequest` records.
 *
 * When the API is absent (tests, service worker) every getter reports
 * `unavailable` with a reason instead of an empty success — the difference
 * between "no traffic yet" and "cannot see traffic from here".
 */

import {
  type HarDocument,
  type HarEntry,
  convertEntry,
  convertHar,
} from '@/core/network/har-convert';
import type { NetworkRequest } from '@/core/types';

/** Structural slice of chrome.devtools.network we depend on. */
export interface DevToolsNetworkLike {
  getHAR(callback: (har: unknown) => void): void;
  onRequestFinished: {
    addListener(cb: (entry: unknown) => void): void;
    removeListener(cb: (entry: unknown) => void): void;
  };
}

export interface DevToolsLike {
  devtools?: {
    network?: DevToolsNetworkLike;
  };
}

function devtools(): DevToolsNetworkLike | undefined {
  return (globalThis as { chrome?: DevToolsLike }).chrome?.devtools?.network;
}

export function isHarAvailable(): boolean {
  const network = devtools();
  return (
    typeof network?.getHAR === 'function' &&
    typeof network?.onRequestFinished?.addListener === 'function'
  );
}

export interface HarSnapshotResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly requests: readonly NetworkRequest[];
}

/**
 * Snapshot of the traffic the inspected page has generated so far.
 *
 * The HAR callback is Chrome's callback-based API, so a missing call would
 * hang forever — guarded by a timeout that resolves `unavailable` instead of
 * leaving the panel waiting.
 */
export function getRequests(timeoutMs = 2_000): Promise<HarSnapshotResult> {
  const network = devtools();
  if (!isHarAvailable() || !network) {
    return Promise.resolve({
      available: false,
      reason: 'chrome.devtools.network is unreachable from this context.',
      requests: [],
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HarSnapshotResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        available: false,
        reason: `getHAR did not respond within ${timeoutMs}ms.`,
        requests: [],
      });
    }, timeoutMs);

    try {
      network.getHAR((har) => {
        const { requests } = convertHar(har as HarDocument);
        finish({ available: true, requests });
      });
    } catch (cause) {
      finish({
        available: false,
        reason: cause instanceof Error ? cause.message : 'getHAR threw.',
        requests: [],
      });
    }
  });
}

export type Unsubscribe = () => void;

/**
 * Live feed of completed requests. Returns a no-op unsubscribe with a
 * `false` availability flag when the API is absent, so callers can render
 * "unavailable" without branching on the environment.
 */
export function onRequestCompleted(handler: (request: NetworkRequest) => void): {
  readonly available: boolean;
  readonly unsubscribe: Unsubscribe;
} {
  const network = devtools();
  if (!isHarAvailable() || !network) {
    return { available: false, unsubscribe: () => undefined };
  }

  const listener = (entry: unknown): void => {
    let seed = Date.now() % 1e6;
    const request = convertEntry(entry as HarEntry, () => (++seed).toString(36));
    if (request) handler(request);
  };

  try {
    network.onRequestFinished.addListener(listener);
  } catch {
    return { available: false, unsubscribe: () => undefined };
  }

  return {
    available: true,
    unsubscribe: () => {
      try {
        network.onRequestFinished.removeListener(listener);
      } catch {
        // Extension reloaded mid-session; nothing to clean up.
      }
    },
  };
}
