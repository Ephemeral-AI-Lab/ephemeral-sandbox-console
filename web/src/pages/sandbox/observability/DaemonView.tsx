import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { Download, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchCgroup, type WorkspaceProcessTopology } from "@/api/observability";
import { DAEMON_HISTORY_LIMIT, type DaemonMetricPoint } from "@/core/daemonMetrics";
import { formatBytes, formatTimestamp } from "@/lib/format";
import { useSandbox } from "@/pages/sandbox/SandboxContext";
import { DaemonHistoryCharts } from "@/pages/sandbox/observability/DaemonCharts";
import {
  DAEMON_VISIBLE_HISTORY_LIMIT,
  useDaemonCapture,
} from "@/pages/sandbox/observability/useDaemonCapture";
import { usePoll } from "@/poll/usePoll";

const TOPOLOGY_WINDOW_MS = 60_000;
const IDLE_MEMORY_TARGET_BYTES = 2 * 1024 * 1024;

type CaptureCadence = "standard" | "close";

export function DaemonView() {
  const { sandboxId } = useSandbox();
  const [capturing, setCapturing] = useState(true);
  const [cadence, setCadence] = useState<CaptureCadence>("standard");
  const {
    history,
    storedCount,
    ready: storageReady,
    error: storageError,
    recordSample,
    clearCapture,
    readFullCapture,
  } = useDaemonCapture(sandboxId);
  const result = usePoll({
    key: ["observability", sandboxId, "cgroup", "daemon", cadence],
    fn: (signal) => fetchCgroup(sandboxId, "sandbox", TOPOLOGY_WINDOW_MS, signal),
    mode: cadence === "close" ? "fast" : "slow",
    enabled: capturing && storageReady && storageError === null,
  });
  const daemon = result.data?.topology.daemon;

  useEffect(() => {
    setCapturing(true);
  }, [sandboxId]);

  useEffect(() => {
    if (storageError !== null) setCapturing(false);
  }, [storageError]);

  useEffect(() => {
    if (daemon === undefined || daemon === null || result.isPlaceholderData) return;
    recordSample(daemon);
  }, [daemon, recordSample, result.dataUpdatedAt, result.isPlaceholderData]);

  const current = history.at(-1);
  const topology = result.data?.topology;
  const containerMemory = latestContainerMemory(result.data?.series ?? []);
  const activity = topology === undefined ? null : daemonActivity(topology);
  const bufferDurationMs = history.length < 2
    ? 0
    : history.at(-1)!.sampled_at_unix_ms - history[0]!.sampled_at_unix_ms;

  return (
    <Stack gap="md" p="md" data-daemon-view>
      <Paper withBorder p="md" component="section" aria-labelledby="daemon-monitor-title">
        <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
          <Box>
            <Group gap="xs">
              <Text id="daemon-monitor-title" component="h2" size="lg" fw={650}>
                Daemon diagnostic capture
              </Text>
              <Badge color={capturing ? "success" : "neutral"} variant="light">
                {capturing ? "capturing" : "paused"}
              </Badge>
              {activity ? <Badge color={activity.color} variant="outline">{activity.label}</Badge> : null}
            </Group>
            <Text size="sm" c="dimmed" mt={4}>
              Process-level procfs metrics correlated with manager-owned container memory
            </Text>
          </Box>
          <Group gap="xs" align="end" wrap="wrap">
            <SegmentedControl
              size="xs"
              aria-label="Capture cadence"
              value={cadence}
              onChange={(value) => setCadence(value as CaptureCadence)}
              data={[
                { value: "standard", label: "2 s" },
                { value: "close", label: "400 ms" },
              ]}
            />
            <Button
              leftSection={capturing ? <Pause size={14} /> : <Play size={14} />}
              onClick={() => setCapturing((value) => !value)}
            >
              {capturing ? "Pause" : "Resume"}
            </Button>
            <Button
              leftSection={<Trash2 size={14} />}
              disabled={storedCount === 0}
              onClick={() => void clearCapture().catch(() => undefined)}
            >
              Clear
            </Button>
            <Button
              leftSection={<Download size={14} />}
              disabled={storedCount === 0}
              onClick={() => void readFullCapture()
                .then((samples) => exportCapture(sandboxId, samples))
                .catch(() => undefined)}
            >
              Export JSON
            </Button>
          </Group>
        </Group>
        <Group gap="lg" mt="sm" wrap="wrap">
          <CaptureFact label="Sample interval" value={cadence === "close" ? "400 ms" : "2 s"} />
          <CaptureFact label="Captured on disk" value={`${storedCount} / ${DAEMON_HISTORY_LIMIT}`} />
          <CaptureFact label="Rendered window" value={`${history.length} / ${DAEMON_VISIBLE_HISTORY_LIMIT}`} />
          <CaptureFact label="Buffer span" value={formatSpan(bufferDurationMs)} />
          <CaptureFact label="Last sample" value={current ? formatTimestamp(current.sampled_at_unix_ms) : "Waiting"} />
          <CaptureFact label="PID" value={current ? String(current.pid) : "Unknown"} />
        </Group>
      </Paper>

      <Alert color="blue" title="Disk-backed diagnostic mode">
        This tab contacts the daemon and reads procfs at the selected cadence. History is capped in browser IndexedDB; only the visible chart window is materialized while this tab is open. No history is retained by the daemon.
      </Alert>

      {storageError !== null ? (
        <Alert color="red" role="alert" title="Disk capture unavailable">
          {storageError.message}. Capture has stopped instead of retaining history in memory.
        </Alert>
      ) : null}

      {result.isError ? (
        <Alert color="red" role="alert" title={result.data ? "Daemon refresh failed" : "Daemon metrics unavailable"}>
          {result.error.message} — {capturing ? "retrying automatically." : "resume capture to retry."}
        </Alert>
      ) : null}

      {!result.isError && (result.data === undefined || !storageReady) ? (
        <Alert color="blue" role="status" title="Starting daemon capture">
          {storageReady ? "Waiting for the first process and container sample…" : "Opening the disk-backed capture store…"}
        </Alert>
      ) : null}

      {result.data !== undefined && daemon === undefined ? (
        <Alert color="yellow" role="alert" title="Daemon self-metrics are not supported by this backend">
          The container metrics are available, but this daemon does not yet include the additive topology.daemon payload. Rebuild and restart the gateway and sandbox daemon.
        </Alert>
      ) : null}

      {daemon !== undefined && daemon !== null && !daemon.available ? (
        <Alert color="red" role="alert" title="Daemon procfs collection failed">
          {daemon.error ?? "The daemon did not report a collection error."}
        </Alert>
      ) : null}

      {current ? (
        <>
          <SummaryGrid
            current={current}
            containerMemory={containerMemory}
            targetEligible={activity?.targetEligible ?? false}
          />
          <DaemonHistoryCharts history={history} />
          <DaemonDiagnostics current={current} topology={topology} />
        </>
      ) : null}
    </Stack>
  );
}

