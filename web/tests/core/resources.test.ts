import { describe, expect, it } from "vitest";
import type { ResourceSample } from "@/api/observability";
import {
  averageMemoryBytes,
  currentMemoryBytes,
  currentUsageFromSeries,
} from "@/core/resources";

function sample({
  ts,
  sampleDeltaMs,
  cpuDelta,
  memory,
}: {
  ts: number;
  sampleDeltaMs: number | null;
  cpuDelta?: number;
  memory?: number;
}): ResourceSample {
  return {
    ts,
    sample_delta_ms: sampleDeltaMs,
    metrics: memory === undefined ? {} : { mem_cur: memory },
    deltas: cpuDelta === undefined ? {} : { cpu_usec: cpuDelta },
  };
}

describe("fleet resource policy", () => {
  it("uses the newest valid memory gauge and newest stable CPU interval", () => {
    expect(
      currentUsageFromSeries([
        sample({ ts: 1_000, sampleDeltaMs: 2_000, cpuDelta: 20_000, memory: 20_000_000 }),
        sample({ ts: 1_005, sampleDeltaMs: 5, cpuDelta: 0, memory: 21_000_000 }),
      ]),
    ).toEqual({
      cpuPercent: 1,
      memoryBytes: 21_000_000,
      sampledAt: 1_005,
    });
  });

  it("keeps absent and invalid resource samples unknown", () => {
    expect(currentUsageFromSeries([])).toEqual({
      cpuPercent: null,
      memoryBytes: null,
      sampledAt: null,
    });
    expect(
      currentUsageFromSeries([
        sample({ ts: Number.NaN, sampleDeltaMs: 500, cpuDelta: -1, memory: -1 }),
      ]),
    ).toEqual({ cpuPercent: null, memoryBytes: null, sampledAt: null });
  });

  it("averages only known samples belonging to current fleet records", () => {
    const usage = new Map([
      ["one", { cpuPercent: null, memoryBytes: 100, sampledAt: 1 }],
      ["two", { cpuPercent: null, memoryBytes: null, sampledAt: null }],
      ["three", { cpuPercent: null, memoryBytes: 300, sampledAt: 1 }],
      ["stale", { cpuPercent: null, memoryBytes: 10_000, sampledAt: 1 }],
    ]);

    expect(
      averageMemoryBytes([{ id: "one" }, { id: "two" }, { id: "three" }], usage),
    ).toBe(200);
    expect(averageMemoryBytes([{ id: "two" }], usage)).toBeNull();
  });

  it("treats a confirmed zero-memory gauge as a real sample", () => {
    const zero = { cpuPercent: 0, memoryBytes: 0, sampledAt: 1 };
    expect(currentMemoryBytes(zero)).toBe(0);
    expect(averageMemoryBytes([{ id: "zero" }], new Map([["zero", zero]]))).toBe(0);
  });
});
