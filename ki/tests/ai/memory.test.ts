import { describe, expect, it } from 'vitest';
import {
  assessModelFit,
  buildBudget,
  deviceMemoryMb,
  estimateRequiredMb,
} from '../../src/ai/memory';

const MB = 1024 * 1024;

describe('estimateRequiredMb', () => {
  it('applies the documented 1.4x + 256MB heuristic', () => {
    expect(estimateRequiredMb(1000 * MB)).toBe(Math.ceil(1000 * 1.4 + 256));
    expect(estimateRequiredMb(0)).toBe(256);
  });
});

describe('buildBudget', () => {
  it('subtracts reserve from device memory', () => {
    const budget = buildBudget(3072, 8192);
    expect(budget).toEqual({ deviceMb: 8192, reserveMb: 3072, availableMb: 5120 });
  });

  it('never reports negative availability', () => {
    expect(buildBudget(9000, 8192).availableMb).toBe(0);
  });

  it('keeps availability null when device memory is unknown', () => {
    expect(buildBudget(3072, null).availableMb).toBeNull();
  });
});

describe('assessModelFit', () => {
  const budget = buildBudget(3072, 8192); // 5120 MB available

  it('ok when the model fits', () => {
    const fit = assessModelFit(986 * MB, budget, true);
    expect(fit.verdict).toBe('ok');
    expect(fit.requiredMb).toBeLessThanOrEqual(5120);
  });

  it('blocks oversize models when enforcement is on', () => {
    const fit = assessModelFit(7000 * MB, budget, true);
    expect(fit.verdict).toBe('block');
    expect(fit.reason).toContain('smaller model');
  });

  it('warns but allows oversize models when enforcement is off', () => {
    const fit = assessModelFit(7000 * MB, budget, false);
    expect(fit.verdict).toBe('warn');
    expect(fit.reason).toContain('enforcement is disabled');
  });

  it('reports unknown when device memory is unavailable', () => {
    const fit = assessModelFit(7000 * MB, buildBudget(3072, null), true);
    expect(fit.verdict).toBe('unknown');
    expect(fit.availableMb).toBeNull();
  });

  it('boundary: exactly-fitting model is ok', () => {
    const sizeMb = 1000;
    const required = estimateRequiredMb(sizeMb * MB);
    const exact = buildBudget(0, required);
    expect(assessModelFit(sizeMb * MB, exact, true).verdict).toBe('ok');
  });
});

describe('deviceMemoryMb', () => {
  it('returns null when the browser does not expose deviceMemory', () => {
    // Node's navigator has no deviceMemory; same as unsupported browsers.
    expect(deviceMemoryMb()).toBeNull();
  });
});
