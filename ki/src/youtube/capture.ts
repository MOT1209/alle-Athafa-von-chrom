import {
  extractCfgString,
  extractJsonAssignment,
  findTranscriptParams,
  isRecord,
  parseVideoInfo,
  selectBestTrack,
  type YouTubeVideoInfo,
} from './extract';
import {
  closeSegmentGaps,
  parseInnerTubeSegments,
  parseJson3,
  parseTimedTextXml,
  type RawSegment,
} from './transcript';

/**
 * Content-side capture orchestrator. Tries three real sources, in order:
 *  1. the official get_transcript InnerTube endpoint (same API the YouTube
 *     transcript panel uses),
 *  2. the player's own caption track URL (timedtext),
 *  3. the official transcript panel UI (click + read rendered segments).
 * Every layer is best-effort; failure is reported honestly, never simulated.
 * All I/O is injected so the orchestration is unit-testable.
 */

export type CaptureVia = 'api' | 'direct' | 'ui';

export type CaptureOutcome =
  | {
      ok: true;
      via: CaptureVia;
      segments: RawSegment[];
      language?: string;
      video: YouTubeVideoInfo;
    }
  | { ok: false; reason: 'not-a-video' | 'no-captions' | 'capture-failed'; video?: YouTubeVideoInfo };

export interface TranscriptPanelDom {
  expandDescription: () => void;
  clickTranscriptButton: () => boolean;
  readRenderedSegments: () => RawSegment[];
}

export interface CaptureDeps {
  scriptTexts: string[];
  fetchImpl: typeof fetch;
  panel: TranscriptPanelDom;
  wait: (ms: number) => Promise<void>;
  preferredLanguage?: string;
}

export function readVideoInfo(scriptTexts: string[]): YouTubeVideoInfo | undefined {
  const playerResponse = extractJsonAssignment(
    scriptTexts,
    'ytInitialPlayerResponse',
    (value) => 'videoDetails' in value || 'captions' in value,
  );
  return playerResponse ? parseVideoInfo(playerResponse) : undefined;
}

async function captureViaApi(
  deps: CaptureDeps,
): Promise<{ segments: RawSegment[] } | undefined> {
  const initialData = extractJsonAssignment(deps.scriptTexts, 'ytInitialData');
  const params = findTranscriptParams(initialData);
  const apiKey = extractCfgString(deps.scriptTexts, 'INNERTUBE_API_KEY');
  const clientVersion =
    extractCfgString(deps.scriptTexts, 'INNERTUBE_CLIENT_VERSION') ??
    '2.20250101.00.00';
  const visitorData = extractCfgString(deps.scriptTexts, 'VISITOR_DATA');
  if (!params || !apiKey) return undefined;
  try {
    const client: Record<string, unknown> = {
      clientName: 'WEB',
      clientVersion,
      hl: 'en',
    };
    if (visitorData) client.visitorData = visitorData;
    const response = await deps.fetchImpl(
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client }, params }),
      },
    );
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    const segments = parseInnerTubeSegments(extractInitialSegments(data));
    return segments.length > 0 ? { segments } : undefined;
  } catch {
    return undefined;
  }
}

function extractInitialSegments(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.actions)) return undefined;
  for (const action of data.actions) {
    if (!isRecord(action)) continue;
    const update = isRecord(action.updateEngagementPanelAction)
      ? action.updateEngagementPanelAction
      : undefined;
    const content = isRecord(update?.content) ? update.content : undefined;
    const renderer = isRecord(content?.transcriptRenderer)
      ? content.transcriptRenderer
      : undefined;
    const body = isRecord(renderer?.body) ? renderer.body : undefined;
    const bodyRenderer = isRecord(body?.transcriptBodyRenderer)
      ? body.transcriptBodyRenderer
      : undefined;
    if (Array.isArray(bodyRenderer?.initialSegments)) {
      return bodyRenderer.initialSegments;
    }
  }
  return undefined;
}

async function captureViaDirect(
  deps: CaptureDeps,
  video: YouTubeVideoInfo,
): Promise<{ segments: RawSegment[]; language: string } | undefined> {
  const track = selectBestTrack(video.captionTracks, deps.preferredLanguage);
  if (!track) return undefined;
  try {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    const response = await deps.fetchImpl(url.toString(), {
      credentials: 'include',
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (body.trim().length === 0) return undefined; // POT-blocked: empty 200
    let segments: RawSegment[] = [];
    try {
      segments = parseJson3(JSON.parse(body));
    } catch {
      segments = parseTimedTextXml(body);
    }
    return segments.length > 0
      ? { segments, language: track.languageCode }
      : undefined;
  } catch {
    return undefined;
  }
}

async function captureViaUi(
  deps: CaptureDeps,
): Promise<{ segments: RawSegment[] } | undefined> {
  try {
    deps.panel.expandDescription();
    await deps.wait(800);
    if (!deps.panel.clickTranscriptButton()) return undefined;
    for (let attempt = 0; attempt < 24; attempt++) {
      await deps.wait(500);
      const segments = deps.panel.readRenderedSegments();
      if (segments.length > 0) {
        return { segments: closeSegmentGaps(segments) };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function runCapture(deps: CaptureDeps): Promise<CaptureOutcome> {
  const video = readVideoInfo(deps.scriptTexts);
  if (!video) return { ok: false, reason: 'not-a-video' };

  const api = await captureViaApi(deps);
  if (api) {
    return { ok: true, via: 'api', segments: api.segments, video };
  }

  if (video.captionTracks.length === 0) {
    return { ok: false, reason: 'no-captions', video };
  }

  const direct = await captureViaDirect(deps, video);
  if (direct) {
    return {
      ok: true,
      via: 'direct',
      segments: direct.segments,
      language: direct.language,
      video,
    };
  }

  const ui = await captureViaUi(deps);
  if (ui) {
    return { ok: true, via: 'ui', segments: ui.segments, video };
  }

  return { ok: false, reason: 'capture-failed', video };
}
