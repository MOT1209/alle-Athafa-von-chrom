/**
 * Chrome optional-permission bridge (plan Phase 2).
 *
 * `chrome.permissions.request` only works inside a genuine user gesture, so
 * the panel hands the browser a real click and this module hands the browser
 * the exact literals from `PERMISSIONS`. Nothing here invents a permission
 * string: every request is derived from the feature's spec via
 * `requiredManifestPermissions()`, which is the same policy module the consent
 * dialog reads — one source of truth for what a feature needs.
 *
 * Manifest-required literals (`MANIFEST_PERMISSIONS`) are subtracted from both
 * requests and revocations: re-requesting them is a redundant prompt, and
 * revoking them would break settings persistence for features the user never
 * touched. Every call degrades honestly when `chrome.permissions` is absent
 * (tests, plain pages): the probe reports `unavailable` and mutations resolve
 * `false`, so the UI can say "cannot ask the browser right now".
 */

import {
  type FeatureId,
  MANIFEST_PERMISSIONS,
  PERMISSIONS,
  type PermissionId,
  requiredManifestPermissions,
} from '@/security/permissions';

/** The slice of `chrome.permissions` this module touches. */
export interface PermissionsAreaLike {
  contains(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  request(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  remove(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  getAll(): Promise<{ permissions: string[]; origins: string[] }>;
}

export interface ChromePermissionsLike {
  permissions?: PermissionsAreaLike;
}

function area(): PermissionsAreaLike | undefined {
  return (globalThis as { chrome?: ChromePermissionsLike }).chrome?.permissions;
}

/** True when a real `chrome.permissions` area exists in this context. */
export function permissionsApiAvailable(): boolean {
  const api = area();
  return (
    typeof api?.contains === 'function' &&
    typeof api?.request === 'function' &&
    typeof api?.remove === 'function' &&
    typeof api?.getAll === 'function'
  );
}

/** Reads what Chrome currently holds, normalised to the internal PermissionIds. */
export async function getGrantedPermissions(): Promise<{
  permissions: readonly PermissionId[];
  raw: { permissions: string[]; origins: string[] };
}> {
  const api = area();
  if (!api) return { permissions: [], raw: { permissions: [], origins: [] } };
  const raw = await api.getAll();
  const { effectiveGrantedPermissions } = await import('@/security/permissions');
  return { permissions: effectiveGrantedPermissions(raw), raw };
}

/** Feature -> permission needs, derived from the policy catalogue. */
function featurePermissionsFor(featureId: string): readonly FeatureId[] {
  const map: Record<string, readonly FeatureId[]> = {
    errorCapture: ['errorCapture'],
    networkInspection: ['networkInspection'],
    deterministicReasoning: ['deterministicReasoning'],
    aiExplanation: ['aiExplanation'],
  };
  return map[featureId] ?? [];
}

function optionalFor(featureId: string): {
  permissions: string[];
  origins: string[];
} {
  const needed = requiredManifestPermissions(featurePermissionsFor(featureId));
  return {
    permissions: needed.permissions.filter((p) => !MANIFEST_PERMISSIONS.includes(p)),
    origins: [...needed.hostPermissions],
  };
}

/**
 * Requests the browser grants a feature needs. `permissions` literals go to
 * `permissions`; `<all_urls>`-style literals go to `origins`, exactly as
 * `requiredManifestPermissions()` splits them. Manifest-required literals are
 * excluded — they ship with the install and Chrome would not prompt for them.
 */
export async function requestFeaturePermissions(featureId: string): Promise<boolean> {
  const api = area();
  if (!api) return false;

  const wanted = optionalFor(featureId);
  if (wanted.permissions.length === 0 && wanted.origins.length === 0) return true;

  const result = await api.request({
    ...(wanted.permissions.length > 0 ? { permissions: wanted.permissions } : {}),
    ...(wanted.origins.length > 0 ? { origins: wanted.origins } : {}),
  });
  return result === true;
}

/** Removes the optional browser grants a feature holds, leaving the rest. */
export async function revokeFeaturePermissions(featureId: string): Promise<boolean> {
  const api = area();
  if (!api) return false;

  const wanted = optionalFor(featureId);
  if (wanted.permissions.length === 0 && wanted.origins.length === 0) return true;

  const result = await api.remove({
    ...(wanted.permissions.length > 0 ? { permissions: wanted.permissions } : {}),
    ...(wanted.origins.length > 0 ? { origins: wanted.origins } : {}),
  });
  return result === true;
}

/**
 * True when the browser currently holds every *optional* permission the
 * feature needs. Manifest-required literals (`storage`) are excluded: they are
 * guaranteed by the install itself.
 */
export async function hasAllBrowserGrants(featureId: string): Promise<boolean> {
  const api = area();
  if (!api) return false;

  const wanted = optionalFor(featureId);
  if (wanted.permissions.length === 0 && wanted.origins.length === 0) return true;

  try {
    return await api.contains({
      ...(wanted.permissions.length > 0 ? { permissions: wanted.permissions } : {}),
      ...(wanted.origins.length > 0 ? { origins: wanted.origins } : {}),
    });
  } catch {
    return false;
  }
}

/**
 * Convenience for diagnostics: every catalogue permission the browser could
 * hold, with the logical-only `aiAnalysis` resolved from consent rather than
 * the browser. Exported for the options page.
 */
export function permissionSummaries(): readonly { id: PermissionId; literal: string }[] {
  return Object.values(PERMISSIONS).map((spec) => ({
    id: spec.id as PermissionId,
    literal: spec.chromePermission,
  }));
}
