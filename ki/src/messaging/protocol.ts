import type { LoadedModel, ModelInfo } from '../ai/types';
import type { TaskProgress, TaskView } from '../ai/queue';
import type { SerializedError } from '../core/errors';
import type { Language } from '../core/i18n';
import type { Settings, SettingsPatch } from '../storage/settings';

/**
 * Typed message protocol between UI pages and the background service worker.
 * Every request/response pair is declared here once; router and client derive
 * their types from this map, so drift is a compile error, not a runtime bug.
 */

export interface RuntimeStatus {
  ollama: {
    reachable: boolean;
    version?: string;
    error?: SerializedError;
  };
  models: ModelInfo[];
  loadedModels: LoadedModel[];
  memory: {
    deviceMb: number | null;
    reserveMb: number;
    availableMb: number | null;
  };
  queue: TaskView[];
  settings: Settings;
}

export interface ConnectionTest {
  ok: boolean;
  version?: string;
  modelCount?: number;
  latencyMs: number;
  error?: SerializedError;
}

export interface ModelTestResult {
  ok: boolean;
  reply?: string;
  latencyMs?: number;
  error?: SerializedError;
}

export interface RequestMap {
  'settings/get': { payload: undefined; response: Settings };
  'settings/update': { payload: SettingsPatch; response: Settings };
  'settings/reset': { payload: undefined; response: Settings };
  'runtime/status': { payload: undefined; response: RuntimeStatus };
  'runtime/testConnection': { payload: undefined; response: ConnectionTest };
  'runtime/testModel': { payload: { model: string }; response: { taskId: string } };
  'runtime/pullModel': { payload: { model: string }; response: { taskId: string } };
  'runtime/deleteModel': { payload: { model: string }; response: { deleted: boolean } };
  'queue/list': { payload: undefined; response: TaskView[] };
  'queue/cancel': { payload: { taskId: string }; response: { cancelled: boolean } };
  'queue/retry': { payload: { taskId: string }; response: TaskView };
}

export type RequestType = keyof RequestMap;

export interface RequestEnvelope<K extends RequestType = RequestType> {
  kind: 'videoking/request';
  id: string;
  type: K;
  payload: RequestMap[K]['payload'];
}

export type ResponseEnvelope =
  | { ok: true; id: string; data: unknown }
  | { ok: false; id: string; error: SerializedError };

export type BackgroundEvent =
  | { type: 'queue'; tasks: TaskView[] }
  | { type: 'task-progress'; taskId: string; progress: TaskProgress }
  | { type: 'settings'; settings: Settings };

export const EVENTS_PORT_NAME = 'videoking-events';
export const REQUEST_KIND = 'videoking/request';

export function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === REQUEST_KIND &&
    typeof v.id === 'string' &&
    isRequestType(v.type)
  );
}

const REQUEST_TYPES: ReadonlySet<string> = new Set<string>([
  'settings/get',
  'settings/update',
  'settings/reset',
  'runtime/status',
  'runtime/testConnection',
  'runtime/testModel',
  'runtime/pullModel',
  'runtime/deleteModel',
  'queue/list',
  'queue/cancel',
  'queue/retry',
]);

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === 'string' && REQUEST_TYPES.has(value);
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return false;
  if (v.ok === true) return 'data' in v;
  if (v.ok === false) return isErrorShape(v.error);
  return false;
}

function isErrorShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.name === 'AppError' &&
    typeof v.code === 'string' &&
    typeof v.message === 'string' &&
    typeof v.retryable === 'boolean'
  );
}

export function isBackgroundEvent(value: unknown): value is BackgroundEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'queue') return Array.isArray(v.tasks);
  if (v.type === 'task-progress')
    return typeof v.taskId === 'string' && typeof v.progress === 'object';
  if (v.type === 'settings')
    return typeof v.settings === 'object' && v.settings !== null;
  return false;
}

export type { Language, Settings, SettingsPatch };
