import type { MessageKey } from '../core/i18n';

export type Tr = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

export type RunAction = (key: string, fn: () => Promise<void>) => Promise<void>;

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatTimestamp(ms: number): string {
  return formatDuration(ms);
}
