/**
 * Panel UI shell (plan Phase 1) — tabbed navigation.
 *
 * Phase 1 delivers the skeleton: a tab bar, per-tab status surfaces, and the
 * consent dialog contract the Phase 2 wiring will hang off. Reasoning modules
 * from `src/core/reasoning` are rendered where evidence exists and are shown as
 * explicit `unavailable` where the data source has not been wired yet — no
 * invented content, per plan principle 1.
 *
 * Tabs:
 *   - Issues      : grouped errors (from content capture, via the worker)
 *   - Network     : HAR-derived requests (devtools-only context)
 *   - Analysis    : deterministic root causes + AI analysis (opt-in)
 *   - Settings    : provider, redaction, and permission/consent controls
 */

import type {
  CapturedError,
  ConsoleEntry,
  ErrorGroup,
  NetworkRequest,
  Settings,
} from '@/core/types';
import {
  type ConsentPrompt,
  type ConsentState,
  NO_CONSENT,
  consentPromptFor,
  evaluateFeatureAccess,
} from '@/security/permissions';
import { useCallback, useEffect, useState } from 'react';
import { WorkerRpc } from './rpc';

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

export type PanelTabId = 'issues' | 'network' | 'analysis' | 'settings';

export const PANEL_TABS: readonly { id: PanelTabId; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'network', label: 'Network' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'settings', label: 'Settings' },
];

/* ------------------------------------------------------------------ *
 * Shared UI atoms
 * ------------------------------------------------------------------ */

function UnavailableNotice(props: { what: string; why: string }): React.ReactElement {
  return (
    <div className="kingdev-unavailable">
      <strong>{props.what}</strong>
      <p>{props.why}</p>
    </div>
  );
}

function SeverityBadge(props: { severity: string }): React.ReactElement {
  return <span className={`kingdev-badge kingdev-sev-${props.severity}`}>{props.severity}</span>;
}

/* ------------------------------------------------------------------ *
 * Issues tab
 * ------------------------------------------------------------------ */

