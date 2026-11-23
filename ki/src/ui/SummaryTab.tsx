import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskView } from '../ai/queue';
import type { VideoSummary } from '../capture/videos';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import type { SummaryListItem, SummaryRecord } from '../summary/repository';
import { Badge, Button, ErrorNote, ProgressBar, Section } from './components';
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

export function SummaryTab(props: {
  tr: Tr;
  runAction: RunAction;
  busyAction: string | null;
  tasks: TaskView[];
  language: string;
}) {
  const { tr, runAction, busyAction } = props;
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [summaries, setSummaries] = useState<SummaryListItem[] | null>(null);
  const [selected, setSelected] = useState<SummaryRecord | null>(null);
  const [localError, setLocalError] = useState<SerializedError | null>(null);
  const terminalSeen = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    const [videoList, summaryList] = await Promise.all([
      sendRequest('videos/list', undefined),
      sendRequest('summaries/list', undefined),
    ]);
    setVideos(videoList);
    setSummaries(summaryList);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
  }, [refresh]);

  // A summary is saved when its task succeeds; refresh the list on that
  // transition without polling. Existing terminal tasks at mount are ignored
  // because the initial load already reflects them.
  useEffect(() => {
    const terminal = props.tasks.filter(
      (task) =>
        task.kind === 'video-summary' &&
        (task.status === 'succeeded' ||
          task.status === 'failed' ||
          task.status === 'cancelled'),
    );
    if (terminalSeen.current === null) {
      terminalSeen.current = new Set(terminal.map((task) => task.id));
      return;
    }
    const seen = terminalSeen.current;
    let succeeded = false;
    for (const task of terminal) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      if (task.status === 'succeeded') succeeded = true;
    }
    if (succeeded) {
      void refresh().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
    }
  }, [props.tasks, refresh]);

  const latestTaskFor = (videoRecordId: string): TaskView | undefined => {
    for (let index = props.tasks.length - 1; index >= 0; index -= 1) {
      const task = props.tasks[index];
      if (
        task &&
        task.kind === 'video-summary' &&
        task.meta?.videoRecordId === videoRecordId
      ) {
        return task;
      }
    }
    return undefined;
  };

  const summaryFor = (videoRecordId: string): SummaryListItem | undefined =>
    summaries?.find((item) => item.videoRecordId === videoRecordId);

  const formatDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleString(props.language === 'ar' ? 'ar' : 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  const generate = (video: VideoSummary) =>
    runAction(`summary-gen:${video.id}`, async () => {
      setLocalError(null);
      await sendRequest('summaries/generate', { videoRecordId: video.id });
    });

  const open = (video: VideoSummary) =>
    runAction(`summary-open:${video.id}`, async () => {
      setLocalError(null);
      const result = await sendRequest('summaries/get', {
        videoRecordId: video.id,
      });
      if (result.record) {
        setSelected(result.record);
      } else {
        setLocalError(
          new AppError('INVALID_INPUT', tr('summary.noSummary')).toJSON(),
        );
        await refresh();
      }
    });

  const remove = (video: VideoSummary) => {
    if (!window.confirm(tr('summary.deleteConfirm', { title: video.title }))) {
      return;
    }
    void runAction(`summary-rm:${video.id}`, async () => {
      await sendRequest('summaries/remove', { videoRecordId: video.id });
      if (selected?.videoRecordId === video.id) setSelected(null);
      await refresh();
    });
  };

  const cancel = (task: TaskView) => {
    void runAction(`summary-cancel:${task.id}`, async () => {
      await sendRequest('queue/cancel', { taskId: task.id });
    });
  };

  const retry = (task: TaskView) => {
    void runAction(`summary-retry:${task.id}`, async () => {
      await sendRequest('queue/retry', { taskId: task.id });
    });
  };

  if (selected) {
    return (
      <Section
        title={tr('summary.title')}
        action={
          <Button onClick={() => setSelected(null)}>{tr('summary.back')}</Button>
        }
      >
        <div className="space-y-3 text-xs">
          <div>
            <p className="font-medium text-slate-100">{selected.videoTitle}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone="ok">{tr('summary.ready')}</Badge>
              <Badge>
                {tr('summary.model')}: {selected.model}
              </Badge>
              <Badge>
                {tr('summary.parts', { count: selected.chunkCount })}
              </Badge>
              {selected.durationMs !== undefined && (
                <Badge>{formatDuration(selected.durationMs)}</Badge>
              )}
            </div>
            <p className="mt-1 text-[10px] text-slate-400">
              {tr('summary.generated')} {formatDate(selected.createdAt)}
            </p>
          </div>

          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {tr('summary.overview')}
            </h3>
            <p className="leading-relaxed text-slate-200">
              {selected.overview}
            </p>
          </div>

          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {tr('summary.keyPoints')}
            </h3>
            <ol className="space-y-1">
              {selected.keyPoints.map((point, index) => (
                <li
                  key={`${point.timestampMs}-${index}`}
                  className="flex gap-2 rounded-md border border-slate-800 bg-slate-950/60 p-1.5"
                >
                  <a
                    href={videoUrlAt(selected.videoUrl, point.timestampMs)}
                    target="_blank"
                    rel="noreferrer"
                    title={tr('summary.openAt', {
                      time: formatTimestamp(point.timestampMs),
                    })}
                    className="shrink-0 font-mono text-[10px] text-indigo-400 underline-offset-2 hover:underline"
                  >
                    [{formatTimestamp(point.timestampMs)}]
                  </a>
                  <span className="leading-relaxed text-slate-200">
                    {point.text}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {tr('summary.chapters')}
            </h3>
            <ol className="space-y-1">
              {selected.chapters.map((chapter, index) => (
                <li
                  key={`${chapter.startMs}-${index}`}
                  className="rounded-md border border-slate-800 bg-slate-950/60 p-1.5"
                >
                  <p className="flex gap-2">
                    <a
                      href={videoUrlAt(selected.videoUrl, chapter.startMs)}
                      target="_blank"
                      rel="noreferrer"
                      title={tr('summary.openAt', {
                        time: formatTimestamp(chapter.startMs),
                      })}
                      className="shrink-0 font-mono text-[10px] text-indigo-400 underline-offset-2 hover:underline"
                    >
                      [{formatTimestamp(chapter.startMs)}]
                    </a>
                    <span className="font-medium text-slate-100">
                      {chapter.title}
                    </span>
                  </p>
                  {chapter.summary && (
                    <p className="mt-0.5 ps-12 leading-relaxed text-slate-300">
                      {chapter.summary}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>

          <p className="text-[10px] text-slate-500">
            {tr('summary.languageNote')}
          </p>
          <Button
            variant="danger"
            busy={busyAction === `summary-rm:${selected.videoRecordId}`}
            onClick={() => {
              const video = videos?.find(
                (item) => item.id === selected.videoRecordId,
              );
              if (video) remove(video);
            }}
          >
            {tr('common.delete')}
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section title={tr('summary.title')}>
      <div className="space-y-2">
        <p className="text-[11px] leading-relaxed text-slate-400">
          {tr('summary.localNote')}
        </p>
        {localError && (
          <ErrorNote
            error={localError}
            onClose={() => setLocalError(null)}
            closeLabel={tr('common.close')}
          />
        )}
        {videos === null || summaries === null ? (
          <p className="text-xs text-slate-500">{tr('common.loading')}</p>
        ) : videos.length === 0 ? (
          <p className="text-xs text-slate-500">{tr('summary.empty')}</p>
        ) : (
          <>
            {summaries.length === 0 && (
              <p className="text-xs text-slate-500">{tr('summary.none')}</p>
            )}
            <ul className="space-y-1.5">
              {videos.map((video) => {
                const item = summaryFor(video.id);
                const task = latestTaskFor(video.id);
                const active = isActiveTask(task);
                const failed =
                  !item && task?.status === 'failed' ? task : undefined;
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
                        <Badge tone="ok">{tr('summary.ready')}</Badge>
                      ) : (
                        <Badge tone="warn">{tr('summary.noSummary')}</Badge>
                      )}
                      {item && (
                        <Badge>
                          {tr('summary.model')}: {item.model}
                        </Badge>
                      )}
                      {item && (
                        <Badge>
                          {tr('summary.parts', { count: item.chunkCount })}
                        </Badge>
                      )}
                    </div>
                    {item && (
                      <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-slate-300">
                        {item.overviewPreview}
                      </p>
                    )}

                    {active && task && (
                      <div className="mt-1.5 space-y-1 rounded-md border border-indigo-900/60 bg-indigo-950/30 p-1.5">
                        <ProgressBar percent={task.progress?.percent} />
                        <p className="text-[10px] text-indigo-200">
                          {task.waitingRetry
                            ? tr('queue.retrying')
                            : task.progress?.message ?? tr('summary.progress')}
                        </p>
                        <p className="text-[10px] text-slate-400">
                          {tr('summary.cancelNote')}
                        </p>
                        <Button
                          busy={busyAction === `summary-cancel:${task.id}`}
                          onClick={() => cancel(task)}
                        >
                          {tr('common.cancel')}
                        </Button>
                      </div>
                    )}

                    {failed && failed.error && (
                      <div className="mt-1.5 space-y-1">
                        <ErrorNote error={failed.error} />
                        <Button
                          busy={busyAction === `summary-retry:${failed.id}`}
                          onClick={() => retry(failed)}
                        >
                          {tr('summary.retryTask')}
                        </Button>
                      </div>
                    )}

                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {item && (
                        <Button
                          onClick={() => void open(video)}
                          busy={busyAction === `summary-open:${video.id}`}
                        >
                          {tr('summary.open')}
                        </Button>
                      )}
                      {!active && (
                        <Button
                          variant={item ? 'default' : 'primary'}
                          onClick={() => void generate(video)}
                          busy={busyAction === `summary-gen:${video.id}`}
                        >
                          {item ? tr('summary.regenerate') : tr('summary.generate')}
                        </Button>
                      )}
                      {item && (
                        <Button
                          variant="danger"
                          onClick={() => remove(video)}
                          busy={busyAction === `summary-rm:${video.id}`}
                        >
                          {tr('common.delete')}
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
