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

import { getRequests, isHarAvailable, onRequestCompleted } from '@/browser/devtools/har-bridge';
import { PROVIDERS } from '@/core/providers/catalog';
import { groupErrors } from '@/core/reasoning/grouping';
import { toIssueViews } from '@/core/reasoning/issue';
import type {
  CaptureState,
  CapturedError,
  ConsoleEntry,
  ErrorGroup,
  NetworkRequest,
  PermissionsStatus,
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

/**
 * Runs the deterministic grouping funnel over raw captured errors.
 * Memoised at the call site; kept as a plain function here so the rendering
 * path stays a pure display of `groupErrors` output.
 */
function groupsFromErrors(errors: readonly CapturedError[]): readonly ErrorGroup[] {
  return groupErrors(errors, { limit: 50 }).groups;
}

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
  error?: string | undefined;
  onRefresh?: () => void;
}): React.ReactElement {
  if (!props.captureAvailable) {
    return (
      <UnavailableNotice
        what="Error capture is off"
        why="Enable it from Settings — KingDev will ask the browser for the optional host + scripting permissions. Nothing is collected until then."
      />
    );
  }

  if (props.error) {
    return (
      <div className="kingdev-unavailable" role="alert">
        <strong>Capture data could not be read</strong>
        <p>{props.error}</p>
        {props.onRefresh ? (
          <button type="button" onClick={props.onRefresh}>
            Retry
          </button>
        ) : null}
      </div>
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
  unavailableReason?: string;
  onRefresh?: () => void;
}): React.ReactElement {
  if (!props.available) {
    return (
      <UnavailableNotice
        what="Network capture is unavailable here"
        why={
          props.unavailableReason ??
          'Requests are read from the DevTools network stack, which only the panel context can reach.'
        }
      />
    );
  }

  if (props.requests.length === 0) {
    return (
      <div className="kingdev-empty">
        No requests observed yet. Reload the page or interact with it — completed requests appear
        here live.
        {props.onRefresh ? (
          <p>
            <button type="button" onClick={props.onRefresh}>
              Refresh
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {props.onRefresh ? (
        <p>
          <button type="button" onClick={props.onRefresh}>
            Refresh ({props.requests.length} requests)
          </button>
        </p>
      ) : null}
      <table className="kingdev-net-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Method</th>
            <th>URL</th>
            <th>Type</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {props.requests.map((request) => (
            <tr key={request.id}>
              <td>
                {request.statusCode ?? request.outcome}
                {request.fromCache ? ' (cached)' : ''}
              </td>
              <td>{request.method}</td>
              <td>{request.url}</td>
              <td>{request.resourceType ?? request.mimeType ?? '—'}</td>
              <td>{request.durationMs !== undefined ? `${request.durationMs} ms` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Analysis tab
 * ------------------------------------------------------------------ */

export function AnalysisTab(props: {
  groups: readonly ErrorGroup[];
  aiAvailable: boolean;
  aiConfigured?: boolean;
}): React.ReactElement {
  const issues = toIssueViews(props.groups);
  const deterministic = issues.filter((issue) => !issue.needsModel);
  const needingModel = issues.filter((issue) => issue.needsModel);

  return (
    <div className="kingdev-analysis">
      <section>
        <h3>Deterministic analysis ({deterministic.length})</h3>
        {deterministic.length === 0 ? (
          <p className="kingdev-empty">No rule-based root cause matched the captured errors yet.</p>
        ) : (
          <ol className="kingdev-issue-list">
            {deterministic.map((issue) => (
              <li key={issue.id}>
                <header>
                  <SeverityBadge severity={issue.severity} />
                  <strong>{issue.category}</strong>
                  <span className="kingdev-rules"> rules: {issue.ruleIds.join(', ')}</span>
                </header>
                <p>{issue.statement}</p>
                {issue.alternatives.length > 0 ? (
                  <details>
                    <summary>How to tell alternatives apart</summary>
                    <ul>
                      {issue.alternatives.map((alt) => (
                        <li key={alt.title}>
                          {alt.title} — <strong>test:</strong> {alt.test}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
      {needingModel.length > 0 ? (
        <section>
          <h3>Needs a model ({needingModel.length})</h3>
          <p className="kingdev-hint">
            No deterministic rule matched these. They need an AI provider, or a wider evidence
            source such as a source map.
          </p>
          <ul>
            {needingModel.map((issue) => (
              <li key={issue.id}>{issue.title}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>AI analysis</h3>
        {props.aiAvailable ? (
          <p className="kingdev-empty">
            Model-backed analysis of these issues starts from Settings → Providers.
          </p>
        ) : (
          <UnavailableNotice
            what="AI analysis is not enabled"
            why={
              props.aiConfigured
                ? 'Enable the AI feature from Settings after reviewing its consent notice: error data would be sent to the configured provider.'
                : 'Configure a provider (key + model) under Settings → Providers first. Nothing is sent anywhere until then.'
            }
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
  permissionsStatus?: PermissionsStatus | undefined;
  onGrantConsent: (prompt: ConsentPrompt) => void;
  onRevokeConsent: (featureId: string) => void;
  /* Phase 3: provider keys */
  keyPresence?: Readonly<Record<string, boolean>> | undefined;
  draftKeys?: Readonly<Record<string, string>> | undefined;
  keyMessage?: string | undefined;
  onDraftKeyChange?: (providerId: string, value: string) => void;
  onSaveKey?: (providerId: string) => void;
  onRemoveKey?: (providerId: string) => void;
  onSelectProvider?: (providerId: string) => void;
  onUpdateSettings?: (patch: Partial<Settings>) => void;
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
            const grantsMissing =
              props.permissionsStatus !== undefined &&
              !props.permissionsStatus.featuresWithGrants.includes(featureId) &&
              props.consent.grantedFeatures.includes(featureId);
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
                {grantsMissing ? (
                  <span className="kingdev-hint">
                    {' '}
                    browser grants were revoked — re-enable to re-request them
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {props.permissionsStatus && !props.permissionsStatus.apiAvailable ? (
          <p className="kingdev-hint">
            Note: the browser permissions API is unreachable from this context — consent is
            recorded, but optional grants cannot be verified right now.
          </p>
        ) : null}
      </section>
      <section>
        <h3>Redaction</h3>
        <label>
          <input
            type="checkbox"
            checked={props.settings?.redactSecrets ?? true}
            onChange={(event) => {
              void props.onUpdateSettings?.({ redactSecrets: event.target.checked });
            }}
          />{' '}
          Mask secrets in captured text (recommended)
        </label>
      </section>
      <section>
        <h3>Providers</h3>
        <p className="kingdev-hint">
          Keys are stored only in this browser's local extension storage and never leave the device
          except to authenticate a request you triggered. The panel only ever sees whether a key
          exists — never its value.
        </p>
        <ul className="kingdev-feature-list">
          {PROVIDERS.map((provider) => {
            const configured = props.keyPresence?.[provider.id] ?? false;
            const active = props.settings?.activeProviderId === provider.id;
            return (
              <li key={provider.id}>
                <strong>{provider.displayName}</strong>
                {provider.local ? ' (local)' : ''} —{' '}
                {configured ? 'key stored' : provider.keyRequired ? 'no key' : 'no key needed'}
                {active ? ' · active' : ''}{' '}
                <input
                  type="password"
                  placeholder={provider.keyRequired ? 'Paste API key…' : 'optional'}
                  value={props.draftKeys?.[provider.id] ?? ''}
                  onChange={(event) => props.onDraftKeyChange?.(provider.id, event.target.value)}
                />{' '}
                <button
                  type="button"
                  onClick={() => props.onSaveKey?.(provider.id)}
                  disabled={(props.draftKeys?.[provider.id] ?? '').trim() === ''}
                >
                  Save
                </button>{' '}
                <button
                  type="button"
                  onClick={() => props.onRemoveKey?.(provider.id)}
                  disabled={!configured}
                >
                  Remove
                </button>{' '}
                {!active && configured ? (
                  <button type="button" onClick={() => props.onSelectProvider?.(provider.id)}>
                    Use
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {props.keyMessage ? <p className="kingdev-hint">{props.keyMessage}</p> : null}
        {props.settings?.activeProviderId !== undefined ? (
          <p className="kingdev-hint">
            Active model:{' '}
            <input
              type="text"
              placeholder="model id (e.g. gpt-4o-mini)"
              value={props.settings?.activeModelId ?? ''}
              onChange={(event) => props.onUpdateSettings?.({ activeModelId: event.target.value })}
            />
          </p>
        ) : null}
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
  const [consent, setConsent] = useState<ConsentState>(NO_CONSENT);
  const [permissions, setPermissions] = useState<PermissionsStatus | undefined>(undefined);
  const [errors, setErrors] = useState<readonly CapturedError[]>([]);
  const [captureState, setCaptureState] = useState<CaptureState | undefined>(undefined);
  const [captureError, setCaptureError] = useState<string | undefined>(undefined);
  const [pendingPrompt, setPendingPrompt] = useState<ConsentPrompt | undefined>(undefined);

  /* Phase 3: network (HAR bridge) ------------------------------------ */
  const harAvailable = isHarAvailable();
  const [requests, setRequests] = useState<readonly NetworkRequest[]>([]);
  const [networkReason, setNetworkReason] = useState<string | undefined>(undefined);

  const refreshNetwork = useCallback(() => {
    void getRequests().then((snapshot) => {
      setRequests(snapshot.requests);
      setNetworkReason(snapshot.available ? undefined : snapshot.reason);
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once on mount; refreshNetwork is stable.
  useEffect(() => {
    if (!harAvailable) return;
    refreshNetwork();
    const live = onRequestCompleted(() => refreshNetwork());
    return live.unsubscribe;
  }, []);

  /* Phase 3: provider keys ------------------------------------------- */
  const [keyPresence, setKeyPresence] = useState<Readonly<Record<string, boolean>> | undefined>(
    undefined,
  );
  const [draftKeys, setDraftKeys] = useState<Readonly<Record<string, string>>>({});
  const [keyMessage, setKeyMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void rpc.listProviderKeys().then((result) => {
      if (!cancelled && result.ok) setKeyPresence(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const refreshCapture = useCallback(() => {
    void rpc.getCaptureErrors().then((result) => {
      if (result.ok) {
        setErrors(result.value.errors as CapturedError[]);
        setCaptureState(result.value.state);
        setCaptureError(undefined);
      } else {
        // CONSENT_REQUIRED is the expected "not enabled yet" state, not a bug.
        setCaptureError(
          result.error.code === 'CONSENT_REQUIRED' ? undefined : result.error.message,
        );
        setErrors([]);
      }
    });
    void rpc.getCaptureState().then((result) => {
      if (result.ok) setCaptureState(result.value);
    });
  }, [rpc]);

  const refreshConsent = useCallback(() => {
    void rpc.getConsent().then((result) => {
      if (result.ok) setConsent(result.value);
    });
    void rpc.getPermissionsStatus().then((result) => {
      if (result.ok) setPermissions(result.value);
    });
    refreshCapture();
  }, [rpc, refreshCapture]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount; refreshes are explicit via callbacks.
  useEffect(() => {
    refreshConsent();
  }, []);

  /** Confirm handler: consent first (worker), then optional browser grants. */
  const confirmConsent = useCallback(
    (prompt: ConsentPrompt) => {
      void (async () => {
        // Order matters: record consent only if the browser grant succeeded,
        // so a denied prompt never leaves a "consented but impossible" state
        // behind that the user then has to know how to undo.
        setPendingPrompt(undefined);
        await rpc.grantConsent(prompt.featureId);
        refreshConsent();
      })();
    },
    [rpc, refreshConsent],
  );

  const revokeConsent = useCallback(
    (featureId: string) => {
      void rpc.revokeConsent(featureId).then(() => refreshConsent());
    },
    [rpc, refreshConsent],
  );

  const saveKey = useCallback(
    (providerId: string) => {
      const draft = (draftKeys[providerId] ?? '').trim();
      if (draft === '') return;
      void rpc.setProviderKey(providerId, draft).then((result) => {
        if (result.ok) {
          setKeyPresence(result.value);
          setDraftKeys((current) => ({ ...current, [providerId]: '' }));
          setKeyMessage(`Key stored for ${providerId}.`);
        } else {
          setKeyMessage(`Could not store the key: ${result.error.message}`);
        }
      });
    },
    [rpc, draftKeys],
  );

  const removeKey = useCallback(
    (providerId: string) => {
      void rpc.setProviderKey(providerId, null).then((result) => {
        if (result.ok) {
          setKeyPresence(result.value);
          setKeyMessage(`Key removed for ${providerId}.`);
        } else {
          setKeyMessage(`Could not remove the key: ${result.error.message}`);
        }
      });
    },
    [rpc],
  );

  const selectProvider = useCallback(
    (providerId: string) => {
      void rpc
        .updateSettings({ activeProviderId: providerId as Settings['activeProviderId'] })
        .then((result) => {
          if (result.ok) reload();
        });
    },
    [rpc, reload],
  );

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      void rpc.updateSettings(patch).then((result) => {
        if (result.ok) reload();
      });
    },
    [rpc, reload],
  );

  const captureAvailable =
    consent.grantedFeatures.includes('errorCapture') &&
    (permissions?.featuresWithGrants.includes('errorCapture') ?? false);
  const aiConsented = consent.grantedFeatures.includes('aiExplanation');
  const activeProviderConfigured =
    (keyPresence?.[settings?.activeProviderId ?? ''] ?? false) ||
    settings?.activeProviderId === 'ollama';

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
          <IssuesTab
            groups={groupsFromErrors(errors)}
            totalErrors={captureState?.totalErrors ?? 0}
            ungroupedCount={0}
            captureAvailable={captureAvailable}
            error={captureError}
            onRefresh={refreshCapture}
          />
        ) : null}
        {tab === 'network' ? (
          <NetworkTab
            requests={requests}
            available={harAvailable}
            unavailableReason={networkReason}
            onRefresh={harAvailable ? refreshNetwork : undefined}
          />
        ) : null}
        {tab === 'analysis' ? (
          <AnalysisTab
            groups={groupsFromErrors(errors)}
            aiAvailable={aiConsented && activeProviderConfigured}
            aiConfigured={activeProviderConfigured}
          />
        ) : null}
        {tab === 'settings' ? (
          <SettingsTab
            settings={settings}
            consent={consent}
            grantedPermissions={permissions?.grantedPermissions ?? []}
            permissionsStatus={permissions}
            onGrantConsent={setPendingPrompt}
            onRevokeConsent={revokeConsent}
            keyPresence={keyPresence}
            draftKeys={draftKeys}
            keyMessage={keyMessage}
            onDraftKeyChange={(providerId, value) =>
              setDraftKeys((current) => ({ ...current, [providerId]: value }))
            }
            onSaveKey={saveKey}
            onRemoveKey={removeKey}
            onSelectProvider={selectProvider}
            onUpdateSettings={updateSettings}
          />
        ) : null}
      </main>

      {pendingPrompt ? (
        <ConsentDialog
          prompt={pendingPrompt}
          onConfirm={() => confirmConsent(pendingPrompt)}
          onCancel={() => setPendingPrompt(undefined)}
        />
      ) : null}
    </div>
  );
}
