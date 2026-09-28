/**
 * Permission and consent policy.
 *
 * This module exists so that no feature can quietly start collecting data. It
 * answers three questions and refuses to guess at any of them:
 *
 *   1. What does a feature need?      -> {@link PERMISSIONS} / {@link FEATURES}
 *   2. Has the user agreed to *this*? -> {@link evaluateFeatureAccess}
 *   3. Do we still hold what we asked for? -> {@link reconcilePermissions}
 *
 * The design is fail-closed. An unknown feature id, a stale consent version, or
 * a browser grant that no longer matches the request all resolve to "denied",
 * because a bug in this file must never become a privacy leak in the product.
 */

import type { ISODateString } from '@/core/types';

/* ------------------------------------------------------------------ *
 * Permission catalogue
 * ------------------------------------------------------------------ */

/** How much of the user's data a permission puts within reach. */
export type DataExposure =
  | 'settings-only'
  | 'page-errors'
  | 'network-metadata'
  | 'network-bodies'
  | 'credentials-and-content';

export type PermissionRisk = 'none' | 'low' | 'medium' | 'high';

export interface PermissionSpec {
  /** Stable internal id. Never send this to Chrome. */
  readonly id: string;
  /** The literal string that must appear in the manifest. */
  readonly chromePermission: string;
  readonly risk: PermissionRisk;
  readonly exposure: DataExposure;
  /** One line, plain language, suitable for a consent dialog. */
  readonly summary: string;
  /** Why this project cannot work without it. */
  readonly why: string;
  /** False when the extension still runs (in a reduced mode) without it. */
  readonly essential: boolean;
}

export const PERMISSIONS = {
  storage: {
    id: 'storage',
    chromePermission: 'storage',
    risk: 'none',
    exposure: 'settings-only',
    summary: 'Save your settings and scan history on this device.',
    why: 'Provider keys, enabled features and past scans have to survive a browser restart.',
    essential: true,
  },
  devtools: {
    id: 'devtools',
    chromePermission: 'devtools',
    risk: 'low',
    exposure: 'network-metadata',
    summary: 'Read network requests from the DevTools window you open.',
    why: 'KingDev is a DevTools panel; without this there is no panel to attach to.',
    essential: true,
  },
  hostAccess: {
    id: 'hostAccess',
    chromePermission: '<all_urls>',
    risk: 'high',
    exposure: 'page-errors',
    summary: 'Read errors and unhandled rejections from the pages you visit.',
    why: 'Error capture needs a content script injected into the inspected page.',
    essential: false,
  },
  scripting: {
    id: 'scripting',
    chromePermission: 'scripting',
    risk: 'medium',
    exposure: 'page-errors',
    summary: 'Inject the error-capture script into the page you inspect.',
    why: 'A content script cannot be attached to an already-loaded tab without it.',
    essential: false,
  },
  aiAnalysis: {
    id: 'aiAnalysis',
    chromePermission: 'storage',
    risk: 'high',
    exposure: 'credentials-and-content',
    summary: 'Send page errors to the AI provider you configured, to leave your device.',
    why: 'Nothing about this is required to capture errors; it is only required to explain them with a model.',
    essential: false,
  },
} as const satisfies Record<string, PermissionSpec>;

export type PermissionId = keyof typeof PERMISSIONS;

export const PERMISSION_IDS = Object.keys(PERMISSIONS) as readonly PermissionId[];

/* ------------------------------------------------------------------ *
 * Feature catalogue
 * ------------------------------------------------------------------ */

export interface FeatureSpec {
  readonly id: string;
  readonly label: string;
  /** Everything the feature needs, including indirect dependencies. */
  readonly permissions: readonly PermissionId[];
  /** Sends data off-device, so it is opt-in even if a permission is granted. */
  readonly egress: boolean;
}

