import { useCallback, useEffect, useState } from 'react';
import type { VideoRecord, VideoSummary } from '../capture/videos';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import { Badge, Button, ErrorNote, Section } from './components';
import { formatDuration, formatTimestamp, type RunAction, type Tr } from './types';

export function LibraryTab(props: {
  tr: Tr;
  runAction: RunAction;
  busyAction: string | null;
  language: string;
}) {
  const { tr, runAction, busyAction } = props;
  const [list, setList] = useState<VideoSummary[] | null>(null);
  const [selected, setSelected] = useState<VideoRecord | null>(null);
  const [localError, setLocalError] = useState<SerializedError | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await sendRequest('videos/list', undefined));
    } catch (err) {
      setLocalError(AppError.wrap(err).toJSON());
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (id: string) =>
    runAction(`open:${id}`, async () => {
      setLocalError(null);
      const result = await sendRequest('videos/get', { id });
      if (result.record) {
        setSelected(result.record);
      } else {
        await refresh();
      }
    });

  const remove = (item: VideoSummary) => {
    if (!window.confirm(tr('library.deleteConfirm', { title: item.title })))
      return;
    void runAction(`remove:${item.id}`, async () => {
      await sendRequest('videos/remove', { id: item.id });
      if (selected?.id === item.id) setSelected(null);
      await refresh();
    });
  };

  const formatDate = (ts: number): string =>
    new Date(ts).toLocaleString(props.language === 'ar' ? 'ar' : 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  if (selected) {
    return (
      <Section
        title={tr('library.transcript')}
        action={
          <Button onClick={() => setSelected(null)}>{tr('library.back')}</Button>
        }
      >
        <div className="space-y-2 text-xs">
          <div>
            <p className="font-medium text-slate-100">{selected.title}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {selected.channel && `${selected.channel} · `}
              {selected.language && `${tr('video.language')}: ${selected.language} · `}
              {tr('video.segments', { count: selected.segmentCount })}
            </p>
          </div>
          {localError && <ErrorNote error={localError} />}
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-slate-800 bg-slate-950/60 p-2">
            {selected.transcript.segments.map((segment, index) => (
              <p key={index} className="text-[11px] leading-relaxed">
                <span className="me-1.5 font-mono text-[10px] text-indigo-400">
                  [{formatTimestamp(segment.startMs)}]
                </span>
                <span className="text-slate-200">{segment.text}</span>
              </p>
            ))}
          </div>
          <Button variant="danger" onClick={() => remove(selected)}>
            {tr('common.delete')}
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section title={tr('tab.library')}>
      {localError && (
        <div className="mb-2">
          <ErrorNote error={localError} />
        </div>
      )}
      {list === null ? (
        <p className="text-xs text-slate-500">{tr('common.loading')}</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-slate-500">{tr('library.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((item) => (
            <li
              key={item.id}
              className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs"
            >
              <p className="truncate font-medium text-slate-100">{item.title}</p>
              <p className="mt-0.5 text-[10px] text-slate-400">
                {item.channel && `${item.channel} · `}
                {tr('library.capturedAt')} {formatDate(item.capturedAt)}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge>{tr('video.segments', { count: item.segmentCount })}</Badge>
                {item.language && <Badge tone="ok">{item.language}</Badge>}
                {item.durationMs !== undefined && (
                  <Badge>{formatDuration(item.durationMs)}</Badge>
                )}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  onClick={() => void open(item.id)}
                  busy={busyAction === `open:${item.id}`}
                >
                  {tr('library.open')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => remove(item)}
                  busy={busyAction === `remove:${item.id}`}
                >
                  {tr('common.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
