import { useCallback, useEffect, useState } from 'react';
import type { TaskView } from '../ai/queue';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import type { StoredStory } from '../studio/repository';
import { Button, ErrorNote, ProgressBar, Section, inputClass } from './components';
import { type RunAction, type Tr } from './types';

function isActiveTask(task: TaskView | undefined): task is TaskView {
  return !!task && (task.status === 'queued' || task.status === 'running' || task.waitingRetry === true);
}

export function StudioTab(props: { tr: Tr; runAction: RunAction; busyAction: string | null; tasks: TaskView[]; language: string }) {
  const { runAction, busyAction } = props;
  const [concept, setConcept] = useState('');
  const [stories, setStories] = useState<Array<{ id: string; concept: string; title: string; segmentCount: number; createdAt: number }> | null>(null);
  const [selected, setSelected] = useState<StoredStory | null>(null);
  const [localError, setLocalError] = useState<SerializedError | null>(null);

  const refresh = useCallback(async () => {
    const list = await sendRequest('studio/list', undefined);
    setStories(list);
  }, []);

  useEffect(() => { void refresh().catch((e) => setLocalError(AppError.wrap(e).toJSON())); }, [refresh]);

  const generate = () => {
    if (!concept.trim()) return;
    void runAction('studio-gen', async () => {
      setLocalError(null);
      await sendRequest('studio/generate', { concept: concept.trim() });
      await refresh();
    });
  };

  const open = (id: string) =>
    runAction(`studio-open:${id}`, async () => {
      setLocalError(null);
      const result = await sendRequest('studio/get', { id });
      if (result.record) setSelected(result.record);
    });

  const remove = (id: string) =>
    void runAction(`studio-rm:${id}`, async () => {
      await sendRequest('studio/remove', { id });
      if (selected?.id === id) setSelected(null);
      await refresh();
    });

  const latestTask = props.tasks.filter((t) => t.kind === 'kids-story').slice(-1)[0];
  const active = isActiveTask(latestTask);

  if (selected) {
    return (
      <Section title={selected.title} action={<Button onClick={() => setSelected(null)}>Back</Button>}>
        <div className="space-y-2 text-xs">
          <p className="text-[10px] text-slate-400">Concept: {selected.concept}</p>
          <ul className="space-y-1.5">
            {selected.segments.map((seg, i) => (
              <li key={i} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                <p className="text-slate-200">{seg.text}</p>
                {seg.emotion && <p className="mt-0.5 text-[10px] text-slate-500">{seg.emotion}</p>}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-slate-500">
            TTS: requires a local Piper server. Use the audio file picker in the Video tab if available.
          </p>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Kids story studio">
      <div className="space-y-2">
        {localError && <ErrorNote error={localError} onClose={() => setLocalError(null)} closeLabel="Close" />}
        <div className="flex gap-1.5">
          <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Story concept (Arabic)…" className={inputClass} />
          <Button busy={busyAction === 'studio-gen'} onClick={generate}>Generate</Button>
        </div>
        {active && latestTask && (
          <div className="mt-1.5 space-y-1 rounded-md border border-indigo-900/60 bg-indigo-950/30 p-1.5">
            <ProgressBar percent={latestTask.progress?.percent} />
            <p className="text-[10px] text-indigo-200">{latestTask.progress?.message ?? 'Generating…'}</p>
          </div>
        )}
        {stories === null ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : stories.length === 0 ? (
          <p className="text-xs text-slate-500">No stories yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {stories.map((s) => (
              <li key={s.id} className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs">
                <p className="font-medium text-slate-100">{s.title}</p>
                <p className="text-[10px] text-slate-400">{s.concept} · {s.segmentCount} segments</p>
                <div className="mt-1.5 flex gap-1.5">
                  <Button onClick={() => void open(s.id)}>Open</Button>
                  <Button variant="danger" busy={busyAction === `studio-rm:${s.id}`} onClick={() => remove(s.id)}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}