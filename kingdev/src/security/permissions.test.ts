import {
  CONSENT_VERSION,
  FEATURE_IDS,
  NO_CONSENT,
  PERMISSIONS,
  PERMISSION_IDS,
  activeFeatures,
  consentPromptFor,
  evaluateFeatureAccess,
  reconcilePermissions,
  requiredManifestPermissions,
} from '@/security/permissions';
import type { ConsentState, FeatureId, PermissionId } from '@/security/permissions';
import { describe, expect, it } from 'vitest';

const ALL: readonly PermissionId[] = PERMISSION_IDS;

function consent(...granted: FeatureId[]): ConsentState {
  return {
    version: CONSENT_VERSION,
    grantedFeatures: granted,
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('permission catalogue', () => {
  it('gives every permission a stable id matching its key', () => {
    // The key is the id; a mismatch would silently break every lookup.
    for (const id of PERMISSION_IDS) {
      expect(PERMISSIONS[id].id).toBe(id);
    }
  });

  it('declares a plain-language summary for every permission', () => {
    for (const id of PERMISSION_IDS) {
      expect(PERMISSIONS[id].summary.length).toBeGreaterThan(10);
      expect(PERMISSIONS[id].why.length).toBeGreaterThan(10);
    }
  });

  it('marks anything that can read page data as at least medium risk', () => {
    for (const id of PERMISSION_IDS) {
      const spec = PERMISSIONS[id];
      if (spec.exposure === 'settings-only') continue;
      expect(spec.risk).not.toBe('none');
    }
  });

  it('never classifies credential egress as anything but high risk', () => {
    for (const id of PERMISSION_IDS) {
      if (PERMISSIONS[id].exposure !== 'credentials-and-content') continue;
      expect(PERMISSIONS[id].risk).toBe('high');
    }
  });
});

describe('evaluateFeatureAccess', () => {
  it('denies a feature the user never consented to', () => {
    const decision = evaluateFeatureAccess({
      featureId: 'errorCapture',
      consent: NO_CONSENT,
      grantedPermissions: ALL,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('not-consented');
  });

  it('denies an unknown feature instead of ignoring it', () => {
    // A typo must not resolve to "allowed" by falling through.
    const decision = evaluateFeatureAccess({
      featureId: 'doesNotExist',
      consent: consent('errorCapture'),
      grantedPermissions: ALL,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unknown-feature');
  });

  it('denies a feature whose name collides with an object prototype key', () => {
    for (const probe of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const decision = evaluateFeatureAccess({
        featureId: probe,
        consent: consent(),
        grantedPermissions: ALL,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('unknown-feature');
    }
  });

  it('allows a fully consented and fully granted feature', () => {
    const decision = evaluateFeatureAccess({
      featureId: 'errorCapture',
      consent: consent('errorCapture'),
      grantedPermissions: ALL,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.missingPermissions).toEqual([]);
  });

  it('denies when a required permission was never granted', () => {
    const decision = evaluateFeatureAccess({
      featureId: 'errorCapture',
      consent: consent('errorCapture'),
      grantedPermissions: ['storage'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('permission-not-granted');
    expect(decision.missingPermissions).toEqual(['hostAccess', 'scripting']);
  });

  it('lists every missing permission, not just the first', () => {
    const decision = evaluateFeatureAccess({
      featureId: 'aiExplanation',
      consent: consent('aiExplanation'),
      grantedPermissions: [],
    });

    expect(decision.missingPermissions).toEqual(['aiAnalysis', 'storage']);
  });

  it('denies consent recorded under an older policy version', () => {
    // Consent given for an older version of what a feature does is not consent
    // for what it does now.
    const stale: ConsentState = { ...consent('errorCapture'), version: CONSENT_VERSION - 1 };

    const decision = evaluateFeatureAccess({
      featureId: 'errorCapture',
      consent: stale,
      grantedPermissions: ALL,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('stale-consent');
  });

  it('denies consent from a future version it cannot interpret', () => {
    const future: ConsentState = { ...consent('errorCapture'), version: CONSENT_VERSION + 1 };

    const decision = evaluateFeatureAccess({
      featureId: 'errorCapture',
      consent: future,
      grantedPermissions: ALL,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('stale-consent');
  });

  it("does not let one feature's consent authorise another", () => {
    const decision = evaluateFeatureAccess({
      featureId: 'aiExplanation',
      consent: consent('errorCapture'),
      grantedPermissions: ALL,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('not-consented');
  });
});

describe('activeFeatures', () => {
  it('returns only the features that are both consented and granted', () => {
    const active = activeFeatures({
      consent: consent('errorCapture', 'deterministicReasoning', 'aiExplanation'),
      grantedPermissions: ['storage', 'hostAccess', 'scripting'],
    });

    // aiExplanation is consented but aiAnalysis was never granted.
    expect(active).toEqual(['errorCapture', 'deterministicReasoning']);
  });

  it('returns nothing under default consent', () => {
    expect(activeFeatures({ consent: NO_CONSENT, grantedPermissions: ALL })).toEqual([]);
  });

  it('never returns a feature that is not in the catalogue', () => {
    const active = activeFeatures({ consent: consent(), grantedPermissions: ALL });
    for (const id of active) expect(FEATURE_IDS).toContain(id);
  });
});

describe('requiredManifestPermissions', () => {
  it('separates host permissions from ordinary permissions', () => {
    const required = requiredManifestPermissions(['errorCapture']);

    // Chrome treats these differently, so the caller must not have to guess.
    expect(required.hostPermissions).toEqual(['<all_urls>']);
    expect(required.permissions).toEqual(['scripting', 'storage']);
  });

  it('requests the minimum set for the chosen features', () => {
    const required = requiredManifestPermissions(['deterministicReasoning']);

    expect(required.permissions).toEqual(['storage']);
    expect(required.hostPermissions).toEqual([]);
  });

  it('unions overlapping requirements without duplicating storage', () => {
    const required = requiredManifestPermissions([
      'errorCapture',
      'networkInspection',
      'deterministicReasoning',
    ]);

    expect(required.permissions.filter((p) => p === 'storage')).toHaveLength(1);
    expect(required.permissions).toContain('devtools');
    expect(required.permissions).toContain('scripting');
  });

  it('returns nothing for no features', () => {
    expect(requiredManifestPermissions([])).toEqual({ permissions: [], hostPermissions: [] });
  });

  it('ignores an unknown feature rather than inventing a permission', () => {
    const required = requiredManifestPermissions(['ghostFeature' as FeatureId]);

    expect(required).toEqual({ permissions: [], hostPermissions: [] });
  });
});

describe('reconcilePermissions', () => {
  it('reports nothing when the grant matches the request exactly', () => {
    const drift = reconcilePermissions({
      required: ['storage', 'scripting'],
      granted: ['storage', 'scripting'],
    });

    expect(drift).toEqual({ missing: [], surplus: [] });
  });

  it('surfaces a revoked permission instead of hiding it', () => {
    const drift = reconcilePermissions({
      required: ['storage', 'hostAccess'],
      granted: ['storage'],
    });

    expect(drift.missing).toEqual(['hostAccess']);
    expect(drift.surplus).toEqual([]);
  });

  it('surfaces a permission held but no longer needed', () => {
    const drift = reconcilePermissions({
      required: ['storage'],
      granted: ['storage', 'hostAccess', 'devtools'],
    });

    // Reported in catalogue order so the output is stable and diffable.
    expect(drift.surplus).toEqual(['devtools', 'hostAccess']);
  });

  it('ignores inputs that are not real permission ids', () => {
    const drift = reconcilePermissions({
      required: ['notAPermission' as PermissionId],
      granted: ['alsoFake' as PermissionId],
    });

    expect(drift).toEqual({ missing: [], surplus: [] });
  });
});

describe('consentPromptFor', () => {
  it('describes each permission a feature will use', () => {
    const prompt = consentPromptFor('errorCapture');

    expect(prompt).toBeDefined();
    expect(prompt?.label).toBe('Capture page errors');
    expect(prompt?.permissions.map((p) => p.id)).toEqual(['hostAccess', 'scripting', 'storage']);
  });

  it('flags the feature that sends data off-device', () => {
    expect(consentPromptFor('aiExplanation')?.egress).toBe(true);
    expect(consentPromptFor('errorCapture')?.egress).toBe(false);
  });

  it('surfaces the risk of the most sensitive permission it needs', () => {
    const prompt = consentPromptFor('aiExplanation');
    const risks = prompt?.permissions.map((p) => p.risk) ?? [];

    expect(risks).toContain('high');
  });

  it('returns nothing for an unknown feature', () => {
    expect(consentPromptFor('nope')).toBeUndefined();
    expect(consentPromptFor('constructor')).toBeUndefined();
  });
});
