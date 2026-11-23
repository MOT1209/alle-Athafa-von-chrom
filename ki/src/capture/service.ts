import { AppError } from '../core/errors';
import type { ConsentStore } from './consent';
import { isGranted } from './consent';
import {
  videoIdFor,
  type VideoRecord,
  type VideoRepository,
  type VideoSummary,
} from './videos';
import type { YouTubeVideoInfo } from '../youtube/extract';
import type { RawSegment } from '../youtube/transcript';
import { segmentsToTranscript } from '../youtube/transcript';

/**
 * Background-side capture orchestration. The consent gate runs BEFORE any
 * page interaction that reads caption data (fail-closed). Page access goes
 * through an injected TabBridge so the service is unit-testable.
 */

export interface PageVideoInfoResponse {
  isVideoPage: boolean;
  video?: YouTubeVideoInfo;
  reason?: string;
}

export interface PageCaptureResponse {
  ok: boolean;
  via?: 'api' | 'direct' | 'ui';
  segments?: RawSegment[];
  language?: string;
  video?: YouTubeVideoInfo;
  reason?: 'not-a-video' | 'no-captions' | 'capture-failed';
}

export type PageRequest =
  | { kind: 'videoking/page-request'; type: 'page/videoInfo'; payload: undefined }
  | {
      kind: 'videoking/page-request';
      type: 'page/capture';
      payload: { preferredLanguage?: string };
    };

export interface TabBridge {
  getActiveTabId(): Promise<number | undefined>;
  sendToTab(tabId: number, request: PageRequest, timeoutMs: number): Promise<unknown>;
}

export type ActiveVideoResult =
  | { supported: true; tabId: number; video: YouTubeVideoInfo }
  | { supported: false; reason: 'no-active-tab' | 'not-a-youtube-video' };

export interface CaptureServiceDeps {
  consent: ConsentStore;
  videos: VideoRepository;
  tabs: TabBridge;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CaptureService {
  private consent: ConsentStore;
  private videos: VideoRepository;
  private tabs: TabBridge;
  private now: () => number;

  constructor(deps: CaptureServiceDeps) {
    this.consent = deps.consent;
    this.videos = deps.videos;
    this.tabs = deps.tabs;
    this.now = deps.now ?? Date.now;
  }

  async activeVideo(): Promise<ActiveVideoResult> {
    const tabId = await this.tabs.getActiveTabId();
    if (tabId === undefined) {
      return { supported: false, reason: 'no-active-tab' };
    }
    let response: unknown;
    try {
      response = await this.tabs.sendToTab(
        tabId,
        { kind: 'videoking/page-request', type: 'page/videoInfo', payload: undefined },
        10_000,
      );
    } catch {
      return { supported: false, reason: 'not-a-youtube-video' };
    }
    if (!isRecord(response) || response.isVideoPage !== true || !isRecord(response.video)) {
      return { supported: false, reason: 'not-a-youtube-video' };
    }
    const video = response.video as unknown as YouTubeVideoInfo;
    if (typeof video.videoId !== 'string' || !Array.isArray(video.captionTracks)) {
      return { supported: false, reason: 'not-a-youtube-video' };
    }
    return { supported: true, tabId, video };
  }

  async capture(tabId: number, preferredLanguage?: string): Promise<{ record: VideoSummary }> {
    // Consent gate FIRST — before any caption data is read from the page.
    const consent = await this.consent.get();
    if (!isGranted(consent, 'youtubeCaptions')) {
      throw new AppError(
        'CONSENT_REQUIRED',
        'Caption capture requires your explicit consent',
        { hint: 'Grant consent in the Video tab, then capture again.' },
      );
    }
    if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
      throw new AppError('INVALID_INPUT', 'A valid tabId is required');
    }

    let response: unknown;
    try {
      response = await this.tabs.sendToTab(
        tabId,
        {
          kind: 'videoking/page-request',
          type: 'page/capture',
          payload: preferredLanguage ? { preferredLanguage } : {},
        },
        60_000,
      );
    } catch (err) {
      throw AppError.wrap(err, 'PAGE_UNREACHABLE');
    }

    const outcome = response as PageCaptureResponse;
    if (!isRecord(outcome)) {
      throw new AppError('BAD_RESPONSE', 'Invalid capture response from page');
    }
    if (outcome.ok !== true) {
      if (outcome.reason === 'no-captions') {
        throw new AppError(
          'CAPTURE_UNAVAILABLE',
          'This video has no accessible captions',
          {
            hint: 'Audio transcription for caption-less videos arrives in Phase 7 (Whisper, local).',
          },
        );
      }
      throw new AppError(
        'CAPTURE_UNAVAILABLE',
        'Could not capture the transcript from this page',
        {
          hint: 'YouTube may be limiting automated access in this session. Try again in a normal browser window, or use a video with captions enabled.',
        },
      );
    }
    if (!Array.isArray(outcome.segments) || !isRecord(outcome.video)) {
      throw new AppError('BAD_RESPONSE', 'Capture response missing segments/video');
    }
    const video = outcome.video as unknown as YouTubeVideoInfo;
    const segments = outcome.segments.filter(
      (segment): segment is RawSegment =>
        isRecord(segment) &&
        typeof segment.startMs === 'number' &&
        typeof segment.endMs === 'number' &&
        typeof segment.text === 'string' &&
        segment.text.length > 0,
    );
    if (segments.length === 0) {
      throw new AppError('BAD_RESPONSE', 'Capture returned zero valid segments');
    }

    const language =
      typeof outcome.language === 'string' ? outcome.language : undefined;
    const transcript = segmentsToTranscript(segments, language);
    const record: VideoRecord = {
      id: videoIdFor(video.videoId),
      platform: 'youtube',
      videoId: video.videoId,
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      title: video.title || video.videoId,
      segmentCount: transcript.segments.length,
      capturedAt: this.now(),
      transcript,
    };
    if (video.channel !== undefined) record.channel = video.channel;
    if (video.durationMs !== undefined) record.durationMs = video.durationMs;
    if (language !== undefined) record.language = language;
    const bestKind = video.captionTracks[0]?.kind;
    if (bestKind) record.captionKind = bestKind;

    const summary = await this.videos.save(record, this.now());
    return { record: summary };
  }
}
