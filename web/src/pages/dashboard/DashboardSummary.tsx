import { Boxes, CircleCheck, MemoryStick, SquareTerminal } from "lucide-react";
import type { SnapshotResult } from "@/api/observability";
import type { SandboxList } from "@/api/types";
import { dashboardSummary } from "@/core/fleet";
import type { SandboxCurrentUsage } from "@/core/resources";
import { formatBytes } from "@/lib/format";
import { DashboardMetricCard } from "@/pages/dashboard/DashboardMetricCard";
import styles from "@/pages/dashboard/DashboardPage.module.css";

const UNKNOWN = "—";

export function DashboardSummary({
  list,
  loading,
  snapshot,
  usage,
}: {
  list: SandboxList | undefined;
  loading: boolean;
  snapshot: SnapshotResult | undefined;
  usage: ReadonlyMap<string, SandboxCurrentUsage>;
}) {
  const summary = dashboardSummary(list, snapshot, usage);
  const metrics = [
    {
      icon: <Boxes size={21} strokeWidth={1.8} />,
      label: "Total Sandboxes",
      value: summary.total === null ? UNKNOWN : String(summary.total),
    },
    {
      icon: <CircleCheck size={21} strokeWidth={1.8} />,
      label: "Ready",
      value: summary.ready === null ? UNKNOWN : String(summary.ready),
    },
    {
      icon: <SquareTerminal size={21} strokeWidth={1.8} />,
      label: "Active Commands",
      value:
        summary.activeCommands === null ? UNKNOWN : String(summary.activeCommands),
    },
    {
      icon: <MemoryStick size={21} strokeWidth={1.8} />,
      label: "Avg Memory",
      value:
        summary.averageMemoryBytes === null
          ? UNKNOWN
          : formatBytes(summary.averageMemoryBytes),
    },
  ];

  return (
    <section aria-label="Sandbox summary" className={styles.summaryGrid}>
      {metrics.map((metric) => (
        <DashboardMetricCard
          {...metric}
          key={metric.label}
          loading={loading}
        />
      ))}
    </section>
  );
}
