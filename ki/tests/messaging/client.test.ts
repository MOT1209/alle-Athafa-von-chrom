import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRequest, subscribeEvents } from '../../src/messaging/client';
import { AppError } from '../../src/core/errors';
import type { BackgroundEvent } from '../../src/messaging/protocol';

function stubChrome(sendMessage: (message: unknown) => Promise<unknown>) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(sendMessage),
      connect: vi.fn(),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendRequest', () => {
  it('returns typed data on success', async () => {
    stubChrome(async () => ({ ok: true, id: 'req_1', data: { cancelled: true } }));
    const result = await sendRequest('queue/cancel', { taskId: 'x' });
    expect(result).toEqual({ cancelled: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'videomind/request',
        type: 'queue/cancel',
        payload: { taskId: 'x' },
      }),
    );
  });

  it('rehydrates background errors into AppError', async () => {
    stubChrome(async () => ({
      ok: false,
      id: 'req_1',
      error: {
        name: 'AppError',
        code: 'MODEL_NOT_FOUND',
        message: 'missing',
        retryable: false,
        hint: 'pull it',
      },
    }));
    await expect(sendRequest('runtime/deleteModel', { model: 'x' })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      hint: 'pull it',
    });
  });

  it('throws INTERNAL on malformed responses', async () => {
    stubChrome(async () => ({ weird: true }));
    await expect(sendRequest('queue/list', undefined)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('throws NETWORK when the worker is unreachable', async () => {
    stubChrome(async () => {
      throw new Error('Could not establish connection');
    });
    await expect(sendRequest('queue/list', undefined)).rejects.toBeInstanceOf(AppError);
    await expect(sendRequest('queue/list', undefined)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });
});

interface FakePort {
  name: string;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  disconnect: () => void;
  postMessage: (msg: unknown) => void;
  emit: (msg: unknown) => void;
  disconnectRemote: () => void;
}

function makeFakePort(): FakePort {
  let messageListener: ((msg: unknown) => void) | undefined;
  let disconnectListener: (() => void) | undefined;
  return {
    name: 'videomind-events',
    onMessage: {
      addListener: (fn) => {
        messageListener = fn;
      },
    },
    onDisconnect: {
      addListener: (fn) => {
        disconnectListener = fn;
      },
    },
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    emit: (msg) => messageListener?.(msg),
    disconnectRemote: () => disconnectListener?.(),
  };
}

describe('subscribeEvents', () => {
  it('delivers valid background events and filters junk', () => {
    const port = makeFakePort();
    vi.stubGlobal('chrome', {
      runtime: { connect: vi.fn(() => port), sendMessage: vi.fn() },
    });
    const received: BackgroundEvent[] = [];
    subscribeEvents((event) => received.push(event));
    port.emit({ type: 'queue', tasks: [] });
    port.emit({ type: 'nonsense' });
    port.emit(null);
    expect(received).toEqual([{ type: 'queue', tasks: [] }]);
    expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: 'videomind-events' });
  });

  it('unsubscribe disconnects the port', () => {
    const port = makeFakePort();
    vi.stubGlobal('chrome', {
      runtime: { connect: vi.fn(() => port), sendMessage: vi.fn() },
    });
    const unsubscribe = subscribeEvents(() => {});
    unsubscribe();
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('fires onDisconnect when the port dies', () => {
    const port = makeFakePort();
    vi.stubGlobal('chrome', {
      runtime: { connect: vi.fn(() => port), sendMessage: vi.fn() },
    });
    const onDisconnect = vi.fn();
    const unsubscribe = subscribeEvents(() => {}, onDisconnect);
    port.disconnectRemote();
    expect(onDisconnect).toHaveBeenCalled();
    // After remote disconnect, unsubscribe must not throw.
    expect(() => unsubscribe()).not.toThrow();
  });
});