function SummaryGrid({
  current,
  containerMemory,
  targetEligible,
}: {
  current: DaemonMetricPoint;
  containerMemory: number | null;
  targetEligible: boolean;
}) {
  const resident = current.resident_memory_bytes;
  const gap = containerMemory !== null && resident !== null
    ? Math.max(containerMemory - resident, 0)
    : null;
  const budgetMemory = current.proportional_set_size_bytes ?? resident;
  const excess = budgetMemory === null ? null : budgetMemory - IDLE_MEMORY_TARGET_BYTES;
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="sm" data-daemon-summary>
      <MetricCard
        label="Container memory"
        value={formatNullableBytes(containerMemory)}
        detail={gap === null ? "Manager cgroup total" : `${formatBytes(gap)} outside daemon RSS`}
      />
      <MetricCard label="Daemon RSS" value={formatNullableBytes(resident)} detail="Resident pages mapped by the process" />
      <MetricCard label="Daemon PSS" value={formatNullableBytes(current.proportional_set_size_bytes)} detail="Shared pages divided proportionally" />
      <MetricCard label="Daemon USS" value={formatNullableBytes(current.unique_set_size_bytes)} detail="Private clean + dirty pages" />
      <MetricCard label="CPU" value={formatPercent(current.cpu_percent)} detail="100% equals one fully used core" />
      <MetricCard label="Threads" value={formatNullableCount(current.thread_count)} detail={`State ${current.state ?? "unavailable"}`} />
      <MetricCard label="Open FDs" value={formatNullableCount(current.file_descriptor_count)} detail={`Swap ${formatNullableBytes(current.swap_bytes)}`} />
      <MetricCard
        label="Idle 2 MiB target"
        value={budgetValue(targetEligible, excess)}
        detail={targetEligible ? "Compared using PSS, then RSS" : "Evaluated only with no managed namespaces"}
        color={targetEligible && excess !== null && excess > 0 ? "danger" : "success"}
      />
    </SimpleGrid>
  );
}

function MetricCard({
  label,
  value,
  detail,
  color = "eyeBlue",
}: {
  label: string;
  value: string;
  detail: string;
  color?: "eyeBlue" | "danger" | "success";
}) {
  return (
    <Paper withBorder p="sm" component="dl" m={0} style={{ borderTopColor: `var(--mantine-color-${color}-6)`, borderTopWidth: 2 }}>
      <Text component="dt" size="xs" c="dimmed">{label}</Text>
      <Text component="dd" m={0} mt={3} ff="monospace" size="xl" fw={650}>{value}</Text>
      <Text size="xs" c="dimmed" mt={3}>{detail}</Text>
    </Paper>
  );
}

