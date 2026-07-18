import type { ResourceSample } from "@/api/observability";
import type { SandboxRecord } from "@/api/types";

export const MIN_CPU_SAMPLE_MS = 250;

/**
 * The latest trustworthy resource values for one sandbox. A missing value is
 * represented by `null`; callers must not turn it into zero.
 */
export interface SandboxCurrentUsage {
  cpuPercent: number | null;
  memoryBytes: number | null;
  sampledAt: number | null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Select current gauges from a cgroup series. Memory uses the newest valid
 * gauge while CPU uses the newest interval long enough to avoid a noisy
 * near-zero sampling window.
 */
export function currentUsageFromSeries(
  samples: readonly ResourceSample[],
): SandboxCurrentUsage {
  const latest = samples[samples.length - 1];
  let memoryBytes: number | null = null;
  let cpuPercent: number | null = null;

  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const memory = samples[index]?.metrics["mem_cur"];
    if (isFiniteNonNegative(memory)) {
      memoryBytes = memory;
      break;
    }
  }

  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    const cpuDelta = sample?.deltas["cpu_usec"];
    const sampleDeltaMs = sample?.sample_delta_ms;
    if (
      isFiniteNonNegative(cpuDelta) &&
      isFiniteNonNegative(sampleDeltaMs) &&
      sampleDeltaMs >= MIN_CPU_SAMPLE_MS
    ) {
      cpuPercent = (cpuDelta / (sampleDeltaMs * 1_000)) * 100;
      break;
    }
  }

  return {
    cpuPercent,
    memoryBytes,
    sampledAt: isFiniteNonNegative(latest?.ts) ? latest.ts : null,
  };
}

/** Return a usable current-memory sample, preserving unknown as `null`. */
export function currentMemoryBytes(
  usage: SandboxCurrentUsage | undefined,
): number | null {
  return isFiniteNonNegative(usage?.memoryBytes) ? usage.memoryBytes : null;
}

/**
 * Average only the current-memory samples that actually exist for records in
 * the confirmed fleet. The denominator is never the total sandbox count.
 */
export function averageMemoryBytes(
  records: readonly Pick<SandboxRecord, "id">[],
  usage: ReadonlyMap<string, SandboxCurrentUsage>,
): number | null {
  let total = 0;
  let sampleCount = 0;

  for (const record of records) {
    const memoryBytes = currentMemoryBytes(usage.get(record.id));
    if (memoryBytes === null) continue;
    total += memoryBytes;
    sampleCount += 1;
  }

  return sampleCount === 0 ? null : total / sampleCount;
}
