import { AppError } from '../core/errors';
import type { PageRequest, TabBridge } from '../capture/service';

/**
 * chrome.tabs adapter. No "tabs" permission is needed: querying the active
 * tab id works without it, and messaging a tab works through the registered
 * content script. URL/title are never read here — the page reports its own.
 */
export class ChromeTabBridge implements TabBridge {
  async getActiveTabId(): Promise<number | undefined> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id;
    } catch (err) {
      throw AppError.wrap(err, 'INTERNAL');
    }
  }

  async sendToTab(
    tabId: number,
    request: PageRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError('TIMEOUT', `Page did not respond within ${timeoutMs} ms`),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      const wrapped = AppError.wrap(err);
      if (wrapped.code === 'TIMEOUT') throw wrapped;
      throw new AppError(
        'PAGE_UNREACHABLE',
        'No videoKING content script answered in this tab',
        {
          hint: 'Open a YouTube video page (youtube.com/watch?v=…) and try again.',
          cause: err,
        },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