function DaemonDiagnostics({
  current,
  topology,
}: {
  current: DaemonMetricPoint;
  topology: WorkspaceProcessTopology | undefined;
}) {
  const rows = [
    ["Process", `${current.name ?? "unknown"} · PID ${current.pid}`, "Identity and host PID inside the sandbox container"],
    ["Virtual memory", formatNullableBytes(current.virtual_memory_bytes), "Mapped address space; not physical memory usage"],
    ["Data mappings", formatNullableBytes(current.data_memory_bytes), "Writable data, heap, and anonymous mappings"],
    ["Peak RSS", formatNullableBytes(current.peak_resident_memory_bytes), "High-water resident set since process start"],
    ["CPU time", formatMicroseconds(current.cpu_time_us), "Cumulative user + system CPU"],
    ["Physical I/O", `${formatNullableBytes(current.io_read_bytes)} read · ${formatNullableBytes(current.io_write_bytes)} written`, "Cumulative storage bytes"],
    ["I/O syscalls", `${formatNullableCount(current.read_syscalls)} read · ${formatNullableCount(current.write_syscalls)} write`, "Cumulative syscall count"],
    ["Context switches", `${formatNullableCount(current.voluntary_context_switches)} voluntary · ${formatNullableCount(current.involuntary_context_switches)} involuntary`, "Cumulative scheduler switches"],
  ];
  return (
    <Paper withBorder p="md" component="section" aria-labelledby="daemon-diagnostics-title">
      <Group justify="space-between" align="flex-start" gap="md">
        <Box>
          <Text id="daemon-diagnostics-title" component="h3" fw={600}>Raw process diagnostics</Text>
          <Text size="xs" c="dimmed" mt={2}>Current counters retained in exported captures for offline comparison</Text>
        </Box>
        <Badge variant="light" color={current.warnings.length > 0 ? "yellow" : "success"}>
          {current.warnings.length > 0 ? `${current.warnings.length} warnings` : "complete sample"}
        </Badge>
      </Group>
      <Table.ScrollContainer minWidth={720} mt="md">
        <Table striped highlightOnHover aria-label="Daemon raw diagnostics">
          <Table.Thead>
            <Table.Tr><Table.Th>Metric</Table.Th><Table.Th>Current</Table.Th><Table.Th>Interpretation</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map(([metric, value, meaning]) => (
              <Table.Tr key={metric}>
                <Table.Td>{metric}</Table.Td>
                <Table.Td ff="monospace">{value}</Table.Td>
                <Table.Td c="dimmed">{meaning}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
        <Box>
          <Text size="xs" c="dimmed" mb={4}>Daemon cgroup membership</Text>
          <Stack gap={4}>
            {current.cgroup_memberships.length > 0
              ? current.cgroup_memberships.map((membership) => <Code key={membership}>{membership}</Code>)
              : <Text size="sm">Not reported</Text>}
          </Stack>
        </Box>
        <Box>
          <Text size="xs" c="dimmed" mb={4}>Collection warnings</Text>
          {current.warnings.length > 0
            ? <Stack gap={3}>{current.warnings.map((warning) => <Text key={warning} size="xs">{warning}</Text>)}</Stack>
            : <Text size="sm">None</Text>}
        </Box>
      </SimpleGrid>
      {topology?.workspaces.length === 0 ? (
        <Text size="xs" c="dimmed" mt="md">
          No managed namespace exists. Any gap between container memory and daemon RSS can be page cache, kernel memory, or an unmanaged process such as a direct container exec.
        </Text>
      ) : null}
    </Paper>
  );
}

function CaptureFact({ label, value }: { label: string; value: string }) {
  return (
    <Box component="dl" m={0}>
      <Text component="dt" size="xs" c="dimmed">{label}</Text>
      <Text component="dd" m={0} mt={1} ff="monospace" size="xs">{value}</Text>
    </Box>
  );
}

function daemonActivity(topology: WorkspaceProcessTopology) {
  const workloadCount = topology.workspaces.reduce(
    (count, workspace) => count + workspace.processes.filter((process) => process.kind === "process").length,
    0,
  );
  if (workloadCount > 0) return { label: `${workloadCount} workload processes`, color: "blue" as const, targetEligible: false };
  if (topology.workspaces.length > 0) return { label: `${topology.workspaces.length} idle namespaces`, color: "yellow" as const, targetEligible: false };
  return { label: "no managed namespaces", color: "success" as const, targetEligible: true };
}

function latestContainerMemory(series: Array<{ metrics: Record<string, number | boolean | string> }>) {
  const value = series.at(-1)?.metrics["mem_cur"];
  return typeof value === "number" ? value : null;
}

function budgetValue(targetEligible: boolean, excess: number | null) {
  if (!targetEligible) return "Not evaluated";
  if (excess === null) return "Unavailable";
  return excess <= 0 ? "Within target" : `+${formatBytes(excess)}`;
}

function formatNullableBytes(value: number | null) {
  return value === null ? "Unavailable" : formatBytes(value);
}

function formatNullableCount(value: number | null) {
  return value === null ? "Unavailable" : value.toLocaleString();
}

function formatPercent(value: number | null) {
  return value === null ? "Waiting" : `${value.toFixed(1)}%`;
}

function formatMicroseconds(value: number | null) {
  if (value === null) return "Unavailable";
  return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}s`;
}

function formatSpan(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function exportCapture(sandboxId: string, history: DaemonMetricPoint[]) {
  const exportedAt = new Date().toISOString();
  const documentValue = JSON.stringify({ sandbox_id: sandboxId, exported_at: exportedAt, samples: history }, null, 2);
  const url = URL.createObjectURL(new Blob([documentValue], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `daemon-capture-${sandboxId}-${exportedAt.replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