export const FEATURES = {
  /** Pure local capture. No network, no provider. */
  errorCapture: {
    id: 'errorCapture',
    label: 'Capture page errors',
    permissions: ['hostAccess', 'scripting', 'storage'],
    egress: false,
  },
  /** DevTools-only: reads network requests from the panel's own context. */
  networkInspection: {
    id: 'networkInspection',
    label: 'Inspect network requests',
    permissions: ['devtools', 'storage'],
    egress: false,
  },
  /** Rule-based diagnosis. No model, no egress. */
  deterministicReasoning: {
    id: 'deterministicReasoning',
    label: 'Explain errors with built-in rules',
    permissions: ['storage'],
    egress: false,
  },
  /** Sends captured errors to a configured provider. */
  aiExplanation: {
    id: 'aiExplanation',
    label: 'Explain errors with an AI provider',
    permissions: ['aiAnalysis', 'storage'],
    egress: true,
  },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureId = keyof typeof FEATURES;

export const FEATURE_IDS = Object.keys(FEATURES) as readonly FeatureId[];

/* ------------------------------------------------------------------ *
 * Consent
 * ------------------------------------------------------------------ */

/**
 * Bump when a feature starts doing anything materially different from what the
 * user agreed to. Old consents then stop matching and every feature re-prompts,
 * which is the only way an "I agreed to send errors" answer can stay honest.
 */
export const CONSENT_VERSION = 1;

export interface ConsentState {
  readonly version: number;
  /** Features the user explicitly turned on. Absence means denied. */
  readonly grantedFeatures: readonly FeatureId[];
  /** When consent was recorded, for the diagnostics page. */
  readonly recordedAt: ISODateString;
}

/** Consent nothing has been granted under yet. */
export const NO_CONSENT: ConsentState = {
  version: 0,
  grantedFeatures: [],
  recordedAt: '1970-01-01T00:00:00.000Z',
};

export type DenialReason =
  | 'unknown-feature'
  | 'not-consented'
  | 'stale-consent'
  | 'permission-not-granted';

export interface AccessDecision {
  readonly allowed: boolean;
  /** Every permission the browser is actually missing for this feature. */
  readonly missingPermissions: readonly PermissionId[];
  readonly reason?: DenialReason;
}

export interface AccessInput {
  readonly featureId: string;
  readonly consent: ConsentState;
  /** Permissions Chrome reports as actually granted right now. */
  readonly grantedPermissions: readonly PermissionId[];
}

/**
 * Decides whether a feature may run. Every branch that is not an explicit,
 * complete grant returns `allowed: false`.
 */
export function evaluateFeatureAccess(input: AccessInput): AccessDecision {
  const feature = Object.hasOwn(FEATURES, input.featureId)
    ? FEATURES[input.featureId as FeatureId]
    : undefined;
  if (!feature) {
    // A typo or a removed feature must not fall through to "allowed".
    return { allowed: false, missingPermissions: [], reason: 'unknown-feature' };
  }
  const featureId = feature.id as FeatureId;

  // Order matters only for the reported reason; every branch denies. Checking
  // membership first means "never consented" reports `not-consented` rather
  // than the technically-true-but-misleading `stale-consent`.
  if (!input.consent.grantedFeatures.includes(featureId)) {
    return { allowed: false, missingPermissions: [], reason: 'not-consented' };
  }

  if (input.consent.version !== CONSENT_VERSION) {
    return {
      allowed: false,
      missingPermissions: [],
      reason: 'stale-consent',
    };
  }

  const granted = new Set(input.grantedPermissions);
  const missing = feature.permissions.filter((p) => !granted.has(p));

  if (missing.length > 0) {
    return { allowed: false, missingPermissions: missing, reason: 'permission-not-granted' };
  }

  return { allowed: true, missingPermissions: [] };
}

/** Features whose consent and browser grants are both currently satisfied. */
export function activeFeatures(input: {
  consent: ConsentState;
  grantedPermissions: readonly PermissionId[];
}): readonly FeatureId[] {
  return FEATURE_IDS.filter(
    (id) =>
      evaluateFeatureAccess({
        featureId: id,
        consent: input.consent,
        grantedPermissions: input.grantedPermissions,
      }).allowed,
  );
}

/* ------------------------------------------------------------------ *
 * Manifest reconciliation
 * ------------------------------------------------------------------ */

/**
 * The minimal manifest permission list implied by a set of features.
 *
 * Host access and scripting are listed under `host_permissions`/`permissions`
 * by Chrome rather than being interchangeable, so the caller receives them
 * split and can place each correctly instead of guessing.
 */
export function requiredManifestPermissions(features: readonly FeatureId[]): {
  permissions: readonly string[];
  hostPermissions: readonly string[];
} {
  const needed = new Set<PermissionId>();
  for (const feature of features) {
    const spec = FEATURES[feature];
    if (!spec) continue;
    for (const permission of spec.permissions) needed.add(permission);
  }

  const permissions = new Set<string>();
  const hostPermissions = new Set<string>();
  for (const id of needed) {
    const literal = PERMISSIONS[id].chromePermission;
    if (literal.startsWith('<')) hostPermissions.add(literal);
    else permissions.add(literal);
  }

  return {
    permissions: [...permissions].sort(),
    hostPermissions: [...hostPermissions].sort(),
  };
}

export interface PermissionDrift {
  /** Requested by a feature but not held by the browser. */
  readonly missing: readonly PermissionId[];
  /** Held by the browser but not needed by any enabled feature. */
  readonly surplus: readonly PermissionId[];
}

/**
 * Compares what the enabled features require against what Chrome actually
 * granted, so a silently downgraded or revoked permission surfaces as a
 * difference rather than as a feature that quietly stops working.
 */
export function reconcilePermissions(input: {
  required: readonly PermissionId[];
  granted: readonly PermissionId[];
}): PermissionDrift {
  const required = new Set(input.required);
  const granted = new Set(input.granted);

  return {
    missing: PERMISSION_IDS.filter((id) => required.has(id) && !granted.has(id)),
    surplus: PERMISSION_IDS.filter((id) => granted.has(id) && !required.has(id)),
  };
}

/** Consent entries a user must actively confirm before anything turns on. */
export interface ConsentPrompt {
  readonly featureId: FeatureId;
  readonly label: string;
  readonly egress: boolean;
  readonly permissions: readonly {
    readonly id: PermissionId;
    readonly summary: string;
    readonly risk: PermissionRisk;
    readonly exposure: DataExposure;
  }[];
}

/** Builds the human-readable consent dialog contents for a feature. */
export function consentPromptFor(featureId: string): ConsentPrompt | undefined {
  const feature = Object.hasOwn(FEATURES, featureId) ? FEATURES[featureId as FeatureId] : undefined;
  if (!feature) return undefined;

  return {
    featureId: feature.id as FeatureId,
    label: feature.label,
    egress: feature.egress,
    permissions: feature.permissions.map((id) => {
      const spec = PERMISSIONS[id];
      return {
        id,
        summary: spec.summary,
        risk: spec.risk,
        exposure: spec.exposure,
      };
    }),
  };
}
