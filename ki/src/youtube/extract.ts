/**
 * Pure extraction helpers for YouTube page data.
 * No DOM access here — functions take script texts / parsed JSON so they are
 * fully unit-testable with fixtures. The content script collects the inputs.
 *
 * Only data the page itself exposes is read (ytInitialPlayerResponse /
 * ytInitialData / ytcfg). No DRM or access-control bypass.
 */

export interface CaptionTrackInfo {
  languageCode: string;
  label: string;
  kind: 'manual' | 'asr';
  baseUrl: string;
}

export interface YouTubeVideoInfo {
  videoId: string;
  title: string;
  channel?: string;
  durationMs?: number;
  captionTracks: CaptionTrackInfo[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // YouTube often serializes numbers as strings (e.g. lengthSeconds: "19").
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Slice a complete JSON object starting at `start`, respecting strings and
 * escapes. Returns undefined when unbalanced (never throws).
 */
export function sliceJsonObject(
  text: string,
  start: number,
): string | undefined {
  if (text[start] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Find `marker = {...};` inside page script texts and parse the object.
 * `validate` lets callers reject wrong-marker hits (e.g. a player response
 * without videoDetails) and keep searching.
 */
export function extractJsonAssignment(
  scriptTexts: string[],
  marker: string,
  validate?: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const text of scriptTexts) {
    let searchFrom = 0;
    for (;;) {
      const idx = text.indexOf(marker, searchFrom);
      if (idx < 0) break;
      searchFrom = idx + marker.length;
      const eq = text.indexOf('=', idx);
      if (eq < 0) continue;
      const start = text.indexOf('{', eq);
      if (start < 0 || start - eq > 4) continue;
      const json = sliceJsonObject(text, start);
      if (!json) continue;
      try {
        const parsed: unknown = JSON.parse(json);
        if (isRecord(parsed) && (!validate || validate(parsed))) {
          return parsed;
        }
      } catch {
        // Malformed candidate — keep searching.
      }
    }
  }
  return undefined;
}

/** Extract a flat string config value (INNERTUBE_API_KEY, VISITOR_DATA, ...). */
export function extractCfgString(
  scriptTexts: string[],
  key: string,
): string | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`);
  for (const text of scriptTexts) {
    const match = pattern.exec(text);
    const value = match?.[1];
    if (value) return value;
  }
  return undefined;
}

export function parseCaptionTracks(
  playerResponse: Record<string, unknown>,
): CaptionTrackInfo[] {
  const captions = isRecord(playerResponse.captions)
    ? playerResponse.captions
    : undefined;
  const renderer = isRecord(captions?.playerCaptionsTracklistRenderer)
    ? captions.playerCaptionsTracklistRenderer
    : undefined;
  const rawTracks = Array.isArray(renderer?.captionTracks)
    ? renderer.captionTracks
    : [];
  const tracks: CaptionTrackInfo[] = [];
  for (const raw of rawTracks) {
    if (!isRecord(raw)) continue;
    const baseUrl = asString(raw.baseUrl);
    const languageCode = asString(raw.languageCode);
    if (!baseUrl || !languageCode) continue;
    const name = isRecord(raw.name) ? raw.name : undefined;
    const runs = Array.isArray(name?.runs) ? name.runs : [];
    const firstRun = isRecord(runs[0]) ? runs[0] : undefined;
    const label =
      asString(name?.simpleText) ?? asString(firstRun?.text) ?? languageCode;
    tracks.push({
      languageCode,
      label,
      kind: raw.kind === 'asr' ? 'asr' : 'manual',
      baseUrl,
    });
  }
  return tracks;
}

export function parseVideoInfo(
  playerResponse: Record<string, unknown>,
): YouTubeVideoInfo | undefined {
  const details = isRecord(playerResponse.videoDetails)
    ? playerResponse.videoDetails
    : undefined;
  const videoId = asString(details?.videoId);
  if (!videoId) return undefined;
  const info: YouTubeVideoInfo = {
    videoId,
    title: asString(details?.title) ?? '',
    captionTracks: parseCaptionTracks(playerResponse),
  };
  const channel = asString(details?.author);
  const lengthSeconds = asNumber(details?.lengthSeconds);
  if (channel) info.channel = channel;
  if (lengthSeconds !== undefined)
    info.durationMs = Math.round(lengthSeconds * 1000);
  return info;
}

/** Prefer manual captions over auto-generated (asr), then preferred language. */
export function selectBestTrack(
  tracks: CaptionTrackInfo[],
  preferredLanguage?: string,
): CaptionTrackInfo | undefined {
  if (tracks.length === 0) return undefined;
  const manual = tracks.filter((track) => track.kind === 'manual');
  const pool = manual.length > 0 ? manual : tracks;
  if (preferredLanguage) {
    const exact = pool.find(
      (track) => track.languageCode === preferredLanguage,
    );
    if (exact) return exact;
    const prefix = pool.find((track) =>
      track.languageCode.startsWith(`${preferredLanguage}-`),
    );
    if (prefix) return prefix;
  }
  return pool[0];
}

/**
 * Deep-search ytInitialData for the official transcript endpoint params
 * (used by YouTube's own "Show transcript" panel).
 */
export function findTranscriptParams(
  initialData: Record<string, unknown> | undefined,
): string | undefined {
  if (!initialData) return undefined;
  const seen = new Set<unknown>();
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: initialData, depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const { node, depth } = item;
    if (depth > 60 || typeof node !== 'object' || node === null || seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      for (const value of node) {
        if (typeof value === 'object' && value !== null) {
          stack.push({ node: value, depth: depth + 1 });
        }
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    const endpoint = isRecord(record.getTranscriptEndpoint)
      ? record.getTranscriptEndpoint
      : undefined;
    const params = asString(endpoint?.params);
    if (params) return params;
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        stack.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return undefined;
}
