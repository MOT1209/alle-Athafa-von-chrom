import { useCallback, useEffect, useState } from 'react';
import type { VideoSummary } from '../capture/videos';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import type { TranscriptSearchHit } from '../transcripts/search';
import type { TranslationBundle } from '../transcripts/translations';
import { Button, ErrorNote, Section, inputClass } from './components';
import { formatDuration, formatTimestamp, type RunAction, type Tr } from './types';

export function TranscriptTab(props: {
  tr: Tr;
  runAction: RunAction;
  busyAction: string | null;
  language: string;
}) {
  const { tr, runAction, busyAction } = props;
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [selected, setSelected] = useState<VideoSummary | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TranscriptSearchHit[] | null>(null);
  const [translation, setTranslation] = useState<TranslationBundle | null>(null);
  const [targetLanguage, setTargetLanguage] = useState('ar');
  const [stale, setStale] = useState<string[]>([]);
  const [localError, setLocalError] = useState<SerializedError | null>(null);

  const refreshVideos = useCallback(async () => {
    const list = await sendRequest('videos/list', undefined);
    setVideos(list);
  }, []);

  useEffect(() => {
    void refreshVideos().catch((err) => setLocalError(AppError.wrap(err).toJSON()));
  }, [refreshVideos]);

  const search = () => {
    void runAction('transcript-search', async () => {
      setLocalError(null);
      const result = await sendRequest('transcripts/search', {
        query,
        limit: 50,
      });
      setHits(result.hits);
    });
  };

  const download = async (format: 'txt' | 'md' | 'srt' | 'vtt') => {
    if (!selected) return;
    const result = await sendRequest('videos/get', { id: selected.id });
    const record = result.record;
    if (!record) return;
    const { exportTranscript, suggestExportFilename, EXPORT_MIME_TYPES } = await import(
      '../transcripts/export'
    );
    const text = exportTranscript(format, {
      title: record.title,
      segments: record.transcript.segments,
      language: record.language,
      sourceUrl: record.url,
    });
    const blob = new Blob([text], { type: EXPORT_MIME_TYPES[format] });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = suggestExportFilename(record.title, format, record.language);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const loadTranslation = async (video: VideoSummary) => {
    const result = await sendRequest('translations/get', { videoRecordId: video.id });
    setTranslation(result.bundle);
    setStale(result.staleLanguages);
  };

  const generateTranslation = () => {
    if (!selected) return;
    void runAction(`transcript-translate:${selected.id}`, async () => {
      setLocalError(null);
      await sendRequest('translations/generate', {
        videoRecordId: selected.id,
        targetLanguage,
      });
      await loadTranslation(selected);
    });
  };

  const exportTranslation = async (format: 'txt' | 'md' | 'srt' | 'vtt') => {
    if (!selected || !translation) return;
    const entry = translation.translations[targetLanguage] ?? Object.values(translation.translations)[0];
    if (!entry) return;
    const { exportTranscript, suggestExportFilename, EXPORT_MIME_TYPES } = await import(
      '../transcripts/export'
    );
    const text = exportTranscript(format, {
      title: selected.title,
      segments: entry.segments,
      language: entry.targetLanguage,
      sourceUrl: selected.url,
    });
    const blob = new Blob([text], { type: EXPORT_MIME_TYPES[format] });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = suggestExportFilename(selected.title, format, entry.targetLanguage);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (selected) {
    return (
      <Section
        title={tr('tab.transcript')}
        action={
          <Button onClick={() => setSelected(null)}>{tr('common.close')}</Button>
        }
      >
        <div className="space-y-2 text-xs">
          <p className="font-medium text-slate-100">{selected.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {(['txt', 'md', 'srt', 'vtt'] as const).map((format) => (
              <Button
                key={format}
                busy={busyAction === `transcript-export:${selected.id}`}
                onClick={() => void download(format)}
              >
                {tr('common.save')} {format.toUpperCase()}
              </Button>
            ))}
          </div>

          <div className="space-y-1 rounded-md border border-slate-800 bg-slate-950/60 p-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              {tr('tab.transcript')}
            </p>
            <div className="flex gap-1.5">
              <select
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.target.value)}
                className={inputClass}
              >
                {[
                  'ar', 'en', 'fr', 'es', 'de', 'tr', 'ur', 'hi', 'id', 'ms',
                  'ru', 'pt', 'it', 'zh', 'ja', 'ko', 'fa', 'he', 'sw',
                ].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              <Button
                busy={busyAction === `transcript-translate:${selected.id}`}
                onClick={generateTranslation}
              >
                Translate
              </Button>
            </div>
            {stale.length > 0 && (
              <p className="text-[10px] text-amber-300">
                Stale: {stale.join(', ')}
              </p>
            )}
            {translation && (
              <div className="flex flex-wrap gap-1.5">
                {(['txt', 'md', 'srt', 'vtt'] as const).map((format) => (
                  <Button
                    key={`t-${format}`}
                    onClick={() => void exportTranslation(format)}
                  >
                    Export {format.toUpperCase()}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section title={tr('tab.transcript')}>
      <div className="space-y-2">
        {localError && (
          <ErrorNote
            error={localError}
            onClose={() => setLocalError(null)}
            closeLabel={tr('common.close')}
          />
        )}
        <div className="flex gap-1.5">
          <input
            type="text"
            value={query}
            placeholder="Search transcripts…"
            onChange={(event) => setQuery(event.target.value)}
            className={inputClass}
          />
          <Button busy={busyAction === 'transcript-search'} onClick={search}>
            Search
          </Button>
        </div>
        {hits && (
          <ul className="space-y-1">
            {hits.map((hit, index) => (
              <li
                key={`${hit.videoRecordId}-${hit.segmentIndex}-${index}`}
                className="rounded-md border border-slate-800 bg-slate-950/60 p-1.5 text-[11px]"
              >
                <p className="font-medium text-slate-100">{hit.videoTitle}</p>
                <p className="text-slate-300">{hit.text}</p>
                <p className="text-[10px] text-slate-500">
                  {formatTimestamp(hit.startMs)} · {formatDuration(hit.endMs - hit.startMs)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {videos === null ? (
          <p className="text-xs text-slate-500">{tr('common.loading')}</p>
        ) : videos.length === 0 ? (
          <p className="text-xs text-slate-500">No captured videos yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {videos.map((video) => (
              <li
                key={video.id}
                className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs"
              >
                <p className="truncate font-medium text-slate-100">{video.title}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button
                    onClick={() => {
                      setSelected(video);
                      void loadTranslation(video);
                    }}
                  >
                    Open
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}