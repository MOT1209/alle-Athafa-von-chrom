import { useCallback, useEffect, useState } from 'react';
import type { TaskView } from '../ai/queue';
import { AppError, type SerializedError } from '../core/errors';
import { isRtl, t, type Language, type MessageKey } from '../core/i18n';
import { sendRequest, subscribeEvents } from '../messaging/client';
import type { BackgroundEvent, RuntimeStatus } from '../messaging/protocol';
import type { Settings } from '../storage/settings';
import { Button, ErrorNote } from './components';
import { ChatTab } from './ChatTab';
import { LearningTab } from './LearningTab';
import { LibraryTab } from './LibraryTab';
import { RuntimeTab } from './RuntimeTab';
import { SummaryTab } from './SummaryTab';
import { TranscriptTab } from './TranscriptTab';
import { VideoTab } from './VideoTab';

type Tab = 'runtime' | 'video' | 'library' | 'summary' | 'chat' | 'transcript' | 'learning';
type Vars = Record<string, string | number>;

export function App() {
  const [tab, setTab] = useState<Tab>('runtime');
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [globalError, setGlobalError] = useState<SerializedError | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

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

  const toggleLanguage = () =>
    runAction('lang', async () => {
      const next: Language = lang === 'en' ? 'ar' : 'en';
      const updated = await sendRequest('settings/update', { language: next });
      setSettings(updated);
    });

  const onSettingsChanged = useCallback((next: Settings) => {
    setSettings(next);
    setStatus((prev) => (prev ? { ...prev, settings: next } : prev));
  }, []);

  const tabs: Array<{ id: Tab; labelKey: MessageKey }> = [
    { id: 'runtime', labelKey: 'tab.runtime' },
    { id: 'video', labelKey: 'tab.video' },
    { id: 'library', labelKey: 'tab.library' },
    { id: 'summary', labelKey: 'tab.summary' },
    { id: 'chat', labelKey: 'tab.chat' },
    { id: 'transcript', labelKey: 'tab.transcript' },
    { id: 'learning', labelKey: 'tab.learning' },
  ];

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

      <nav className="flex gap-1 rounded-lg bg-slate-900/70 p-1">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`flex-1 rounded-md px-1 py-1 text-[10px] font-medium transition-colors ${
              tab === entry.id
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {tr(entry.labelKey)}
          </button>
        ))}
      </nav>

      {globalError && (
        <ErrorNote
          error={globalError}
          onClose={() => setGlobalError(null)}
          closeLabel={tr('common.close')}
        />
      )}

      {tab === 'runtime' && (
        <RuntimeTab
          status={status}
          settings={settings}
          tasks={tasks}
          busyAction={busyAction}
          tr={tr}
          runAction={runAction}
          refresh={refresh}
          onSettingsChanged={onSettingsChanged}
        />
      )}
      {tab === 'video' && (
        <VideoTab
          tr={tr}
          runAction={runAction}
          busyAction={busyAction}
          onOpenLibrary={() => setTab('library')}
        />
      )}
      {tab === 'library' && (
        <LibraryTab
          tr={tr}
          runAction={runAction}
          busyAction={busyAction}
          language={lang}
        />
      )}
      {tab === 'summary' && (
        <SummaryTab
          tr={tr}
          runAction={runAction}
          busyAction={busyAction}
          tasks={tasks}
          language={lang}
        />
      )}
      {tab === 'chat' && (
        <ChatTab
          tr={tr}
          runAction={runAction}
          busyAction={busyAction}
          tasks={tasks}
          language={lang}
        />
      )}
      {tab === 'transcript' && (
        <TranscriptTab
          tr={tr}
          runAction={runAction}
          busyAction={busyAction}
          language={lang}
        />
      )}
      {tab === 'learning' && (
        <LearningTab
          tr={tr}
          runAction={runAction}
          busyAction={busyAction}
          tasks={tasks}
          language={lang}
        />
      )}

      <footer className="pb-1 text-center text-[10px] leading-relaxed text-slate-500">
        {tr('app.phaseNote')}
      </footer>
    </div>
  );
}
