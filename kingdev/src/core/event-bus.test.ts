import { EventBus } from '@/core/event-bus';
import { describe, expect, it, vi } from 'vitest';

// A type alias rather than an interface: interfaces have no implicit index
// signature, so they cannot satisfy EventBus's `Record<string, unknown>` bound.
type TestEvents = {
  readonly error: { id: string };
  readonly request: { url: string };
};

describe('EventBus', () => {
  it('delivers a payload to every subscriber of that type', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('error', a);
    bus.on('error', b);

    bus.emit('error', { id: 'e1' });

    expect(a).toHaveBeenCalledWith({ id: 'e1' });
    expect(b).toHaveBeenCalledWith({ id: 'e1' });
  });

  it('does not deliver across event types', () => {
    const bus = new EventBus<TestEvents>();
    const onRequest = vi.fn();
    bus.on('request', onRequest);

    bus.emit('error', { id: 'e1' });

    expect(onRequest).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing listens', () => {
    const bus = new EventBus<TestEvents>();

    expect(() => bus.emit('error', { id: 'e1' })).not.toThrow();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    const off = bus.on('error', handler);

    bus.emit('error', { id: 'e1' });
    off();
    bus.emit('error', { id: 'e2' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps other subscribers alive when one unsubscribes', () => {
    const bus = new EventBus<TestEvents>();
    const second = vi.fn();
    const off = bus.on('error', () => off());
    bus.on('error', second);

    expect(() => bus.emit('error', { id: 'e1' })).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('delivers to a subscriber added during dispatch only on the next emit', () => {
    const bus = new EventBus<TestEvents>();
    const late = vi.fn();
    bus.on('error', () => bus.on('error', late));

    bus.emit('error', { id: 'e1' });
    expect(late).not.toHaveBeenCalled();

    bus.emit('error', { id: 'e2' });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('delivers to a subscriber removed during dispatch in the same cycle', () => {
    // Dispatch copies the handler set up front, so an unsubscribe takes effect
    // from the next emit rather than mid-cycle. Documenting the real behaviour
    // so a future "optimisation" does not silently change it.
    const bus = new EventBus<TestEvents>();
    const second = vi.fn();
    const off = bus.on('error', () => off());
    bus.on('error', second);

    bus.emit('error', { id: 'e1' });

    expect(second).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount('error')).toBe(1);
  });

  it('runs a once handler exactly once', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.once('error', handler);

    bus.emit('error', { id: 'e1' });
    bus.emit('error', { id: 'e2' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: 'e1' });
    expect(bus.subscriberCount('error')).toBe(0);
  });

  it('unsubscribes a once handler even when the handler throws', () => {
    const bus = new EventBus<TestEvents>();
    bus.once('error', () => {
      throw new Error('handler failed');
    });

    bus.emit('error', { id: 'e1' });
    bus.emit('error', { id: 'e2' });

    expect(bus.subscriberCount('error')).toBe(0);
  });

  it('cancels a once handler before it is ever called', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    const off = bus.once('error', handler);

    off();
    bus.emit('error', { id: 'e1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('contains a throwing subscriber so the others still run', () => {
    const onSubscriberError = vi.fn();
    const bus = new EventBus<TestEvents>({ onSubscriberError });
    const survivor = vi.fn();
    bus.on('error', () => {
      throw new Error('bad subscriber');
    });
    bus.on('error', survivor);

    expect(() => bus.emit('error', { id: 'e1' })).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
  });

  it('reports the failing event type to the error hook', () => {
    const onSubscriberError = vi.fn();
    const bus = new EventBus<TestEvents>({ onSubscriberError });
    bus.on('request', () => {
      throw new Error('bad subscriber');
    });

    bus.emit('request', { url: 'https://app.dev' });

    expect(onSubscriberError).toHaveBeenCalledWith(expect.any(Object), 'request');
  });

  it('normalises a non-error throw into a KingDevError', () => {
    const onSubscriberError = vi.fn();
    const bus = new EventBus<TestEvents>({ onSubscriberError });
    bus.on('error', () => {
      throw 'a bare string';
    });

    bus.emit('error', { id: 'e1' });

    const reported = onSubscriberError.mock.calls[0]?.[0] as { message?: string } | undefined;
    expect(reported?.message).toBe('a bare string');
  });

  it('survives a throwing subscriber with no error hook installed', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('error', () => {
      throw new Error('bad subscriber');
    });

    expect(() => bus.emit('error', { id: 'e1' })).not.toThrow();
  });

  it('reports subscriber counts and clears them', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('error', () => undefined);
    bus.on('error', () => undefined);
    bus.on('request', () => undefined);

    expect(bus.subscriberCount('error')).toBe(2);
    expect(bus.subscriberCount('request')).toBe(1);

    bus.clear();

    expect(bus.subscriberCount('error')).toBe(0);
    expect(bus.subscriberCount('request')).toBe(0);
  });

  it('reports zero for a type that was never used', () => {
    expect(new EventBus<TestEvents>().subscriberCount('error')).toBe(0);
  });

  it('is safe to unsubscribe twice', () => {
    const bus = new EventBus<TestEvents>();
    const off = bus.on('error', () => undefined);

    off();
    expect(() => off()).not.toThrow();
  });
});
