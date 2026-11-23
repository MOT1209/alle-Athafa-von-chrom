import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/events';

interface TestEvents extends Record<string, unknown> {
  ping: { value: number };
  pong: string;
}

describe('Emitter', () => {
  it('delivers payloads to subscribers', () => {
    const emitter = new Emitter<TestEvents>();
    const received: Array<{ value: number }> = [];
    emitter.on('ping', (payload) => received.push(payload));
    emitter.emit('ping', { value: 1 });
    emitter.emit('ping', { value: 2 });
    expect(received).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('unsubscribe stops delivery', () => {
    const emitter = new Emitter<TestEvents>();
    const fn = vi.fn();
    const off = emitter.on('pong', fn);
    off();
    emitter.emit('pong', 'x');
    expect(fn).not.toHaveBeenCalled();
    expect(emitter.listenerCount('pong')).toBe(0);
  });

  it('isolates a throwing listener from the others', () => {
    const emitter = new Emitter<TestEvents>();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    emitter.on('pong', () => {
      throw new Error('broken listener');
    });
    emitter.on('pong', good);
    emitter.emit('pong', 'x');
    expect(good).toHaveBeenCalledWith('x');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('emit with no listeners is a no-op', () => {
    const emitter = new Emitter<TestEvents>();
    expect(() => emitter.emit('ping', { value: 1 })).not.toThrow();
  });

  it('clear removes all listeners', () => {
    const emitter = new Emitter<TestEvents>();
    emitter.on('ping', vi.fn());
    emitter.on('pong', vi.fn());
    emitter.clear();
    expect(emitter.listenerCount('ping')).toBe(0);
    expect(emitter.listenerCount('pong')).toBe(0);
  });

  it('supports multiple listeners per event', () => {
    const emitter = new Emitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('ping', a);
    emitter.on('ping', b);
    emitter.emit('ping', { value: 9 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(emitter.listenerCount('ping')).toBe(2);
  });
});
