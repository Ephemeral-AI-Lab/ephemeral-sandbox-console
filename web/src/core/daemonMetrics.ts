import type { DaemonProcessMetrics } from "@/api/observability";

export const DAEMON_HISTORY_LIMIT = 900;

export interface DaemonMetricPoint extends DaemonProcessMetrics {
  sample_period_ms: number | null;
  cpu_percent: number | null;
  io_read_bytes_per_second: number | null;
  io_write_bytes_per_second: number | null;
  context_switches_per_second: number | null;
}

export function appendDaemonMetric(
  history: DaemonMetricPoint[],
  sample: DaemonProcessMetrics,
  limit = DAEMON_HISTORY_LIMIT,
): DaemonMetricPoint[] {
  if (!sample.available || limit < 1) return history;
  const last = history.at(-1);
  if (last !== undefined && sample.sampled_at_unix_ms <= last.sampled_at_unix_ms) return history;
  const previous = sameProcess(last, sample) ? last : undefined;
  const point = deriveDaemonMetric(previous, sample);
  const next = previous === undefined && last !== undefined ? [point] : [...history, point];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function deriveDaemonMetric(
  previous: DaemonMetricPoint | undefined,
  sample: DaemonProcessMetrics,
): DaemonMetricPoint {
  const samplePeriodMs = previous === undefined
    ? null
    : sample.sampled_at_unix_ms - previous.sampled_at_unix_ms;
  return {
    ...sample,
    sample_period_ms: samplePeriodMs !== null && samplePeriodMs > 0 ? samplePeriodMs : null,
    cpu_percent: rate(previous?.cpu_time_us, sample.cpu_time_us, samplePeriodMs, 0.1),
    io_read_bytes_per_second: rate(
      previous?.io_read_bytes,
      sample.io_read_bytes,
      samplePeriodMs,
      1_000,
    ),
    io_write_bytes_per_second: rate(
      previous?.io_write_bytes,
      sample.io_write_bytes,
      samplePeriodMs,
      1_000,
    ),
    context_switches_per_second: rate(
      contextSwitches(previous),
      contextSwitches(sample),
      samplePeriodMs,
      1_000,
    ),
  };
}

function rate(
  previous: number | null | undefined,
  current: number | null,
  periodMs: number | null,
  scale: number,
): number | null {
  if (previous === null || previous === undefined || current === null || periodMs === null || periodMs <= 0) {
    return null;
  }
  const delta = current - previous;
  return delta >= 0 ? delta * scale / periodMs : null;
}

function contextSwitches(sample: Pick<
  DaemonProcessMetrics,
  "voluntary_context_switches" | "involuntary_context_switches"
> | undefined): number | null {
  if (
    sample?.voluntary_context_switches === null ||
    sample?.voluntary_context_switches === undefined ||
    sample.involuntary_context_switches === null
  ) {
    return null;
  }
  return sample.voluntary_context_switches + sample.involuntary_context_switches;
}

function sameProcess(
  previous: DaemonMetricPoint | undefined,
  sample: DaemonProcessMetrics,
): boolean {
  return previous !== undefined &&
    previous.pid === sample.pid &&
    previous.start_time_ticks === sample.start_time_ticks;
}
