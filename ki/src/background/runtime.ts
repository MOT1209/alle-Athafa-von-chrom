import { ChromeStore } from '../storage/kv';
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type Settings,
} from '../storage/settings';
import { TaskQueue, type QueueEvents, type TaskView } from '../ai/queue';
import { assessModelFit, buildBudget } from '../ai/memory';
import { OllamaProvider } from '../ai/providers/ollama';
import { RuntimeManager } from '../runtime/manager';
import { createRouter } from '../messaging/router';
import {
  EVENTS_PORT_NAME,
  isRequestEnvelope,
  type BackgroundEvent,
} from '../messaging/protocol';
import { Emitter } from '../core/events';
import { ConsentStore } from '../capture/consent';
import { VideoRepository } from '../capture/videos';
import { CaptureService } from '../capture/service';
import { SummaryRepository } from '../summary/repository';
import { SummaryService } from '../summary/service';
import { ChromeTabBridge } from '../browser/tabs';

/**
 * Background service-worker composition root. Thin wiring only: all logic
 * lives in testable modules (queue, manager, providers, storage).
 *
 * MV3 lifetime notes:
 *  - Queue views persist to chrome.storage.session; after an SW restart they
 *    are restored as honest "interrupted" failures (never fake resumption).
 *  - While tasks are pending, a 30s alarm keeps the worker alive; it is
 *    cleared when the queue drains.
 */

const QUEUE_KEY = 'videoking.queue.v1';
const KEEPALIVE_ALARM = 'videoking-keepalive';