export function IssuesTab(props: {
  groups: readonly ErrorGroup[];
  totalErrors: number;
  ungroupedCount: number;
  captureAvailable: boolean;
}): React.ReactElement {
  if (!props.captureAvailable) {
    return (
      <UnavailableNotice
        what="Error capture is off"
        why="Grant the optional host + scripting permissions from Settings to capture page errors. Nothing has been collected."
      />
    );
  }

  if (props.groups.length === 0) {
    return (
      <div className="kingdev-empty">
        No errors captured on this page yet. The capture script reports <code>error</code>,{' '}
        <code>unhandledrejection</code> and resource failures as they happen.
      </div>
    );
  }

  return (
    <div className="kingdev-issues">
      <p className="kingdev-summary">
        {props.totalErrors} error occurrence(s) in {props.groups.length} group(s)
        {props.ungroupedCount > 0 ? `, ${props.ungroupedCount} ungrouped` : ''}.
      </p>
      <ol className="kingdev-issue-list">
        {props.groups.map((group) => (
          <li key={group.id} className="kingdev-issue">
            <header>
              <SeverityBadge severity={group.severity} />
              <span className="kingdev-issue-title">{group.title}</span>
            </header>
            <p className="kingdev-issue-cause">
              {group.rootCause.statement}
              {group.rootCause.confidence !== 'unknown' ? (
                <em> ({group.rootCause.confidence} confidence)</em>
              ) : null}
            </p>
            {group.rootCause.alternatives.length > 0 ? (
              <details className="kingdev-issue-alternatives">
                <summary>{group.rootCause.alternatives.length} alternative cause(s)</summary>
                <ul>
                  {group.rootCause.alternatives.map((alt) => (
                    <li key={alt.statement}>
                      {alt.statement} — <strong>test:</strong> {alt.discriminatingTest}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Network tab
 * ------------------------------------------------------------------ */

export function NetworkTab(props: {
  requests: readonly NetworkRequest[];
  available: boolean;
}): React.ReactElement {
  if (!props.available) {
    return (
      <UnavailableNotice
        what="Network capture is unavailable"
        why="Requests are read from the DevTools network stack of the inspected page. This build has not wired the HAR bridge yet (plan Phase 3)."
      />
    );
  }

  return (
    <table className="kingdev-net-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Method</th>
          <th>URL</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        {props.requests.map((request) => (
          <tr key={request.id}>
            <td>{request.statusCode ?? request.outcome}</td>
            <td>{request.method}</td>
            <td>{request.url}</td>
            <td>{request.durationMs !== undefined ? `${request.durationMs} ms` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ *
 * Analysis tab
 * ------------------------------------------------------------------ */

export function AnalysisTab(props: {
  groups: readonly ErrorGroup[];
  aiAvailable: boolean;
}): React.ReactElement {
  const deterministic = props.groups.filter((g) => g.rootCause.ruleIds.length > 0);

  return (
    <div className="kingdev-analysis">
      <section>
        <h3>Deterministic analysis</h3>
        {deterministic.length === 0 ? (
          <p className="kingdev-empty">No rule-based root cause matched the captured errors yet.</p>
        ) : (
          <ul>
            {deterministic.map((group) => (
              <li key={group.id}>
                <strong>{group.rootCause.category}</strong> — {group.rootCause.statement}
                {group.rootCause.ruleIds.length > 0 ? (
                  <span className="kingdev-rules">
                    {' '}
                    rules: {group.rootCause.ruleIds.join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>AI analysis</h3>
        {props.aiAvailable ? (
          <p className="kingdev-empty">Provider calls are implemented in plan Phase 3.</p>
        ) : (
          <UnavailableNotice
            what="AI analysis is not enabled"
            why="Enable the AI feature from Settings after reviewing its consent notice: error data would be sent to the configured provider."
          />
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Settings tab
 * ------------------------------------------------------------------ */

export function SettingsTab(props: {
  settings: Settings | undefined;
  consent: ConsentState;
  grantedPermissions: readonly string[];
  onGrantConsent: (prompt: ConsentPrompt) => void;
  onRevokeConsent: (featureId: string) => void;
}): React.ReactElement {
  const features = [
    'errorCapture',
    'networkInspection',
    'deterministicReasoning',
    'aiExplanation',
  ] as const;

  return (
    <div className="kingdev-settings">
      <section>
        <h3>Features &amp; permissions</h3>
        <p className="kingdev-hint">
          Each feature asks separately. Nothing is enabled until you approve it.
        </p>
        <ul className="kingdev-feature-list">
          {features.map((featureId) => {
            const prompt = consentPromptFor(featureId);
            if (!prompt) return null;
            const decision = evaluateFeatureAccess({
              featureId,
              consent: props.consent,
              grantedPermissions: props.grantedPermissions as never[],
            });
            return (
              <li key={featureId}>
                <strong>{prompt.label}</strong>{' '}
                {decision.allowed ? (
                  <button type="button" onClick={() => props.onRevokeConsent(featureId)}>
                    Revoke
                  </button>
                ) : (
                  <button type="button" onClick={() => props.onGrantConsent(prompt)}>
                    Enable…
                  </button>
                )}
                {!decision.allowed && decision.reason !== 'not-consented' ? (
                  <span className="kingdev-hint"> {decision.reason}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h3>Redaction</h3>
        <label>
          <input
            type="checkbox"
            checked={props.settings?.redactSecrets ?? true}
            onChange={(event) => {
              void props.settings;
              // Wired to settings/update in Phase 2 consent wiring.
              void event;
            }}
          />{' '}
          Mask secrets in captured text (recommended)
        </label>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Consent dialog
 * ------------------------------------------------------------------ */

export function ConsentDialog(props: {
  prompt: ConsentPrompt;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <dialog className="kingdev-consent" aria-label="Feature consent" open>
      <h3>Enable “{props.prompt.label}”?</h3>
      {props.prompt.egress ? (
        <p className="kingdev-egress-warning">
          <strong>This feature sends data off this device</strong> to the AI provider you configure.
        </p>
      ) : null}
      <ul>
        {props.prompt.permissions.map((permission) => (
          <li key={permission.id}>
            <strong>{permission.id}</strong> ({permission.risk} risk): {permission.summary}
          </li>
        ))}
      </ul>
      <button type="button" onClick={props.onConfirm}>
        Enable
      </button>{' '}
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </dialog>
  );
}

/* ------------------------------------------------------------------ *
 * App shell
 * ------------------------------------------------------------------ */

export interface PanelAppState {
  readonly tab: PanelTabId;
  readonly settings?: Settings | undefined;
  readonly errors: readonly CapturedError[];
  readonly consoleEntries: readonly ConsoleEntry[];
}

export function usePanelState(rpc: WorkerRpc): {
  settings?: Settings | undefined;
  reload: () => void;
} {
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // `tick` is a re-fetch counter: `reload()` bumps it on purpose to re-arm
  // this effect. Biome's exhaustive-deps cannot see the intent, so the extra
  // dependency is asserted explicitly rather than dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the re-fetch trigger, not a value the effect reads.
  useEffect(() => {
    let cancelled = false;
    void rpc.getSettings().then((result) => {
      if (!cancelled && result.ok) setSettings(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { settings, reload };
}

export function PanelApp(props: { rpc?: WorkerRpc }): React.ReactElement {
  const rpc = props.rpc ?? new WorkerRpc();
  const { settings, reload } = usePanelState(rpc);
  const [tab, setTab] = useState<PanelTabId>('issues');
  const [consent] = useState<ConsentState>(NO_CONSENT);
  const [pendingPrompt, setPendingPrompt] = useState<ConsentPrompt | undefined>(undefined);

  // Phase 1 placeholder data sources: capture wiring lands with Phase 2
  // consent gating, so the tabs render honest empty/unavailable states.
  const errors: readonly CapturedError[] = [];
  const requests: readonly NetworkRequest[] = [];

  return (
    <div className="kingdev-panel">
      <nav className="kingdev-tabs" role="tablist">
        {PANEL_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'kingdev-tab kingdev-tab-active' : 'kingdev-tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="kingdev-tab-body">
        {tab === 'issues' ? (
          <IssuesTab groups={[]} totalErrors={0} ungroupedCount={0} captureAvailable={false} />
        ) : null}
        {tab === 'network' ? <NetworkTab requests={requests} available={false} /> : null}
        {tab === 'analysis' ? (
          <AnalysisTab groups={errors.length > 0 ? [] : []} aiAvailable={false} />
        ) : null}
        {tab === 'settings' ? (
          <SettingsTab
            settings={settings}
            consent={consent}
            grantedPermissions={[]}
            onGrantConsent={setPendingPrompt}
            onRevokeConsent={(featureId) => {
              void featureId;
              reload();
            }}
          />
        ) : null}
      </main>

      {pendingPrompt ? (
        <ConsentDialog
          prompt={pendingPrompt}
          onConfirm={() => {
            setPendingPrompt(undefined);
            reload();
          }}
          onCancel={() => setPendingPrompt(undefined)}
        />
      ) : null}
    </div>
  );
}
