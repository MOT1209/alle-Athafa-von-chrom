import type { ReactNode } from 'react';
import type { SerializedError } from '../core/errors';

export function Section(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {props.title}
        </h2>
        {props.action}
      </header>
      {props.children}
    </section>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: 'default' | 'primary' | 'danger';
  title?: string;
}) {
  const variant = props.variant ?? 'default';
  const palette =
    variant === 'primary'
      ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
      : variant === 'danger'
        ? 'bg-rose-800/80 hover:bg-rose-700 text-rose-50'
        : 'bg-slate-800 hover:bg-slate-700 text-slate-200';
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${palette}`}
    >
      {props.busy ? '…' : props.children}
    </button>
  );
}

export function StatusDot(props: { state: 'ok' | 'bad' | 'unknown' }) {
  const color =
    props.state === 'ok'
      ? 'bg-emerald-400'
      : props.state === 'bad'
        ? 'bg-rose-500'
        : 'bg-slate-500';
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
}

export function ProgressBar(props: { percent?: number }) {
  const percent = props.percent;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      {percent === undefined ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-500" />
      ) : (
        <div
          className="h-full rounded-full bg-indigo-500 transition-all"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      )}
    </div>
  );
}

export function ErrorNote(props: {
  error: SerializedError;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="rounded-md border border-rose-900/70 bg-rose-950/50 p-2 text-xs text-rose-200">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">
          <span className="mr-1 rounded bg-rose-900/80 px-1 py-0.5 font-mono text-[10px]">
            {props.error.code}
          </span>
          {props.error.message}
        </p>
        {props.onClose && (
          <button
            type="button"
            onClick={props.onClose}
            className="shrink-0 text-rose-300 hover:text-white"
          >
            {props.closeLabel ?? '✕'}
          </button>
        )}
      </div>
      {props.error.hint && (
        <p className="mt-1 text-rose-300/90">{props.error.hint}</p>
      )}
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-slate-300">
      <span className="mb-1 block text-[11px] text-slate-400">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500';

export function Badge(props: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info' }) {
  const tone = props.tone ?? 'info';
  const palette =
    tone === 'ok'
      ? 'bg-emerald-900/70 text-emerald-300'
      : tone === 'warn'
        ? 'bg-amber-900/70 text-amber-300'
        : tone === 'bad'
          ? 'bg-rose-900/70 text-rose-300'
          : 'bg-slate-800 text-slate-300';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${palette}`}>
      {props.children}
    </span>
  );
}