export function bootstrapBackground(): void {
  const localStore = new ChromeStore(chrome.storage.local);
  const sessionStore = new ChromeStore(chrome.storage.session);
  const settingsStore = new SettingsStore(localStore);
  const events = new Emitter<QueueEvents>();

  let cachedSettings: Settings = structuredClone(DEFAULT_SETTINGS);

  const ports = new Set<chrome.runtime.Port>();
  const broadcast = (event: BackgroundEvent): void => {
    for (const port of [...ports]) {
      try {
        port.postMessage(event);
      } catch {
        ports.delete(port);
      }
    }
  };

  const manageKeepalive = (views: TaskView[]): void => {
    const busy = views.some(
      (view) => view.status === 'queued' || view.status === 'running',
    );
    if (busy) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    } else {
      void chrome.alarms.clear(KEEPALIVE_ALARM);
    }
  };

  const queue = new TaskQueue({
    events,
    maxQueueSize: cachedSettings.queue.maxQueueSize,
    maxRetries: cachedSettings.queue.maxRetries,
    retryBaseDelayMs: cachedSettings.queue.retryBaseDelayMs,
    memoryGate: (spec) => {
      if (spec.estimatedSizeBytes === undefined) return { allowed: true };
      const budget = buildBudget(cachedSettings.memory.reserveMb);
      const fit = assessModelFit(
        spec.estimatedSizeBytes,
        budget,
        cachedSettings.memory.enforceBudget,
      );
      if (fit.verdict === 'block') {
        return { allowed: false, reason: fit.reason };
      }
      return { allowed: true };
    },
    onChange: (views) => {
      manageKeepalive(views);
      void sessionStore.set(QUEUE_KEY, views).catch(() => {
        // Session storage is best-effort; the queue still works in memory.
      });
    },
  });

  const makeProvider = (settings: Settings): OllamaProvider =>
    new OllamaProvider({
      baseUrl: settings.ollama.baseUrl,
      requestTimeoutMs: settings.ollama.requestTimeoutMs,
      defaultModel: settings.generation.model,
    });

  const manager = new RuntimeManager({
    settings: settingsStore,
    queue,
    makeProvider,
  });

  const consentStore = new ConsentStore(localStore);
  const videoRepository = new VideoRepository(localStore);
  const captureService = new CaptureService({
    consent: consentStore,
    videos: videoRepository,
    tabs: new ChromeTabBridge(),
  });
  const summaryRepository = new SummaryRepository(localStore);
  const summaryService = new SummaryService({
    settings: settingsStore,
    videos: videoRepository,
    summaries: summaryRepository,
    queue,
    makeProvider,
  });

  const applySettings = (settings: Settings): void => {
    cachedSettings = settings;
    queue.configure({
      maxQueueSize: settings.queue.maxQueueSize,
      maxRetries: settings.queue.maxRetries,
      retryBaseDelayMs: settings.queue.retryBaseDelayMs,
    });
    broadcast({ type: 'settings', settings });
  };

  // Load persisted settings + restore queue history (SW may have restarted).
  void settingsStore
    .load()
    .then((settings) => {
      cachedSettings = settings;
      queue.configure({
        maxQueueSize: settings.queue.maxQueueSize,
        maxRetries: settings.queue.maxRetries,
        retryBaseDelayMs: settings.queue.retryBaseDelayMs,
      });
    })
    .catch(() => {
      // Defaults already applied; storage errors surface on next request.
    });
  void sessionStore
    .get<TaskView[]>(QUEUE_KEY)
    .then((views) => {
      if (Array.isArray(views) && views.length > 0) queue.restore(views);
    })
    .catch(() => {
      // No history to restore.
    });

  const router = createRouter({
    'settings/get': () => settingsStore.load(),
    'settings/update': async (patch) => {
      const next = await settingsStore.update(patch);
      applySettings(next);
      return next;
    },
    'settings/reset': async () => {
      const next = await settingsStore.reset();
      applySettings(next);
      return next;
    },
    'runtime/status': () => manager.status(),
    'runtime/testConnection': () => manager.testConnection(),
    'runtime/testModel': (payload) => manager.testModel(payload.model),
    'runtime/pullModel': (payload) => manager.pullModel(payload.model),
    'runtime/deleteModel': (payload) => manager.deleteModel(payload.model),
    'queue/list': () => queue.list(),
    'queue/cancel': (payload) => ({
      cancelled: queue.cancel(payload.taskId),
    }),
    'queue/retry': (payload) => queue.retry(payload.taskId),
    'consent/get': () => consentStore.get(),
    'consent/grant': (payload) => consentStore.grant(payload.scope),
    'consent/revoke': (payload) => consentStore.revoke(payload.scope),
    'youtube/activeVideo': () => captureService.activeVideo(),
    'youtube/capture': (payload) =>
      captureService.capture(payload.tabId, payload.preferredLanguage),
    'videos/list': () => videoRepository.list(),
    'videos/get': async (payload) => ({
      record: (await videoRepository.get(payload.id)) ?? null,
    }),
    'videos/remove': async (payload) => {
      await summaryService.removeForVideo(payload.id);
      return {
        removed: await videoRepository.remove(payload.id),
      };
    },
    'summaries/generate': (payload) =>
      summaryService.generate(payload.videoRecordId),
    'summaries/list': () => summaryService.list(),
    'summaries/get': async (payload) => ({
      record: (await summaryService.get(payload.videoRecordId)) ?? null,
    }),
    'summaries/remove': (payload) =>
      summaryService.remove(payload.videoRecordId),
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRequestEnvelope(message)) return false;
    void router(message).then((response) => {
      if (response) sendResponse(response);
    });
    return true; // async response
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== EVENTS_PORT_NAME) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    // Immediate snapshot so a freshly opened popup is never blank.
    try {
      port.postMessage({ type: 'queue', tasks: queue.list() });
    } catch {
      ports.delete(port);
    }
  });

  events.on('queue-changed', (tasks) => broadcast({ type: 'queue', tasks }));
  events.on('task-progress', ({ taskId, progress }) =>
    broadcast({ type: 'task-progress', taskId, progress }),
  );

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    // Touch session storage so the worker stays alive while tasks run.
    void sessionStore.set('videoking.lastAlive', Date.now()).catch(() => {});
    if (!queue.isBusy()) void chrome.alarms.clear(KEEPALIVE_ALARM);
  });
}
