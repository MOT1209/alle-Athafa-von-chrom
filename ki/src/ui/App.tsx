import { useCallback, useEffect, useState } from 'react';
import type { TaskView } from '../ai/queue';
import { AppError, type SerializedError } from '../core/errors';
import { isRtl, t, type Language, type MessageKey } from '../core/i18n';
import { sendRequest, subscribeEvents } from '../messaging/client';
import type {
  BackgroundEvent,
  ConnectionTest,
  RuntimeStatus,
} from '../messaging/protocol';
import type { Settings } from '../storage/settings';
import {
  Badge,
  Button,
  ErrorNote,
  Field,
  inputClass,
  ProgressBar,
  Section,
  StatusDot,
} from './components';

type Vars = Record<string, string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatGb(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(2);
}

export function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [connTest, setConnTest] = useState<ConnectionTest | null>(null);
  const [globalError, setGlobalError] = useState<SerializedError | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pullName, setPullName] = useState('qwen2.5:1.5b');
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const lang: Language = settings?.language ?? 'en';
  const tr = useCallback(
    (key: MessageKey, vars?: Vars) => t(lang, key, vars),
    [lang],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await sendRequest('runtime/status', undefined);
      setStatus(next);
      setSettings(next.settings);
      setTasks(next.queue);
    } catch (err) {
      setGlobalError(AppError.wrap(err).toJSON());
    }
  }, []);

  const onEvent = useCallback((event: BackgroundEvent) => {
    if (event.type === 'queue') {
      setTasks(event.tasks);
    } else if (event.type === 'settings') {
      setSettings(event.settings);
    } else if (event.type === 'task-progress') {
      setTasks((prev) =>
        prev.map((task) =>
          task.id === event.taskId
            ? { ...task, progress: event.progress }
            : task,
        ),
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    let cleanup: (() => void) | undefined;
    let reconnectTimer: number | undefined;
    const connect = () => {
      cleanup = subscribeEvents(onEvent, () => {
        // Port died (SW restart): refresh state and reconnect.
        void refresh();
        reconnectTimer = window.setTimeout(connect, 1000);
      });
    };
    connect();
    const poll = window.setInterval(() => {
      void sendRequest('queue/list', undefined)
        .then(setTasks)
        .catch(() => {
          // Events/reconnect cover recovery; polling is best-effort.
        });
    }, 4000);
    return () => {
      cleanup?.();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      window.clearInterval(poll);
    };
  }, [refresh, onEvent]);

  const runAction = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusyAction(key);
      setGlobalError(null);
      try {
        await fn();
      } catch (err) {
        setGlobalError(AppError.wrap(err).toJSON());
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const testConnection = () =>
    runAction('connection', async () => {
      const result = await sendRequest('runtime/testConnection', undefined);
      setConnTest(result);
      await refresh();
    });

  const useModel = (name: string) =>
    runAction(`use:${name}`, async () => {
      const next = await sendRequest('settings/update', {
        generation: { model: name },
      });
      setSettings(next);
    });

  const testModel = (name: string) =>
    runAction(`test:${name}`, async () => {
      await sendRequest('runtime/testModel', { model: name });
    });

  const pullModel = () =>
    runAction('pull', async () => {
      const name = pullName.trim();
      if (!name) return;
      await sendRequest('runtime/pullModel', { model: name });
    });

  const deleteModel = (name: string) => {
    if (!window.confirm(tr('models.deleteConfirm', { name }))) return;
    void runAction(`delete:${name}`, async () => {
      await sendRequest('runtime/deleteModel', { model: name });
      await refresh();
    });
  };

  const cancelTask = (taskId: string) =>
    runAction(`cancel:${taskId}`, async () => {
      await sendRequest('queue/cancel', { taskId });
    });

  const retryTask = (taskId: string) =>
    runAction(`retry:${taskId}`, async () => {
      await sendRequest('queue/retry', { taskId });
    });

  const toggleLanguage = () =>
    runAction('lang', async () => {
      const next: Language = lang === 'en' ? 'ar' : 'en';
      const updated = await sendRequest('settings/update', { language: next });
      setSettings(updated);
    });

  const openSettings = () => {
    if (settings) setDraft(structuredClone(settings));
    setShowSettings((value) => !value);
  };

  const saveSettings = () =>
    runAction('save', async () => {
      if (!draft) return;
      const next = await sendRequest('settings/update', {
        language: draft.language,
        ollama: draft.ollama,
        generation: draft.generation,
        queue: draft.queue,
        memory: draft.memory,
      });
      setSettings(next);
      setStatus((prev) => (prev ? { ...prev, settings: next } : prev));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    });

  const resetSettings = () =>
    runAction('reset', async () => {
      const next = await sendRequest('settings/reset', undefined);
      setSettings(next);
      setDraft(structuredClone(next));
    });

  const patchDraft = (patch: (current: Settings) => Settings) => {
    setDraft((current) => (current ? patch(current) : current));
  };

  const numberValue = (raw: string, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const connectionState: 'ok' | 'bad' | 'unknown' = status
    ? status.ollama.reachable
      ? 'ok'
      : 'bad'
    : 'unknown';

  const defaultModel = settings?.generation.model;

  return (
    <div
      dir={isRtl(lang) ? 'rtl' : 'ltr'}
      className="space-y-3 p-3 text-slate-200"
    >
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-sm font-bold text-white">{tr('app.title')}</h1>
          <p className="text-[11px] text-slate-400">{tr('app.tagline')}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button onClick={toggleLanguage} busy={busyAction === 'lang'}>
            {tr('app.language')}
          </Button>
          <Button onClick={() => void refresh()} title={tr('common.refresh')}>
            ⟳
          </Button>
        </div>
      </header>

      {globalError && (
        <ErrorNote
          error={globalError}
          onClose={() => setGlobalError(null)}
          closeLabel={tr('common.close')}
        />
      )}

      <Section
        title={tr('runtime.title')}
        action={
          <Button
            variant="primary"
            onClick={testConnection}
            busy={busyAction === 'connection'}
          >
            {tr('runtime.testConnection')}
          </Button>
        }
      >
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <StatusDot state={connectionState} />
            <span>
              {status === null
                ? tr('status.checking')
                : status.ollama.reachable
                  ? tr('status.connected')
                  : tr('status.disconnected')}
            </span>
            {status?.ollama.version && (
              <span className="text-slate-400">
                {tr('runtime.version')} {status.ollama.version}
              </span>
            )}
          </div>

          {status && !status.ollama.reachable && status.ollama.error && (
            <ErrorNote error={status.ollama.error} />
          )}

          {connTest && (
            <p className={connTest.ok ? 'text-emerald-400' : 'text-rose-400'}>
              {connTest.ok
                ? `${tr('status.connected')} · ${tr('runtime.latencyMs', { ms: connTest.latencyMs })} · ${tr('runtime.modelCount', { count: connTest.modelCount ?? 0 })}`
                : (connTest.error?.message ?? tr('status.disconnected'))}
            </p>
          )}

          <div>
            <p className="mb-1 text-[11px] text-slate-400">
              {tr('runtime.loaded')}
            </p>
            {status && status.loadedModels.length > 0 ? (
              <ul className="space-y-1">
                {status.loadedModels.map((model) => (
                  <li
                    key={model.name}
                    className="flex items-center justify-between rounded bg-slate-950/70 px-2 py-1"
                  >
                    <span className="font-mono text-[11px]">{model.name}</span>
                    <span className="text-[10px] text-slate-400">
                      {tr('runtime.vram', {
                        mb: Math.round(model.sizeVramBytes / (1024 * 1024)),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-slate-500">
                {tr('runtime.noneLoaded')}
              </p>
            )}
          </div>

          <p className="text-[11px] text-slate-400">
            {tr('runtime.memory')}:{' '}
            {status?.memory.availableMb === null || status === null
              ? tr('runtime.memoryUnknown')
              : `${status.memory.availableMb} MB / ${status.memory.deviceMb} MB`}
          </p>
        </div>
      </Section>

      <Section title={tr('models.title')}>
        <div className="mb-2 flex gap-1.5">
          <input
            className={inputClass}
            value={pullName}
            placeholder={tr('models.pullPlaceholder')}
            onChange={(event) => setPullName(event.target.value)}
          />
          <Button
            variant="primary"
            onClick={pullModel}
            busy={busyAction === 'pull'}
            disabled={pullName.trim().length === 0}
          >
            {tr('models.pull')}
          </Button>
        </div>

        {status === null ? (
          <p className="text-xs text-slate-500">{tr('common.loading')}</p>
        ) : status.models.length === 0 ? (
          <p className="text-xs text-slate-500">{tr('models.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {status.models.map((model) => (
              <li
                key={model.name}
                className="rounded-md border border-slate-800 bg-slate-950/60 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px] text-slate-100">
                    {model.name}
                  </span>
                  {model.name === defaultModel && (
                    <Badge tone="ok">{tr('models.defaultBadge')}</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  {tr('models.sizeGb', { gb: formatGb(model.sizeBytes) })}
                  {model.parameterSize &&
                    ` · ${tr('models.params', { size: model.parameterSize })}`}
                  {model.quantization &&
                    ` · ${tr('models.quant', { level: model.quantization })}`}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <Button
                    onClick={() => void useModel(model.name)}
                    disabled={model.name === defaultModel}
                    busy={busyAction === `use:${model.name}`}
                  >
                    {tr('models.use')}
                  </Button>
                  <Button
                    onClick={() => void testModel(model.name)}
                    busy={busyAction === `test:${model.name}`}
                  >
                    {tr('common.test')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => deleteModel(model.name)}
                    busy={busyAction === `delete:${model.name}`}
                  >
                    {tr('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={tr('queue.title')}>
        {tasks.length === 0 ? (
          <p className="text-xs text-slate-500">{tr('queue.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {[...tasks].reverse().map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                tr={tr}
                busyAction={busyAction}
                onCancel={cancelTask}
                onRetry={retryTask}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={tr('settings.title')}
        action={
          <Button onClick={openSettings}>
            {showSettings ? tr('common.close') : '⚙'}
          </Button>
        }
      >
        {!showSettings || !draft ? (
          <p className="text-[11px] text-slate-500">{tr('settings.hint')}</p>
        ) : (
          <div className="space-y-2">
            <Field label={tr('settings.baseUrl')}>
              <input
                className={inputClass}
                value={draft.ollama.baseUrl}
                onChange={(event) =>
                  patchDraft((current) => ({
                    ...current,
                    ollama: {
                      ...current.ollama,
                      baseUrl: event.target.value,
                    },
                  }))
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={tr('settings.keepAlive')}>
                <input
                  className={inputClass}
                  value={draft.ollama.keepAlive}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      ollama: {
                        ...current.ollama,
                        keepAlive: event.target.value,
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.requestTimeout')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.ollama.requestTimeoutMs}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      ollama: {
                        ...current.ollama,
                        requestTimeoutMs: numberValue(
                          event.target.value,
                          current.ollama.requestTimeoutMs,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.numCtx')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.generation.numCtx}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      generation: {
                        ...current.generation,
                        numCtx: numberValue(
                          event.target.value,
                          current.generation.numCtx,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.temperature')}>
                <input
                  type="number"
                  step="0.1"
                  className={inputClass}
                  value={draft.generation.temperature}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      generation: {
                        ...current.generation,
                        temperature: numberValue(
                          event.target.value,
                          current.generation.temperature,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.numPredict')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.generation.numPredict}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      generation: {
                        ...current.generation,
                        numPredict: numberValue(
                          event.target.value,
                          current.generation.numPredict,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.maxRetries')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.queue.maxRetries}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      queue: {
                        ...current.queue,
                        maxRetries: numberValue(
                          event.target.value,
                          current.queue.maxRetries,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.retryDelay')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.queue.retryBaseDelayMs}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      queue: {
                        ...current.queue,
                        retryBaseDelayMs: numberValue(
                          event.target.value,
                          current.queue.retryBaseDelayMs,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.maxQueue')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.queue.maxQueueSize}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      queue: {
                        ...current.queue,
                        maxQueueSize: numberValue(
                          event.target.value,
                          current.queue.maxQueueSize,
                        ),
                      },
                    }))
                  }
                />
              </Field>
              <Field label={tr('settings.reserveMb')}>
                <input
                  type="number"
                  className={inputClass}
                  value={draft.memory.reserveMb}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      memory: {
                        ...current.memory,
                        reserveMb: numberValue(
                          event.target.value,
                          current.memory.reserveMb,
                        ),
                      },
                    }))
                  }
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={draft.memory.enforceBudget}
                onChange={(event) =>
                  patchDraft((current) => ({
                    ...current,
                    memory: {
                      ...current.memory,
                      enforceBudget: event.target.checked,
                    },
                  }))
                }
              />
              {tr('settings.enforceBudget')}
            </label>
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={draft.memory.unloadAfterTask}
                onChange={(event) =>
                  patchDraft((current) => ({
                    ...current,
                    memory: {
                      ...current.memory,
                      unloadAfterTask: event.target.checked,
                    },
                  }))
                }
              />
              {tr('settings.unloadAfterTask')}
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={saveSettings}
                busy={busyAction === 'save'}
              >
                {tr('common.save')}
              </Button>
              <Button
                onClick={resetSettings}
                busy={busyAction === 'reset'}
              >
                {tr('common.reset')}
              </Button>
              {savedFlash && (
                <span className="text-[11px] text-emerald-400">
                  {tr('settings.saved')}
                </span>
              )}
            </div>
          </div>
        )}
      </Section>

      <footer className="pb-1 text-center text-[10px] leading-relaxed text-slate-500">
        {tr('app.phaseNote')}
      </footer>
    </div>
  );
}

function TaskRow(props: {
  task: TaskView;
  tr: (key: MessageKey, vars?: Vars) => string;
  busyAction: string | null;
  onCancel: (taskId: string) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
}) {
  const { task, tr } = props;
  const statusKey = `queue.${task.status}` as MessageKey;
  const tone =
    task.status === 'succeeded'
      ? 'ok'
      : task.status === 'failed'
        ? 'bad'
        : task.status === 'running'
          ? 'warn'
          : 'info';

  const result = isRecord(task.result) ? task.result : undefined;
  const reply =
    result && typeof result.reply === 'string' ? result.reply : undefined;

  return (
    <li className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-slate-100">
          {task.label}
        </span>
        <Badge tone={tone}>{tr(statusKey)}</Badge>
      </div>

      <p className="mt-0.5 text-[10px] text-slate-400">
        {tr('queue.attempt', {
          n: Math.max(1, task.attempts),
          max: task.maxRetries + 1,
        })}
        {task.waitingRetry && ` · ${tr('queue.retrying')}`}
      </p>

      {(task.status === 'running' || task.progress) && (
        <div className="mt-1.5 space-y-1">
          <ProgressBar percent={task.progress?.percent} />
          {task.progress?.message && (
            <p className="truncate text-[10px] text-slate-400">
              {task.progress.message}
            </p>
          )}
        </div>
      )}

      {reply !== undefined && (
        <p className="mt-1 text-[11px] text-emerald-400">
          {tr('testModel.reply', { reply })}
        </p>
      )}

      {task.error && task.status !== 'cancelled' && (
        <div className="mt-1.5">
          <ErrorNote error={task.error} />
        </div>
      )}

      <div className="mt-1.5 flex gap-1.5">
        {(task.status === 'queued' || task.status === 'running') && (
          <Button
            variant="danger"
            onClick={() => void props.onCancel(task.id)}
            busy={props.busyAction === `cancel:${task.id}`}
          >
            {tr('common.cancel')}
          </Button>
        )}
        {(task.status === 'failed' || task.status === 'cancelled') &&
          !task.orphaned && (
            <Button
              onClick={() => void props.onRetry(task.id)}
              busy={props.busyAction === `retry:${task.id}`}
            >
              {tr('common.retry')}
            </Button>
          )}
      </div>
    </li>
  );
}
