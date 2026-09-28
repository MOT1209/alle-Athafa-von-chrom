/**
 * Minimal typed pub/sub used for in-process wiring between collectors, the
 * reasoning engine, and the UI store.
 *
 * Deliberately not an EventTarget: we need synchronous delivery, `unsubscribe`
 * that is guaranteed to work, and an error boundary so one bad subscriber
 * cannot break the others.
 */

import type { KingDevError } from '@/core/types';
import { toKingDevError } from '@/core/types';

export type Unsubscribe = () => void;

export interface EventBusOptions {
  readonly onSubscriberError?: (error: KingDevError, eventType: string) => void;
}

export class EventBus<TEvents extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof TEvents, Set<(payload: never) => void>>();

  constructor(private readonly options: EventBusOptions = {}) {}

  on<K extends keyof TEvents>(type: K, handler: (payload: TEvents[K]) => void): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const boxed = handler as (payload: never) => void;
    set.add(boxed);
    return () => {
      set?.delete(boxed);
    };
  }

  once<K extends keyof TEvents>(type: K, handler: (payload: TEvents[K]) => void): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy before iterating: handlers may unsubscribe during dispatch.
    for (const handler of [...set]) {
      try {
        (handler as (p: TEvents[K]) => void)(payload);
      } catch (cause) {
        this.options.onSubscriberError?.(toKingDevError(cause), String(type));
      }
    }
  }

  subscriberCount(type: keyof TEvents): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
