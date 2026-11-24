import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskView } from '../ai/queue';
import type { VideoSummary } from '../capture/videos';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import type { ChatListItem, ChatRecord } from '../chat/repository';
import {
  Badge,
  Button,
  ErrorNote,
  ProgressBar,
  Section,
  inputClass,
} from './components';
import { formatDuration, formatTimestamp, type RunAction, type Tr } from './types';

function isActiveTask(task: TaskView | undefined): task is TaskView {
  return (
    !!task &&
    (task.status === 'queued' ||
      task.status === 'running' ||
      task.waitingRetry === true)
  );
}

function videoUrlAt(base: string, ms: number): string {
  try {
    const url = new URL(base);
    url.searchParams.set('t', `${Math.floor(ms / 1000)}s`);
    return url.toString();
  } catch {
    return base;
  }
}

export function ChatTab(props: {
  tr: Tr;
  runAction: RunAction;
  busyAction: string | null;
  tasks: TaskView[];
  language: string;
}) {
  const { tr, runAction, busyAction } = props;
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [chats, setChats] = useState<ChatListItem[] | null>(null);
  const [selected, setSelected] = useState<{
    video: VideoSummary;
    record: ChatRecord | null;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<SerializedError | null>(null);
  const terminalSeen = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    const [videoList, chatList] = await Promise.all([
      sendRequest('videos/list', undefined),
      sendRequest('chat/list', undefined),
    ]);
    setVideos(videoList);
    setChats(chatList);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
  }, [refresh]);

  const loadHistory = useCallback(async (video: VideoSummary) => {
    const result = await sendRequest('chat/history', {
      videoRecordId: video.id,
    });
    setSelected({ video, record: result.record });
  }, []);

  // Answers are saved when their task succeeds; reload on that transition
  // without polling. Terminal tasks at mount are already reflected by the
  // initial history load.
  useEffect(() => {
    const terminal = props.tasks.filter(
      (task) =>
        task.kind === 'video-chat' &&
        (task.status === 'succeeded' ||
          task.status === 'failed' ||
          task.status === 'cancelled'),
    );
    if (terminalSeen.current === null) {
      terminalSeen.current = new Set(terminal.map((task) => task.id));
      return;
    }
    const seen = terminalSeen.current;
    const newlySucceeded: TaskView[] = [];
    for (const task of terminal) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      if (task.status === 'succeeded') newlySucceeded.push(task);
    }
    if (newlySucceeded.length === 0) return;
    void refresh().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
    if (
      selected &&
      newlySucceeded.some(
        (task) => task.meta?.videoRecordId === selected.video.id,
      )
    ) {
      void loadHistory(selected.video).catch((err) =>
        setLocalError(AppError.wrap(err).toJSON()),
      );
    }
  }, [props.tasks, refresh, selected, loadHistory]);

  const latestTaskFor = (videoRecordId: string): TaskView | undefined => {
    for (let index = props.tasks.length - 1; index >= 0; index -= 1) {
      const task = props.tasks[index];
      if (
        task &&
        task.kind === 'video-chat' &&
        task.meta?.videoRecordId === videoRecordId
      ) {
        return task;
      }
    }
    return undefined;
  };

  const chatFor = (videoRecordId: string): ChatListItem | undefined =>
    chats?.find((item) => item.videoRecordId === videoRecordId);

  const formatDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleString(props.language === 'ar' ? 'ar' : 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  const open = (video: VideoSummary) =>
    runAction(`chat-open:${video.id}`, async () => {
      setLocalError(null);
      await loadHistory(video);
    });

  const ask = () => {
    if (!selected) return;
    const question = draft.trim();
    if (question.length === 0) {
      setLocalError(
        new AppError('INVALID_INPUT', tr('chat.emptyQuestion')).toJSON(),
      );
      return;
    }
    void runAction(`chat-ask:${selected.video.id}`, async () => {
      setLocalError(null);
      await sendRequest('chat/ask', {
        videoRecordId: selected.video.id,
        question,
      });
      setDraft('');
    });
  };

  const clear = (video: VideoSummary) => {
    if (!window.confirm(tr('chat.clearConfirm', { title: video.title }))) {
      return;
    }
    void runAction(`chat-clear:${video.id}`, async () => {
      await sendRequest('chat/clear', { videoRecordId: video.id });
      if (selected?.video.id === video.id) {
        setSelected({ video, record: null });
      }
      await refresh();
    });
  };

  const cancel = (task: TaskView) => {
    void runAction(`chat-cancel:${task.id}`, async () => {
      await sendRequest('queue/cancel', { taskId: task.id });
    });
  };

  const retry = (task: TaskView) => {
    void runAction(`chat-retry:${task.id}`, async () => {
      await sendRequest('queue/retry', { taskId: task.id });
    });
  };

  const taskBlock = (task: TaskView) => (
    <div className="mt-1.5 space-y-1 rounded-md border border-indigo-900/60 bg-indigo-950/30 p-1.5">
      <ProgressBar percent={task.progress?.percent} />
      <p className="text-[10px] text-indigo-200">
        {task.waitingRetry
          ? tr('queue.retrying')
          : task.progress?.message ?? tr('chat.progress')}
      </p>
      <p className="text-[10px] text-slate-400">{tr('chat.askHint')}</p>
      <Button
        busy={busyAction === `chat-cancel:${task.id}`}
        onClick={() => cancel(task)}
      >
        {tr('common.cancel')}
      </Button>
    </div>
  );

  const failureBlock = (task: TaskView) =>
    task.error ? (
      <div className="mt-1.5 space-y-1">
        <ErrorNote error={task.error} />
        <Button
          busy={busyAction === `chat-retry:${task.id}`}
          onClick={() => retry(task)}
        >
          {tr('chat.retryTask')}
        </Button>
      </div>
    ) : null;

  if (selected) {
    const task = latestTaskFor(selected.video.id);
    const active = isActiveTask(task);
    const failed =
      task?.status === 'failed' ? task : undefined;
    return (
      <Section
        title={tr('chat.title')}
        action={
          <Button onClick={() => setSelected(null)}>{tr('chat.back')}</Button>
        }
      >
        <div className="space-y-2 text-xs">
          <div>
            <p className="font-medium text-slate-100">{selected.video.title}</p>
            <p className="mt-0.5 text-[10px] text-slate-400">
              {selected.video.channel && `${selected.video.channel} · `}
              {selected.video.durationMs !== undefined &&
                `${formatDuration(selected.video.durationMs)} · `}
              {tr('video.segments', { count: selected.video.segmentCount })}
            </p>
          </div>

          <p className="text-[10px] leading-relaxed text-slate-500">
            {tr('chat.localNote')}
          </p>

          {localError && (
            <ErrorNote
              error={localError}
              onClose={() => setLocalError(null)}
              closeLabel={tr('common.close')}
            />
          )}

          {active && task && taskBlock(task)}
          {failed && failureBlock(failed)}

          {!selected.record || selected.record.messages.length === 0 ? (
            <p className="text-xs text-slate-500">{tr('chat.noConversation')}</p>
          ) : (
            <ul className="space-y-1.5">
              {selected.record.messages.map((message) => (
                <li
                  key={message.id}
                  className={
                    message.role === 'user'
                      ? 'ms-6 rounded-md border border-indigo-900/60 bg-indigo-950/40 p-2'
                      : 'me-6 rounded-md border border-slate-800 bg-slate-950/60 p-2'
                  }
                >
                  <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    {message.role === 'user'
                      ? tr('chat.you')
                      : tr('chat.assistant')}
                  </p>
                  {message.role === 'assistant' && message.notInVideo ? (
                    <p className="mt-0.5 leading-relaxed text-amber-300">
                      {tr('chat.notInVideo')}
                    </p>
                  ) : (
                    <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-slate-200">
                      {message.text}
                    </p>
                  )}
                  {message.citations && message.citations.length > 0 && (
                    <div className="mt-1 space-y-1 border-t border-slate-800 pt-1">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">
                        {tr('chat.citations')}
                      </p>
                      {message.citations.map((citation, index) => (
                        <div
                          key={`${citation.startMs}-${index}`}
                          className="flex gap-1.5"
                        >
                          <a
                            href={videoUrlAt(
                              selected.video.url,
                              citation.startMs,
                            )}
                            target="_blank"
                            rel="noreferrer"
                            title={tr('chat.openAt', {
                              time: formatTimestamp(citation.startMs),
                            })}
                            className="shrink-0 font-mono text-[10px] text-indigo-400 underline-offset-2 hover:underline"
                          >
                            [{formatTimestamp(citation.startMs)}]
                          </a>
                          <span className="text-[10px] leading-relaxed text-slate-400">
                            {citation.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-end gap-1.5">
            <input
              type="text"
              value={draft}
              disabled={active}
              placeholder={tr('chat.placeholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') ask();
              }}
              className={inputClass}
            />
            <Button
              variant="primary"
              disabled={active}
              busy={busyAction === `chat-ask:${selected.video.id}`}
              onClick={ask}
            >
              {tr('chat.ask')}
            </Button>
          </div>

          {selected.record && selected.record.messages.length > 0 && (
            <Button
              variant="danger"
              busy={busyAction === `chat-clear:${selected.video.id}`}
              onClick={() => clear(selected.video)}
            >
              {tr('chat.clear')}
            </Button>
          )}
        </div>
      </Section>
    );
  }

  return (
    <Section title={tr('chat.title')}>
      <div className="space-y-2">
        <p className="text-[11px] leading-relaxed text-slate-400">
          {tr('chat.localNote')}
        </p>
        {localError && (
          <ErrorNote
            error={localError}
            onClose={() => setLocalError(null)}
            closeLabel={tr('common.close')}
          />
        )}
        {videos === null || chats === null ? (
          <p className="text-xs text-slate-500">{tr('common.loading')}</p>
        ) : videos.length === 0 ? (
          <p className="text-xs text-slate-500">{tr('chat.empty')}</p>
        ) : (
          <>
            {chats.length === 0 && (
              <p className="text-xs text-slate-500">{tr('chat.none')}</p>
            )}
            <ul className="space-y-1.5">
              {videos.map((video) => {
                const item = chatFor(video.id);
                const task = latestTaskFor(video.id);
                const active = isActiveTask(task);
                const failed =
                  task?.status === 'failed' ? task : undefined;
                return (
                  <li
                    key={video.id}
                    className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs"
                  >
                    <p className="truncate font-medium text-slate-100">
                      {video.title}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {video.channel && `${video.channel} · `}
                      {video.durationMs !== undefined &&
                        `${formatDuration(video.durationMs)} · `}
                      {tr('video.segments', { count: video.segmentCount })}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {item ? (
                        <Badge tone="ok">
                          {tr('chat.messages', { count: item.messageCount })}
                        </Badge>
                      ) : (
                        <Badge tone="warn">{tr('chat.noConversation')}</Badge>
                      )}
                      {item && (
                        <Badge>
                          {tr('chat.updated')}: {formatDate(item.updatedAt)}
                        </Badge>
                      )}
                    </div>

                    {active && task && taskBlock(task)}
                    {failed && failureBlock(failed)}

                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Button
                        variant={item ? 'default' : 'primary'}
                        busy={busyAction === `chat-open:${video.id}`}
                        onClick={() => void open(video)}
                      >
                        {item ? tr('chat.open') : tr('chat.ask')}
                      </Button>
                      {item && (
                        <Button
                          variant="danger"
                          busy={busyAction === `chat-clear:${video.id}`}
                          onClick={() => clear(video)}
                        >
                          {tr('chat.clear')}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
}
