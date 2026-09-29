/**
 * Tests for the Phase 2 permission wiring: the pure
 * `effectiveGrantedPermissions` mapping and the Chrome bridge's honest
 * degradation when `chrome.permissions` is unavailable.
 */

import {
  type ChromePermissionsLike,
  type PermissionsAreaLike,
  getGrantedPermissions,
  hasAllBrowserGrants,
  permissionsApiAvailable,
  requestFeaturePermissions,
  revokeFeaturePermissions,
} from '@/browser/permissions';
import { PERMISSIONS, effectiveGrantedPermissions } from '@/security/permissions';
import { describe, expect, it } from 'vitest';

describe('effectiveGrantedPermissions', () => {
  it('maps empty grants to no held permissions', () => {
    expect(effectiveGrantedPermissions({ permissions: [], origins: [] })).toEqual([]);
  });

  it('maps storage and scripting literals to their ids', () => {
    expect(
      effectiveGrantedPermissions({ permissions: ['storage', 'scripting'], origins: [] }),
    ).toEqual(['storage', 'scripting']);
  });

  it('never infers aiAnalysis from the shared storage literal', () => {
    // aiAnalysis is a logical permission decided by consent, not by the
    // browser: it shares the `storage` literal but must not light up just
    // because the browser holds storage.
    const result = effectiveGrantedPermissions({ permissions: ['storage'], origins: [] });
    expect(result).toEqual(['storage']);
    expect(result).not.toContain('aiAnalysis');
  });

  it('treats any granted origin as hostAccess', () => {
    expect(
      effectiveGrantedPermissions({ permissions: [], origins: ['https://example.com/*'] }),
    ).toEqual(['hostAccess']);
    expect(effectiveGrantedPermissions({ permissions: [], origins: ['<all_urls>'] })).toEqual([
      'hostAccess',
    ]);
  });

  it('ignores unknown permission literals instead of crashing', () => {
    expect(
      effectiveGrantedPermissions({ permissions: ['storage', 'mystery'], origins: [] }),
    ).toEqual(['storage']);
  });

  it('keeps the canonical catalogue order and excludes logical-only ids', () => {
    const result = effectiveGrantedPermissions({
      permissions: ['scripting', 'storage', 'devtools'],
      origins: ['<all_urls>'],
    });
    expect(result).toEqual(['storage', 'devtools', 'hostAccess', 'scripting']);
    expect(result).not.toContain('aiAnalysis');
  });

  it('does not report hostAccess when origins is empty', () => {
    const result = effectiveGrantedPermissions({ permissions: ['storage'], origins: [] });
    expect(result).not.toContain('hostAccess');
  });

  it('covers every browser-mapped catalogue entry from its literal', () => {
    // Every non-host, non-logical permission id must be discoverable from its
    // literal. aiAnalysis is excluded: it is consent-decided, not browser-
    // granted (asserted separately above).
    for (const id of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      if (id === 'aiAnalysis') continue;
      const literal = PERMISSIONS[id].chromePermission;
      if (literal.startsWith('<')) continue;
      const mapped = effectiveGrantedPermissions({ permissions: [literal], origins: [] });
      expect(mapped).toContain(id);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Chrome bridge
 * ------------------------------------------------------------------ */

function fakeArea(overrides: Partial<PermissionsAreaLike> = {}): PermissionsAreaLike {
  return {
    contains: vi.fn(() => Promise.resolve(false)),
    request: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(true)),
    getAll: vi.fn(() => Promise.resolve({ permissions: ['storage'], origins: [] })),
    ...overrides,
  };
}

function withChrome(area: PermissionsAreaLike | undefined): void {
  (globalThis as { chrome?: ChromePermissionsLike }).chrome = area
    ? { permissions: area }
    : undefined;
}

describe('chrome permissions bridge', () => {
  it('reports availability only when every method exists', () => {
    withChrome(fakeArea());
    expect(permissionsApiAvailable()).toBe(true);

    withChrome(undefined);
    expect(permissionsApiAvailable()).toBe(false);

    withChrome({ request: vi.fn(() => Promise.resolve(true)) } as unknown as PermissionsAreaLike);
    expect(permissionsApiAvailable()).toBe(false);
  });

  it('getGrantedPermissions returns empty (not a throw) when the API is absent', async () => {
    withChrome(undefined);
    const result = await getGrantedPermissions();
    expect(result.permissions).toEqual([]);
    expect(result.raw).toEqual({ permissions: [], origins: [] });
  });

  it('getGrantedPermissions normalises chrome output to internal ids', async () => {
    withChrome(
      fakeArea({
        getAll: () =>
          Promise.resolve({
            permissions: ['storage', 'scripting'],
            origins: ['https://a.example/*'],
          }),
      }),
    );
    const result = await getGrantedPermissions();
    expect(result.permissions).toEqual(['storage', 'hostAccess', 'scripting']);
  });

  it('requestFeaturePermissions asks only for the optional literals the feature needs', async () => {
    const area = fakeArea();
    withChrome(area);

    const granted = await requestFeaturePermissions('errorCapture');
    expect(granted).toBe(true);
    // `storage` is manifest-required and must not appear in the prompt.
    expect(area.request).toHaveBeenCalledWith({
      permissions: ['scripting'],
      origins: ['<all_urls>'],
    });
  });

  it('requestFeaturePermissions succeeds without prompting when nothing optional is needed', async () => {
    const area = fakeArea();
    withChrome(area);

    await expect(requestFeaturePermissions('deterministicReasoning')).resolves.toBe(true);
    expect(area.request).not.toHaveBeenCalled();
  });

  it('requestFeaturePermissions resolves false when the API is absent', async () => {
    withChrome(undefined);
    await expect(requestFeaturePermissions('errorCapture')).resolves.toBe(false);
  });

  it('revokeFeaturePermissions removes optional grants but never storage', async () => {
    const area = fakeArea();
    withChrome(area);

    await revokeFeaturePermissions('errorCapture');
    expect(area.remove).toHaveBeenCalledWith({
      permissions: ['scripting'],
      origins: ['<all_urls>'],
    });
  });

  it('revokeFeaturePermissions is a no-op success for local-only features', async () => {
    const area = fakeArea();
    withChrome(area);

    // deterministicReasoning needs only `storage`, which is required-only and
    // must never be revoked.
    await expect(revokeFeaturePermissions('deterministicReasoning')).resolves.toBe(true);
    expect(area.remove).not.toHaveBeenCalled();
  });

  it('hasAllBrowserGrants probes chrome.contains minus the required storage grant', async () => {
    const area = fakeArea({ contains: vi.fn(() => Promise.resolve(true)) });
    withChrome(area);

    await expect(hasAllBrowserGrants('errorCapture')).resolves.toBe(true);
    expect(area.contains).toHaveBeenCalledWith({
      permissions: ['scripting'],
      origins: ['<all_urls>'],
    });
  });

  it('hasAllBrowserGrants is true when a feature needs nothing optional', async () => {
    const area = fakeArea();
    withChrome(area);

    await expect(hasAllBrowserGrants('deterministicReasoning')).resolves.toBe(true);
    expect(area.contains).not.toHaveBeenCalled();
  });

  it('hasAllBrowserGrants fails closed when contains rejects', async () => {
    withChrome(fakeArea({ contains: () => Promise.reject(new Error('gone')) }));
    await expect(hasAllBrowserGrants('errorCapture')).resolves.toBe(false);
  });
});
