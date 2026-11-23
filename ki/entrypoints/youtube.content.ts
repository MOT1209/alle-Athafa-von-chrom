import { defineContentScript } from 'wxt/utils/define-content-script';
import { AppError } from '../src/core/errors';
import { runCapture, readVideoInfo, type CaptureDeps, type TranscriptPanelDom } from '../src/youtube/capture';
import { parseTimestampToMs, type RawSegment } from '../src/youtube/transcript';
import type { PageCaptureResponse, PageVideoInfoResponse } from '../src/capture/service';

/**
 * YouTube page adapter (isolated world). Passive by design: it does nothing
 * until the background worker asks, and the background only asks after the
 * user's explicit consent + action. Reads only data the page itself exposes
 * and the official transcript UI — no DRM/access bypass, no media download.
 */

const PAGE_REQUEST_KIND = 'videoking/page-request';

function isPageRequest(
  value: unknown,
): value is { type: 'page/videoInfo' | 'page/capture'; payload?: { preferredLanguage?: string } } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === PAGE_REQUEST_KIND &&
    (v.type === 'page/videoInfo' || v.type === 'page/capture')
  );
}

function collectScriptTexts(): string[] {
  const texts: string[] = [];
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent;
    if (text && text.length > 0) texts.push(text);
  }
  return texts;
}

function videoIdFromUrl(): string | undefined {
  try {
    const url = new URL(location.href);
    if (url.pathname !== '/watch') return undefined;
    return url.searchParams.get('v') ?? undefined;
  } catch {
    return undefined;
  }
}

function readVideoInfoWithFallback(): PageVideoInfoResponse {
  const scripts = collectScriptTexts();
  const video = readVideoInfo(scripts);
  if (video) return { isVideoPage: true, video };
  const videoId = videoIdFromUrl();
  if (!videoId) return { isVideoPage: false, reason: 'not-a-watch-page' };
  const title =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
      ?.textContent?.trim() ||
    document.title.replace(/ - YouTube$/, '').trim() ||
    videoId;
  return {
    isVideoPage: true,
    video: { videoId, title, captionTracks: [] },
  };
}

const panel: TranscriptPanelDom = {
  expandDescription: () => {
    const expand = document.querySelector<HTMLElement>(
      'tp-yt-paper-button#expand, #expand',
    );
    expand?.click();
  },
  clickTranscriptButton: () => {
    const section = document.querySelector(
      'ytd-video-description-transcript-section-renderer',
    );
    const button =
      section?.querySelector('button') ??
      [...document.querySelectorAll('button')].find((candidate) =>
        /show transcript|عرض النص/i.test(candidate.textContent ?? ''),
      );
    if (!button) return false;
    button.click();
    return true;
  },
  readRenderedSegments: (): RawSegment[] => {
    const segments: RawSegment[] = [];
    for (const node of document.querySelectorAll('ytd-transcript-segment-renderer')) {
      const timestamp = node
        .querySelector('.segment-timestamp')
        ?.textContent?.trim();
      const text = node.querySelector('.segment-text')?.textContent?.trim();
      const startMs = timestamp ? parseTimestampToMs(timestamp) : undefined;
      if (startMs === undefined || !text) continue;
      segments.push({ startMs, endMs: startMs, text });
    }
    return segments;
  },
};

async function handleCapture(payload?: {
  preferredLanguage?: string;
}): Promise<PageCaptureResponse> {
  const deps: CaptureDeps = {
    scriptTexts: collectScriptTexts(),
    fetchImpl: (input, init) => fetch(input, init),
    panel,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    preferredLanguage: payload?.preferredLanguage,
  };
  const outcome = await runCapture(deps);
  if (outcome.ok) {
    const response: PageCaptureResponse = {
      ok: true,
      via: outcome.via,
      segments: outcome.segments,
      video: outcome.video,
    };
    if (outcome.language !== undefined) response.language = outcome.language;
    return response;
  }
  const response: PageCaptureResponse = { ok: false, reason: outcome.reason };
  if (outcome.video) response.video = outcome.video;
  return response;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isPageRequest(message)) return false;
      const handle = async (): Promise<unknown> => {
        if (message.type === 'page/videoInfo') {
          return readVideoInfoWithFallback();
        }
        return handleCapture(message.payload);
      };
      handle()
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            ok: false,
            reason: 'capture-failed',
            error: AppError.wrap(err).toJSON(),
          });
        });
      return true; // async response
    });
  },
});
