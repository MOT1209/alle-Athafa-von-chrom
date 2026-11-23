/**
 * Memory-aware admission control for an 8 GB RAM target machine.
 *
 * Heuristic (documented, conservative):
 *   requiredMb ≈ modelFileSizeMb * 1.4 + 256 MB
 * The 1.4 factor covers KV cache + runtime overhead at small contexts; the
 * 256 MB covers the extension/browser baseline. `navigator.deviceMemory` is
 * capped at 8 GB by the browser and may be unavailable — in that case we
 * report "unknown" and never hard-block (honest degradation, no guessing).
 */

export interface MemoryBudget {
  deviceMb: number | null;
  reserveMb: number;
  availableMb: number | null;
}

export interface FitAssessment {
  verdict: 'ok' | 'warn' | 'block' | 'unknown';
  requiredMb: number;
  availableMb: number | null;
  reason?: string;
}

export function deviceMemoryMb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const gb = nav.deviceMemory;
  if (typeof gb !== 'number' || !Number.isFinite(gb) || gb <= 0) return null;
  return Math.round(gb * 1024);
}

export function buildBudget(
  reserveMb: number,
  deviceMb: number | null = deviceMemoryMb(),
): MemoryBudget {
  return {
    deviceMb,
    reserveMb,
    availableMb: deviceMb === null ? null : Math.max(0, deviceMb - reserveMb),
  };
}

export function estimateRequiredMb(sizeBytes: number): number {
  const sizeMb = sizeBytes / (1024 * 1024);
  return Math.ceil(sizeMb * 1.4 + 256);
}

export function assessModelFit(
  sizeBytes: number,
  budget: MemoryBudget,
  enforce: boolean,
): FitAssessment {
  const requiredMb = estimateRequiredMb(sizeBytes);
  const availableMb = budget.availableMb;
  if (availableMb === null) {
    return { verdict: 'unknown', requiredMb, availableMb: null };
  }
  if (requiredMb <= availableMb) {
    return { verdict: 'ok', requiredMb, availableMb };
  }
  if (!enforce) {
    return {
      verdict: 'warn',
      requiredMb,
      availableMb,
      reason: `Model needs ~${requiredMb} MB but only ~${availableMb} MB is available. Running anyway because memory enforcement is disabled.`,
    };
  }
  return {
    verdict: 'block',
    requiredMb,
    availableMb,
    reason: `Model needs ~${requiredMb} MB but only ~${availableMb} MB is available (device ${budget.deviceMb} MB minus ${budget.reserveMb} MB reserved). Pick a smaller model/quantization, or disable memory enforcement in settings.`,
  };
}
