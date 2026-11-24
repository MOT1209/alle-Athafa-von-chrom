import { useCallback, useEffect, useState } from 'react';
import type { ConsentState } from '../capture/consent';
import type { ActiveVideoResult } from '../capture/service';
import type { VideoSummary } from '../capture/videos';
import { AppError, type SerializedError } from '../core/errors';
import { sendRequest } from '../messaging/client';
import { Badge, Button, ErrorNote, Field, inputClass, Section } from './components';
import { formatDuration, type RunAction, type Tr } from './types';

export function VideoTab(props: {
  tr: Tr;
  runAction: RunAction;
  busyAction: string | null;
  onOpenLibrary: () => void;
}) {
  const { tr, runAction, busyAction } = props;
  const [active, setActive] = useState<ActiveVideoResult | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [captured, setCaptured] = useState<VideoSummary | null>(null);
  const [localError, setLocalError] = useState<SerializedError | null>(null);
  const [preferredLanguage, setPreferredLanguage] = useState('');
  const [audioStatus, setAudioStatus] = useState<string | null>(null);

  const checkTab = useCallback(async () => {
    setLocalError(null);
    setCaptured(null);
    try {
      const [nextConsent, nextActive] = await Promise.all([
        sendRequest('consent/get', undefined),
        sendRequest('youtube/activeVideo', undefined),
      ]);
      setConsent(nextConsent);
      setActive(nextActive);
    } catch (err) {
      setLocalError(AppError.wrap(err).toJSON());
    }
  }, []);

  useEffect(() => {
    void checkTab();
  }, [checkTab]);

  const grantConsent = () =>
    runAction('grant', async () => {
      const next = await sendRequest('consent/grant', {
        scope: 'youtubeCaptions',
      });
      setConsent(next);
    });

  const revokeConsent = () =>
    runAction('revoke', async () => {
      const next = await sendRequest('consent/revoke', {
        scope: 'youtubeCaptions',
      });
      setConsent(next);
    });

  const capture = () => {
    if (!active?.supported) return;
    const tabId = active.tabId;
    void runAction('capture', async () => {
      setLocalError(null);
      try {
        const language = preferredLanguage.trim();
        const result = await sendRequest('youtube/capture', {
          tabId,
          ...(language ? { preferredLanguage: language } : {}),
        });
        setCaptured(result.record);
      } catch (err) {
        const appError = AppError.wrap(err);
        if (appError.code === 'CAPTURE_UNAVAILABLE') {
          setLocalError({
            ...appError.toJSON(),
            message: /no accessible captions/i.test(appError.message)
              ? tr('video.noCaptions')
              : tr('video.captureFailed'),
          });
        } else {
          setLocalError(appError.toJSON());
        }
      }
    });
  };

  const transcribeAudio = (file: File) => {
    void runAction('transcribe-audio', async () => {
      setLocalError(null);
      setAudioStatus('Reading file…');
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const base64 = btoa(binary);
      setAudioStatus('Transcribing…');
      const result = await sendRequest('stt/transcribe', {
        name: file.name,
        mimeType: file.type,
        data: base64,
      });
      setAudioStatus(`Queued: ${result.taskId}`);
    });
  };

  const video = active?.supported ? active.video : undefined;

  return (
    <div className="space-y-3">
      <Section
        title={tr('tab.video')}
        action={
          <Button onClick={() => void checkTab()} busy={busyAction === 'check'}>
            {tr('video.refresh')}
          </Button>
        }
      >
        {localError && (
          <div className="mb-2">
            <ErrorNote
              error={localError}
              onClose={() => setLocalError(null)}
              closeLabel={tr('common.close')}
            />
          </div>
        )}

        {active === null ? (
          <p className="text-xs text-slate-500">{tr('video.checking')}</p>
        ) : !active.supported ? (
          <p className="text-xs text-slate-400">
            {active.reason === 'no-active-tab'
              ? tr('video.noActiveTab')
              : tr('video.notYoutube')}
          </p>
        ) : (
          <div className="space-y-2 text-xs">
            <div>
              <p className="font-medium text-slate-100">{video?.title}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {video?.channel && `${tr('video.channel')}: ${video.channel} · `}
                {video?.durationMs !== undefined &&
                  `${tr('video.duration')}: ${formatDuration(video.durationMs)} · `}
                {tr('video.tracks')}: {video?.captionTracks.length ?? 0}
              </p>
              {video && video.captionTracks.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {video.captionTracks.map((track) => (
                    <Badge
                      key={`${track.languageCode}-${track.kind}`}
                      tone={track.kind === 'manual' ? 'ok' : 'info'}
                    >
                      {track.languageCode} ·{' '}
                      {track.kind === 'manual'
                        ? tr('video.trackManual')
                        : tr('video.trackAsr')}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <Field label={tr('video.preferredLanguage')}>
              <input
                className={inputClass}
                value={preferredLanguage}
                placeholder="en / ar / …"
                onChange={(event) => setPreferredLanguage(event.target.value)}
              />
            </Field>

            {consent === null ? (
              <p className="text-[11px] text-slate-500">{tr('common.loading')}</p>
            ) : !consent.youtubeCaptions ? (
              <div className="rounded-md border border-amber-900/60 bg-amber-950/40 p-2">
                <p className="text-[11px] font-semibold text-amber-300">
                  {tr('video.consentTitle')}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-100/80">
                  {tr('video.consentBody')}
                </p>
                <div className="mt-2">
                  <Button
                    variant="primary"
                    onClick={grantConsent}
                    busy={busyAction === 'grant'}
                  >
                    {tr('video.grant')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={capture}
                    busy={busyAction === 'capture'}
                  >
                    {tr('video.capture')}
                  </Button>
                  <Button
                    onClick={revokeConsent}
                    busy={busyAction === 'revoke'}
                  >
                    {tr('video.revoke')}
                  </Button>
                </div>
                <p className="text-[10px] text-emerald-400/80">
                  {tr('video.consentGranted')}
                </p>
              </div>
            )}

            {captured && (
              <div className="rounded-md border border-emerald-900/60 bg-emerald-950/40 p-2">
                <p className="text-[11px] text-emerald-300">
                  {tr('video.captured', { count: captured.segmentCount })}
                </p>
                <div className="mt-1.5">
                  <Button onClick={props.onOpenLibrary}>
                    {tr('video.viewInLibrary')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Audio transcription (Whisper)">
        <div className="space-y-2 text-xs">
          <p className="text-[11px] text-slate-400">
            Transcribe a local audio/video file with a whisper.cpp server on
            port 8178. Requires whisper-server running locally.
          </p>
          {audioStatus && <p className="text-[10px] text-indigo-300">{audioStatus}</p>}
          <input
            type="file"
            accept="audio/*,video/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) transcribeAudio(file);
            }}
            className={inputClass}
          />
        </div>
      </Section>
    </div>
  );
}
