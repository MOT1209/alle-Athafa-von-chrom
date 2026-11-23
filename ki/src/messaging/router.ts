import { AppError } from '../core/errors';
import {
  isRequestEnvelope,
  type RequestMap,
  type RequestType,
  type ResponseEnvelope,
} from './protocol';

/**
 * Background-side message router. Every handler failure is converted to a
 * serialized AppError — the UI never sees a raw exception or a silent hang.
 */

export type Handler<K extends RequestType> = (
  payload: RequestMap[K]['payload'],
) => Promise<RequestMap[K]['response']> | RequestMap[K]['response'];

export type Handlers = { [K in RequestType]: Handler<K> };

export type Router = (
  message: unknown,
) => Promise<ResponseEnvelope | undefined>;

export function createRouter(handlers: Handlers): Router {
  return async function route(message: unknown) {
    if (!isRequestEnvelope(message)) return undefined;
    const { id, type } = message;
    try {
      const handler = handlers[type];
      if (!handler) {
        throw new AppError('INVALID_INPUT', `Unknown request type: ${type}`);
      }
      const data = await handler(message.payload as never);
      return { ok: true, id, data };
    } catch (err) {
      return { ok: false, id, error: AppError.wrap(err).toJSON() };
    }
  };
}
