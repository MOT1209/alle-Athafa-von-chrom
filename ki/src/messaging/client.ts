import { AppError } from '../core/errors';
import { newId } from '../core/ids';
import {
  EVENTS_PORT_NAME,
  isBackgroundEvent,
  isResponseEnvelope,
  type BackgroundEvent,
  type RequestEnvelope,
  type RequestMap,
  type RequestType,
} from './protocol';

/**
 * UI-side RPC client. Typed end to end: the response type is derived from the
 * RequestMap, and serialized background errors are rehydrated into AppError.
 */

export async function sendRequest<K extends RequestType>(
  type: K,
  payload: RequestMap[K]['payload'],
): Promise<RequestMap[K]['response']> {
  const envelope: RequestEnvelope<K> = {
    kind: 'videoking/request',
    id: newId('req'),
    type,
    payload,
  };
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(envelope);
  } catch (err) {
    throw new AppError(
      'NETWORK',
      'Cannot reach the videoKING background worker',
      {
        hint: 'Reload the extension from chrome://extensions and try again.',
        cause: err,
      },
    );
  }
  if (!isResponseEnvelope(response)) {
    throw new AppError(
      'INTERNAL',
      'Invalid response from the background worker',
      { detail: response },
    );
  }
  if (!response.ok) {
    throw (
      AppError.fromJSON(response.error) ??
      new AppError('INTERNAL', 'Unknown background error')
    );
  }
  return response.data as RequestMap[K]['response'];
}

/**
 * Subscribe to background push events over a long-lived port.
 * `onDisconnect` fires when the port dies (e.g. service worker restart) so the
 * caller can reconnect and refresh state.
 */
export function subscribeEvents(
  onEvent: (event: BackgroundEvent) => void,
  onDisconnect?: () => void,
): () => void {
  const port = chrome.runtime.connect({ name: EVENTS_PORT_NAME });
  let disconnected = false;
  port.onMessage.addListener((message: unknown) => {
    if (isBackgroundEvent(message)) onEvent(message);
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    onDisconnect?.();
  });
  return () => {
    if (!disconnected) {
      try {
        port.disconnect();
      } catch {
        // Port already gone; nothing to clean up.
      }
    }
  };
}
