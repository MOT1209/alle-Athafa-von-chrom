/**
 * Diagnostics page (plan Phase 2).
 *
 * The one surface whose job is to tell the truth about state:
 *   - what the user consented to, and when
 *   - what the browser actually grants right now
 *   - the drift between the two (`reconcilePermissions`) — a silently
 *     downgraded or revoked permission shows up as a difference, not as a
 *     feature that quietly stopped working
 *   - the mirrored log from the service worker's session storage
 *
 * Plain DOM, no React: the options page must render even if the UI bundle
 * fails, because it is the page you debug the failure with.
 */

import type { PermissionsStatus } from '@/core/types';
import {
  type ConsentState,
  FEATURE_IDS,
  MANIFEST_PERMISSIONS,
  reconcilePermissions,
  requiredManifestPermissions,
} from '@/security/permissions';
import { WorkerRpc } from '@/ui/rpc';

const rpc = new WorkerRpc();

interface DiagnosticsView {
  consent: ConsentState;
  status?: PermissionsStatus;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function driftDescription(
  consent: ConsentState,
  status: PermissionsStatus,
): {
  missing: readonly string[];
  surplus: readonly string[];
} {
  // Required set = everything the consented features need; granted set = what
  // the browser reports. Drift in either direction is user-visible here.
  const required = new Set<string>();
  for (const featureId of consent.grantedFeatures) {
    const needed = requiredManifestPermissions([featureId as never]);
    for (const p of needed.permissions) required.add(p);
    for (const p of needed.hostPermissions) required.add(p);
  }

  const grantedLiterals = new Set<string>(status.rawPermissions);
  if (status.rawOrigins.length > 0) grantedLiterals.add('<all_urls>');

  const idToLiteral = (id: string): string =>
    MANIFEST_PERMISSIONS.includes(id) || id === 'scripting' ? id : id;

  const missing: string[] = [];
  for (const id of required) {
    const literal = idToLiteral(id);
    if (
      !grantedLiterals.has(literal) &&
      !(literal === '<all_urls>' && status.rawOrigins.length > 0)
    ) {
      missing.push(id);
    }
  }

  // Surplus: browser-held optional literals no consented feature needs.
  const optionalLiterals = new Set(['scripting', '<all_urls>']);
  const surplus: string[] = [];
  for (const literal of grantedLiterals) {
    if (!optionalLiterals.has(literal)) continue;
    if (!required.has(literal)) surplus.push(literal);
  }

  return { missing, surplus };
}

function render(view: DiagnosticsView, root: HTMLElement): void {
  root.replaceChildren();

  const consentSection = el('section');
  consentSection.append(el('h2', 'Consent'));
  const consentList = el('ul');
  if (view.consent.grantedFeatures.length === 0) {
    consentList.append(el('li', 'No features consented. Everything is off.'));
  } else {
    for (const featureId of view.consent.grantedFeatures) {
      consentList.append(el('li', `${featureId} (recorded ${view.consent.recordedAt})`));
    }
  }
  consentSection.append(consentList, el('p', `Consent version: ${view.consent.version}`));
  root.append(consentSection);

  const permsSection = el('section');
  permsSection.append(el('h2', 'Browser permissions'));
  if (!view.status) {
    permsSection.append(el('p', 'Permissions status unavailable in this context.'));
  } else {
    const grantedList = el('ul');
    for (const id of view.status.grantedPermissions) grantedList.append(el('li', id));
    if (view.status.grantedPermissions.length === 0) {
      grantedList.append(el('li', 'None held.'));
    }
    permsSection.append(grantedList);

    const drift = driftDescription(view.consent, view.status);
    if (drift.missing.length > 0) {
      const warn = el('p');
      warn.textContent = `⚠ Consent needs permissions the browser no longer holds: ${drift.missing.join(', ')}`;
      warn.style.color = '#b45309';
      permsSection.append(warn);
    }
    if (drift.surplus.length > 0) {
      permsSection.append(
        el('p', `Held but not needed by any consented feature: ${drift.surplus.join(', ')}`),
      );
    }
    if (drift.missing.length === 0 && drift.surplus.length === 0) {
      permsSection.append(el('p', 'Consent and browser grants agree.'));
    }

    // The formal drift view over internal ids, for parity with the worker.
    const featureDrift = reconcilePermissions({
      required: FEATURE_IDS.filter((f) => view.consent.grantedFeatures.includes(f)).flatMap(
        (f) => requiredManifestPermissions([f]).permissions,
      ) as never[],
      granted: view.status.grantedPermissions as never[],
    });
    const formal = el(
      'p',
      `reconcilePermissions → missing: ${featureDrift.missing.join(', ') || 'none'} · surplus: ${featureDrift.surplus.join(', ') || 'none'}`,
    );
    formal.style.fontFamily = 'monospace';
    permsSection.append(formal);
  }
  root.append(permsSection);
}

async function load(): Promise<void> {
  const root = document.getElementById('diagnostics-root');
  if (!root) return;

  const [consentResult, statusResult] = await Promise.all([
    rpc.getConsent(),
    rpc.getPermissionsStatus(),
  ]);

  if (!consentResult.ok) {
    root.replaceChildren(el('p', `Could not read consent state: ${consentResult.error.message}`));
    return;
  }

  render(
    {
      consent: consentResult.value,
      ...(statusResult.ok ? { status: statusResult.value } : {}),
    },
    root,
  );
}

void load();
