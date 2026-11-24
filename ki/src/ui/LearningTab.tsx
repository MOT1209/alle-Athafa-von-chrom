import { useCallback, useEffect, useState } from 'react';
import type { TaskView } from '../ai/queue';
import type { VideoSummary } from '../capture/videos';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import type { LearningListItem, LearningRecord } from '../learning/repository';
import { Badge, Button, ErrorNote, ProgressBar, Section } from './components';
import { formatTimestamp, type RunAction, type Tr } from './types';

function isActiveTask(task: TaskView | undefined): task is TaskView {
  return !!task && (task.status === 'queued' || task.status === 'running' || task.waitingRetry === true);
}

export function LearningTab(props: {
  tr: Tr;
  runAction: RunAction;
  busyAction: string | null;
  tasks: TaskView[];
  language: string;
}) {
  const { runAction, busyAction } = props;
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [items, setItems] = useState<LearningListItem[] | null>(null);
  const [selected, setSelected] = useState<LearningRecord | null>(null);
  const [mode, setMode] = useState<'cards' | 'quiz' | 'study'>('cards');
  const [quizIndex, setQuizIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [localError, setLocalError] = useState<SerializedError | null>(null);
  const terminalSeen = useState<Set<string> | null>(null)[0] ?? new Set<string>();

  const refresh = useCallback(async () => {
    const [videoList, itemList] = await Promise.all([
      sendRequest('videos/list', undefined),
      sendRequest('learning/list', undefined),
    ]);
    setVideos(videoList);
    setItems(itemList);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
  }, [refresh]);

  useEffect(() => {
    const terminal = props.tasks.filter(
      (t) => t.kind === 'video-learning' && (t.status === 'succeeded' || t.status === 'failed' || t.status === 'cancelled'),
    );
    // simple: refresh on new succeeded
    const newly = terminal.filter((t) => !terminalSeen.has(t.id));
    for (const t of newly) terminalSeen.add(t.id);
    if (newly.some((t) => t.status === 'succeeded')) {
      void refresh().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
    }
  }, [props.tasks, refresh, terminalSeen]);

  const itemFor = (id: string) => items?.find((i) => i.videoRecordId === id);

  const open = (video: VideoSummary) =>
    runAction(`learning-open:${video.id}`, async () => {
      setLocalError(null);
      const result = await sendRequest('learning/get', { videoRecordId: video.id });
      if (result.record) {
        setSelected(result.record);
        setMode('cards');
        setQuizIndex(0);
        setRevealed(false);
      } else {
        setLocalError(new AppError('INVALID_INPUT', 'No study material yet.').toJSON());
      }
    });

  const generate = (video: VideoSummary) =>
    runAction(`learning-gen:${video.id}`, async () => {
      setLocalError(null);
      await sendRequest('learning/generate', { videoRecordId: video.id });
    });

  const remove = (video: VideoSummary) => {
    if (!window.confirm('Delete study material?')) return;
    void runAction(`learning-rm:${video.id}`, async () => {
      await sendRequest('learning/remove', { videoRecordId: video.id });
      if (selected?.videoRecordId === video.id) setSelected(null);
      await refresh();
    });
  };

  const review = (cardId: string, rating: 'again' | 'hard' | 'good' | 'easy') => {
    if (!selected) return;
    void runAction(`learning-review:${cardId}`, async () => {
      await sendRequest('learning/review', { videoRecordId: selected.videoRecordId, cardId, rating });
      const result = await sendRequest('learning/get', { videoRecordId: selected.videoRecordId });
      if (result.record) setSelected(result.record);
    });
  };

  const latestTaskFor = (id: string) => {
    for (let i = props.tasks.length - 1; i >= 0; i--) {
      const t = props.tasks[i];
      if (t && t.kind === 'video-learning' && t.meta?.videoRecordId === id) return t;
    }
    return undefined;
  };

  if (selected) {
    const dueCards = selected.flashcards.filter((c) => c.review.dueAt <= Date.now());
    return (
      <Section title="Study material" action={<Button onClick={() => setSelected(null)}>Back</Button>}>
        <div className="space-y-2 text-xs">
          <p className="font-medium text-slate-100">{selected.videoTitle}</p>
          <div className="flex gap-1.5">
            <Button onClick={() => setMode('cards')}>Cards ({selected.flashcards.length})</Button>
            <Button onClick={() => setMode('quiz')}>Quiz ({selected.quizzes.length})</Button>
            <Button onClick={() => setMode('study')}>Study ({dueCards.length} due)</Button>
          </div>

          {mode === 'cards' && (
            <ul className="space-y-1.5">
              {selected.flashcards.map((card) => (
                <li key={card.id} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                  <p className="font-medium text-slate-100">{card.front}</p>
                  <p className="mt-0.5 text-slate-300">{card.back}</p>
                  {card.sourceTimestampMs !== undefined && (
                    <p className="mt-0.5 text-[10px] text-slate-500">{formatTimestamp(card.sourceTimestampMs)}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {mode === 'quiz' && selected.quizzes.length > 0 && (
            <div className="space-y-2">
              {(() => {
                const q = selected.quizzes[Math.min(quizIndex, selected.quizzes.length - 1)]!;
                return (
                  <div className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                    <p className="font-medium text-slate-100">{q.question}</p>
                    {q.options && (
                      <ul className="mt-1 space-y-1">
                        {q.options.map((opt, i) => (
                          <li key={i} className="rounded border border-slate-700 px-2 py-1">{opt}</li>
                        ))}
                      </ul>
                    )}
                    <Button onClick={() => setRevealed((r) => !r)}>{revealed ? 'Hide answer' : 'Show answer'}</Button>
                    {revealed && (
                      <div className="mt-1">
                        <p className="text-emerald-300">Answer: {q.answer}</p>
                        {q.explanation && <p className="text-slate-400">{q.explanation}</p>}
                      </div>
                    )}
                    <div className="mt-1.5 flex gap-1.5">
                      <Button onClick={() => { setQuizIndex((i) => Math.min(i + 1, selected.quizzes.length - 1)); setRevealed(false); }}>Next</Button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {mode === 'study' && (
            <div className="space-y-2">
              {dueCards.length === 0 ? (
                <p className="text-xs text-slate-500">No cards due.</p>
              ) : (
                dueCards.map((card) => (
                  <div key={card.id} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                    <p className="font-medium text-slate-100">{card.front}</p>
                    <p className="mt-0.5 text-slate-300">{card.back}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(['again', 'hard', 'good', 'easy'] as const).map((r) => (
                        <Button key={r} onClick={() => review(card.id, r)}>{r}</Button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </Section>
    );
  }

  return (
    <Section title="Study material">
      <div className="space-y-2">
        {localError && <ErrorNote error={localError} onClose={() => setLocalError(null)} closeLabel="Close" />}
        {videos === null || items === null ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : videos.length === 0 ? (
          <p className="text-xs text-slate-500">No captured videos yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {videos.map((video) => {
              const item = itemFor(video.id);
              const task = latestTaskFor(video.id);
              const active = isActiveTask(task);
              return (
                <li key={video.id} className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs">
                  <p className="truncate font-medium text-slate-100">{video.title}</p>
                  {item && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge tone="ok">{item.cardCount} cards</Badge>
                      <Badge>{item.quizCount} quizzes</Badge>
                      <Badge>{item.dueCount} due</Badge>
                    </div>
                  )}
                  {active && task && (
                    <div className="mt-1.5 space-y-1 rounded-md border border-indigo-900/60 bg-indigo-950/30 p-1.5">
                      <ProgressBar percent={task.progress?.percent} />
                      <p className="text-[10px] text-indigo-200">{task.progress?.message ?? 'Generating…'}</p>
                      <Button busy={busyAction === `learning-cancel:${task.id}`} onClick={() => sendRequest('queue/cancel', { taskId: task.id })}>Cancel</Button>
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {item && <Button onClick={() => void open(video)}>Open</Button>}
                    {!active && (
                      <Button variant={item ? 'default' : 'primary'} busy={busyAction === `learning-gen:${video.id}`} onClick={() => void generate(video)}>
                        {item ? 'Regenerate' : 'Generate'}
                      </Button>
                    )}
                    {item && <Button variant="danger" busy={busyAction === `learning-rm:${video.id}`} onClick={() => remove(video)}>Delete</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}