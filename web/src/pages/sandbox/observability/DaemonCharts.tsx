import { Box, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { DaemonMetricPoint } from "@/core/daemonMetrics";
import { formatBytes } from "@/lib/format";

interface ChartSeries {
  label: string;
  color: string;
  value: (point: DaemonMetricPoint) => number | null;
  format: (value: number) => string;
}

interface ChartDefinition {
  title: string;
  subtitle: string;
  series: ChartSeries[];
  axis: (value: number) => string;
}

const bytes = (value: number | null) => value === null ? null : value;
const perSecond = (value: number) => `${formatCompact(value)}/s`;
const CHARTS: ChartDefinition[] = [
  {
    title: "Memory footprint",
    subtitle: "RSS is resident pages; PSS shares mapped pages proportionally; USS is private memory",
    axis: formatBytes,
    series: [
      { label: "RSS", color: "#3e6077", value: (point) => bytes(point.resident_memory_bytes), format: formatBytes },
      { label: "PSS", color: "#047857", value: (point) => bytes(point.proportional_set_size_bytes), format: formatBytes },
      { label: "USS", color: "#c78210", value: (point) => bytes(point.unique_set_size_bytes), format: formatBytes },
    ],
  },
  {
    title: "Resident composition",
    subtitle: "Kernel-reported RSS categories plus swapped anonymous pages",
    axis: formatBytes,
    series: [
      { label: "Anonymous", color: "#3e6077", value: (point) => bytes(point.anonymous_memory_bytes), format: formatBytes },
      { label: "File", color: "#047857", value: (point) => bytes(point.file_memory_bytes), format: formatBytes },
      { label: "Shared", color: "#c78210", value: (point) => bytes(point.shared_memory_bytes), format: formatBytes },
      { label: "Swap", color: "#ba1a1a", value: (point) => bytes(point.swap_bytes), format: formatBytes },
    ],
  },
  {
    title: "CPU",
    subtitle: "One process core equals 100%; derived from cumulative user + system CPU time",
    axis: (value) => `${formatCompact(value)}%`,
    series: [
      { label: "CPU", color: "#3e6077", value: (point) => point.cpu_percent, format: (value) => `${value.toFixed(1)}%` },
    ],
  },
  {
    title: "Storage I/O",
    subtitle: "Physical read and write bytes per second reported by procfs",
    axis: formatBytes,
    series: [
      { label: "Read", color: "#047857", value: (point) => point.io_read_bytes_per_second, format: (value) => `${formatBytes(value)}/s` },
      { label: "Write", color: "#c78210", value: (point) => point.io_write_bytes_per_second, format: (value) => `${formatBytes(value)}/s` },
    ],
  },
  {
    title: "Runtime handles",
    subtitle: "Thread and open file descriptor counts; upward drift is a strong leak signal",
    axis: formatCompact,
    series: [
      { label: "Threads", color: "#3e6077", value: (point) => point.thread_count, format: formatCompact },
      { label: "FDs", color: "#c78210", value: (point) => point.file_descriptor_count, format: formatCompact },
    ],
  },
  {
    title: "Context switching",
    subtitle: "Voluntary and involuntary process switches combined per second",
    axis: formatCompact,
    series: [
      { label: "Switches", color: "#3e6077", value: (point) => point.context_switches_per_second, format: perSecond },
    ],
  },
];

export function DaemonHistoryCharts({ history }: { history: DaemonMetricPoint[] }) {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" data-daemon-history-charts>
      {CHARTS.map((chart) => (
        <DaemonChart key={chart.title} chart={chart} history={history} />
      ))}
    </SimpleGrid>
  );
}

function DaemonChart({
  chart,
  history,
}: {
  chart: ChartDefinition;
  history: DaemonMetricPoint[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const data = useMemo(() => {
    const timestamps = history.map((point) => point.sampled_at_unix_ms / 1_000);
    const values = chart.series.map((series) => history.map((point) => series.value(point)));
    return [timestamps, ...values] as uPlot.AlignedData;
  }, [chart, history]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const hasData = history.length > 1 && data.slice(1).some((values) => values.some((value) => value !== null));

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasData) return;
    const plot = new uPlot(
      {
        width: Math.max(host.clientWidth, 1),
        height: 178,
        legend: { show: false },
        cursor: { drag: { x: true, y: false }, focus: { prox: 24 } },
        scales: { x: { time: true } },
        series: [
          {},
          ...chart.series.map((series) => ({
            label: series.label,
            stroke: series.color,
            width: 1.5,
            spanGaps: false,
          })),
        ],
        axes: [
          {
            stroke: "#8a8179",
            grid: { show: false },
            ticks: { show: false },
            size: 28,
          },
          {
            stroke: "#8a8179",
            grid: { stroke: "#eee7df", width: 1 },
            ticks: { show: false },
            size: 64,
            values: (_plot, values) => values.map(chart.axis),
          },
        ],
      },
      dataRef.current,
      host,
    );
    plotRef.current = plot;
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => plot.setSize({ width: Math.max(host.clientWidth, 1), height: 178 }));
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [chart, hasData]);

  useEffect(() => {
    if (hasData) plotRef.current?.setData(data);
  }, [data, hasData]);

  return (
    <Paper withBorder p="md" component="section" aria-label={chart.title}>
      <Text component="h3" fw={600} size="sm">{chart.title}</Text>
      <Text size="xs" c="dimmed" mt={2}>{chart.subtitle}</Text>
      {hasData ? (
        <Box ref={hostRef} mt="sm" />
      ) : (
        <Box h={178} mt="sm" style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
          <Text size="sm" c="dimmed">Waiting for a second sample…</Text>
        </Box>
      )}
      <Stack gap={4} mt="sm">
        {chart.series.map((series) => {
          const latest = latestValue(history, series.value);
          return (
            <Group key={series.label} justify="space-between" gap="xs" wrap="nowrap">
              <Group gap={6} wrap="nowrap">
                <Box w={8} h={8} style={{ background: series.color, borderRadius: 2 }} />
                <Text size="xs" c="dimmed">{series.label}</Text>
              </Group>
              <Text size="xs" ff="monospace">{latest === null ? "Unavailable" : series.format(latest)}</Text>
            </Group>
          );
        })}
      </Stack>
    </Paper>
  );
}

function latestValue(
  history: DaemonMetricPoint[],
  value: (point: DaemonMetricPoint) => number | null,
): number | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = value(history[index]!);
    if (candidate !== null) return candidate;
  }
  return null;
}

function formatCompact(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 });
}
