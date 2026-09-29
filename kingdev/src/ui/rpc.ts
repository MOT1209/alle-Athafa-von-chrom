/**
 * Typed messaging from UI surfaces (panel, options) to the service worker.
 *
 * Kept free of React and DOM so it stays unit-testable in the node vitest
 * environment, like the rest of `src/`. Every call resolves to a `Result`
 * shape — the UI never sees a thrown transport error, only an `err(...)`.
 */

import { type KingDevError, type Result, type Settings, err, kingDevError } from '@/core/types';

export interface WorkerResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: KingDevError;
}

export interface RpcTransport {
  sendMessage(message: unknown): Promise<unknown>;
}

/** Real transport over `chrome.runtime.sendMessage`. */
export function chromeRpcTransport(): RpcTransport {
  return {
    sendMessage(message) {
      const runtime = (
        globalThis as {
          chrome?: { runtime?: { sendMessage: (m: unknown) => Promise<unknown> } };
        }
      ).chrome?.runtime;
      if (!runtime) {
        return Promise.reject(
          kingDevError('UNSUPPORTED_ENVIRONMENT', 'chrome.runtime unavailable'),
        );
      }
      return runtime.sendMessage(message);
    },
  };
}

export class WorkerRpc {
  constructor(private readonly transport: RpcTransport = chromeRpcTransport()) {}

  private async call<T>(message: Record<string, unknown>): Promise<Result<T, KingDevError>> {
    let raw: unknown;
    try {
      raw = await this.transport.sendMessage(message);
    } catch (cause) {
      // Chrome puts runtime errors on the rejection path (closed port,
      // worker asleep). Normalise them so callers branch on one shape.
      return err(kingDevError('INTERNAL', 'Message to the service worker failed.', { cause }));
    }

    const response = raw as WorkerResponse<T> | undefined;
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      return err(
        kingDevError('PROVIDER_BAD_RESPONSE', 'Malformed response from the service worker.'),
      );
    }
    if (response.ok) return { ok: true, value: response.value as T };
    return err(response.error ?? kingDevError('INTERNAL', 'Unspecified worker error.'));
  }

  getSettings(): Promise<Result<Settings, KingDevError>> {
    return this.call<Settings>({ type: 'settings/get' });
  }

  updateSettings(patch: Partial<Settings>): Promise<Result<Settings, KingDevError>> {
    return this.call<Settings>({ type: 'settings/update', patch });
  }

  setProviderKey(
    providerId: string,
    key: string | null,
  ): Promise<Result<Record<string, boolean>, KingDevError>> {
    return this.call<Record<string, boolean>>({ type: 'provider/keys/set', providerId, key });
  }

  listProviderKeys(): Promise<Result<Record<string, boolean>, KingDevError>> {
    return this.call<Record<string, boolean>>({ type: 'provider/keys/list' });
  }

  getDiagnostics(): Promise<Result<{ entries: readonly unknown[] }, KingDevError>> {
    return this.call<{ entries: readonly unknown[] }>({ type: 'diagnostics/get' });
  }
}
