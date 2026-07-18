import { describe, expect, it } from "vitest";
import type { DaemonProcessMetrics } from "@/api/observability";
import { appendDaemonMetric } from "@/core/daemonMetrics";

describe("daemon metric history", () => {
  it("derives process CPU, I/O, and context-switch rates from monotonic counters", () => {
    let history = appendDaemonMetric([], sample());
    history = appendDaemonMetric(history, sample({
      sampled_at_unix_ms: 2_000,
      cpu_time_us: 1_100_000,
      io_read_bytes: 6_096,
      io_write_bytes: 11_192,
      voluntary_context_switches: 127,
      involuntary_context_switches: 6,
    }));

    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      sample_period_ms: 1_000,
      cpu_percent: 10,
      io_read_bytes_per_second: 2_000,
      io_write_bytes_per_second: 3_000,
      context_switches_per_second: 10,
    });
  });

  it("keeps a hard sample cap and ignores duplicate or out-of-order timestamps", () => {
    let history = appendDaemonMetric([], sample(), 2);
    history = appendDaemonMetric(history, sample(), 2);
    history = appendDaemonMetric(history, sample({ sampled_at_unix_ms: 2_000 }), 2);
    history = appendDaemonMetric(history, sample({ sampled_at_unix_ms: 3_000 }), 2);
    history = appendDaemonMetric(history, sample({ sampled_at_unix_ms: 2_500 }), 2);

    expect(history.map((point) => point.sampled_at_unix_ms)).toEqual([2_000, 3_000]);
  });

  it("starts a fresh series after a daemon restart", () => {
    let history = appendDaemonMetric([], sample());
    history = appendDaemonMetric(history, sample({
      sampled_at_unix_ms: 2_000,
      pid: 9,
      start_time_ticks: 999,
    }));

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ pid: 9, cpu_percent: null, sample_period_ms: null });
  });

  it("does not replace a valid capture with an unavailable sample", () => {
    const history = appendDaemonMetric([], sample());
    const next = appendDaemonMetric(history, sample({ available: false, error: "procfs denied" }));

    expect(next).toBe(history);
  });
});

function sample(overrides: Partial<DaemonProcessMetrics> = {}): DaemonProcessMetrics {
  return {
    available: true,
    error: null,
    sampled_at_unix_ms: 1_000,
    pid: 7,
    name: "sandbox-daemon",
    state: "S (sleeping)",
    virtual_memory_bytes: 120_000_000,
    resident_memory_bytes: 30_000_000,
    peak_resident_memory_bytes: 32_000_000,
    proportional_set_size_bytes: 28_000_000,
    unique_set_size_bytes: 26_000_000,
    anonymous_memory_bytes: 25_000_000,
    file_memory_bytes: 4_000_000,
    shared_memory_bytes: 1_000_000,
    data_memory_bytes: 27_000_000,
    swap_bytes: 0,
    cpu_time_us: 1_000_000,
    start_time_ticks: 123,
    thread_count: 37,
    file_descriptor_count: 15,
    io_read_bytes: 4_096,
    io_write_bytes: 8_192,
    read_syscalls: 41,
    write_syscalls: 17,
    voluntary_context_switches: 120,
    involuntary_context_switches: 3,
    cgroup_memberships: ["0::/_daemon"],
    warnings: [],
    ...overrides,
  };
}
