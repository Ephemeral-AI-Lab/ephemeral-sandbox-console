import { useId } from "react";
import { Button } from "@mantine/core";
import { Link } from "react-router";
import type { SandboxSnapshot } from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import { DestroyAction } from "@/components/DestroyAction";
import { StreamLogPane } from "@/components/StreamLogPane";
import { sandboxCardViewModel } from "@/core/fleet";
import type { SandboxCurrentUsage } from "@/core/resources";
import { formatBytes } from "@/lib/format";
import styles from "@/pages/dashboard/DashboardPage.module.css";

const UNKNOWN = "—";

function formatCpu(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  return `${value.toFixed(value < 1 ? 2 : 1)}%`;
}

function ResourceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.resourceMetric} data-fleet-resource>
      <span className={styles.metadataLabel}>{label}</span>
      <span className={styles.resourceValue}>{value}</span>
    </div>
  );
}

export function SandboxCard({
  clusterId,
  createLogs,
  record,
  snapshot,
  usage,
}: {
  clusterId?: string;
  createLogs: string[] | undefined;
  record: SandboxRecord;
  snapshot: SandboxSnapshot | undefined;
  usage: SandboxCurrentUsage | undefined;
}) {
  const titleId = useId();
  const view = sandboxCardViewModel(record, snapshot, usage);
  const destination = `/sandboxes/${encodeURIComponent(record.id)}`;
  const progressLabel =
    view.lifecycleState === "creating"
      ? "Creating…"
      : view.lifecycleState === "stopping"
        ? "Stopping…"
        : null;

  return (
    <article
      aria-labelledby={titleId}
      className={styles.sandboxCard}
      data-fleet-card
      data-status-tone={view.status.tone}
    >
      <div className={styles.cardBody}>
        <header className={styles.cardHeader}>
          <span
            className={styles.idChip}
            id={titleId}
            title={record.id}
          >
            {record.id}
          </span>
          <span className={styles.cardBadges}>
            {clusterId ? (
              <Link
                aria-label={`View cluster ${clusterId}`}
                className={styles.membershipBadge}
                data-cluster-membership
                title={`View cluster ${clusterId}`}
                to={`/?${new URLSearchParams({ view: "cluster", q: clusterId })}`}
              >
                {clusterId}
              </Link>
            ) : null}
            <span
              className={styles.statusBadge}
              data-pulse={view.status.pulse || undefined}
            >
              <span aria-hidden className={styles.statusDot} />
              {view.status.label}
            </span>
          </span>
        </header>

        <div className={styles.workspace} data-fleet-workspace>
          <div className={styles.metadataLabel}>Workspace</div>
          <div className={styles.workspacePath} title={view.workspaceRoot}>
            {view.workspaceRoot || UNKNOWN}
          </div>
        </div>

        <div className={styles.resourceGrid} data-fleet-resources>
          <ResourceMetric label="CPU" value={formatCpu(view.cpuPercent)} />
          <ResourceMetric
            label="MEM"
            value={view.memoryBytes === null ? UNKNOWN : formatBytes(view.memoryBytes)}
          />
          <ResourceMetric
            label="SESSIONS"
            value={view.sessions === null ? UNKNOWN : String(view.sessions)}
          />
          <ResourceMetric
            label="ACTIVE CMDS"
            value={
              view.activeCommands === null ? UNKNOWN : String(view.activeCommands)
            }
          />
        </div>

        {view.lifecycleState === "creating" ? (
          <div className={styles.streamLog}>
            <StreamLogPane lines={createLogs ?? []} maxHeight={86} />
          </div>
        ) : null}

        {view.lifecycleState === "failed" ? (
          <p className={styles.lifecycleNote}>
            Sandbox failed to reach ready. Inspect its record for details.
          </p>
        ) : null}

        <footer className={styles.cardActions}>
          {progressLabel ? (
            <Button className={styles.primaryAction} disabled variant="light">
              {progressLabel}
            </Button>
          ) : view.primaryAction?.disabled ? (
            <Button className={styles.primaryAction} disabled variant="light">
              {view.primaryAction.label}
            </Button>
          ) : view.primaryAction ? (
            <Button
              className={styles.primaryAction}
              component={Link}
              to={destination}
              variant={view.primaryAction.kind === "open" ? "filled" : "light"}
            >
              {view.primaryAction.label}
            </Button>
          ) : (
            <span />
          )}
          <DestroyAction sandboxId={record.id} touchTarget />
        </footer>
      </div>
    </article>
  );
}
