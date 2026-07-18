import {
  inFlightCount,
  type SandboxSnapshot,
  type SnapshotResult,
} from "@/api/observability";
import type { SandboxRecord } from "@/api/types";

export type SnapshotPollingMode = "fast" | "slow";

export function snapshotForSandbox(
  snapshot: SnapshotResult | null | undefined,
  sandboxId: string,
): SandboxSnapshot | undefined {
  return snapshot?.sandboxes.find((entry) => entry.sandbox_id === sandboxId);
}

/**
 * A daemon snapshot is active when its ready manager record has a live command
 * or layer lease. Resource/timestamp churn is deliberately ignored.
 */
export function snapshotHasActivity(
  record: SandboxRecord | null,
  snapshot?: SnapshotResult | null,
): boolean {
  if (record?.state !== "ready") return false;
  const sandbox = snapshotForSandbox(snapshot, record.id);
  return sandbox !== undefined &&
    (sandbox.stack.active_leases > 0 || inFlightCount(sandbox) > 0);
}

/**
 * Snapshot requests are revision-gated: resolve once, retry on a manager
 * revision, and continue polling only while the last snapshot is active.
 */
export function shouldRequestSandboxSnapshot(
  record: SandboxRecord | null,
  snapshot: SnapshotResult | undefined,
  lastSnapshotRevision: number | null | undefined,
): boolean {
  if (record?.state !== "ready") return false;
  if (snapshot === undefined) {
    if (lastSnapshotRevision === undefined) return true;
    return (
      typeof record.activity_revision === "number" &&
      record.activity_revision !== lastSnapshotRevision
    );
  }
  if (snapshotHasActivity(record, snapshot)) return true;
  return (
    typeof record.activity_revision === "number" &&
    record.activity_revision !== lastSnapshotRevision
  );
}

export function snapshotPollingMode(
  record: SandboxRecord | null,
  snapshot?: SnapshotResult | null,
): SnapshotPollingMode {
  return snapshotHasActivity(record, snapshot) ? "fast" : "slow";
}

export function snapshotActiveCommandCount(
  record: SandboxRecord,
  snapshot?: SnapshotResult | null,
): number | null {
  if (record.state !== "ready") return null;
  const sandbox = snapshotForSandbox(snapshot, record.id);
  return sandbox === undefined ? null : inFlightCount(sandbox);
}
