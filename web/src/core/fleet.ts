import {
  inFlightCount,
  type SandboxSnapshot,
  type SnapshotResult,
} from "@/api/observability";
import type { SandboxList, SandboxRecord, SandboxState } from "@/api/types";
import {
  averageMemoryBytes,
  type SandboxCurrentUsage,
} from "@/core/resources";
import {
  sandboxStatus,
  type SandboxDisplayState,
  type SandboxStatusPresentation,
} from "@/core/status";

export interface FleetSummary {
  total: number | null;
  ready: number | null;
  activeCommands: number | null;
  averageMemoryBytes: number | null;
}

export type SandboxPrimaryActionKind = "open" | "inspect";

export interface SandboxPrimaryAction {
  kind: SandboxPrimaryActionKind;
  label: "Open" | "Inspect";
  disabled: boolean;
}

export interface SandboxCardViewModel {
  id: string;
  workspaceRoot: string;
  lifecycleState: SandboxState;
  displayState: SandboxDisplayState;
  status: SandboxStatusPresentation;
  cpuPercent: number | null;
  memoryBytes: number | null;
  sessions: number | null;
  activeCommands: number | null;
  primaryAction: SandboxPrimaryAction | null;
}

export function snapshotsBySandbox(
  snapshot: SnapshotResult | null | undefined,
): ReadonlyMap<string, SandboxSnapshot> {
  return new Map(
    (snapshot?.sandboxes ?? []).map((entry) => [entry.sandbox_id, entry]),
  );
}

/**
 * Select one coherent list generation. A completed fast generation is used
 * only while fast lifecycle polling is active, so stale fast data cannot
 * replace a newer slow generation afterward.
 */
export function currentFleetList(
  slow: SandboxList | undefined,
  fast: SandboxList | undefined,
  lifecycleActive: boolean,
): SandboxList | undefined {
  return lifecycleActive ? fast ?? slow : slow;
}

/** Preserve existing card positions and append newly observed records. */
export function stabilizeFleetList(
  list: SandboxList | undefined,
  previousOrder: readonly string[],
): SandboxList | undefined {
  if (!list || previousOrder.length === 0) return list;
  const previousPositions = new Map(
    previousOrder.map((id, index) => [id, index]),
  );
  const incomingPositions = new Map(
    list.sandboxes.map((record, index) => [record.id, index]),
  );

  return {
    ...list,
    sandboxes: [...list.sandboxes].sort((left, right) => {
      const leftPrevious = previousPositions.get(left.id);
      const rightPrevious = previousPositions.get(right.id);
      if (leftPrevious !== undefined && rightPrevious !== undefined) {
        return leftPrevious - rightPrevious;
      }
      if (leftPrevious !== undefined) return -1;
      if (rightPrevious !== undefined) return 1;
      return (
        (incomingPositions.get(left.id) ?? 0) -
        (incomingPositions.get(right.id) ?? 0)
      );
    }),
  };
}

/**
 * Fast fleet-list polling is needed for lifecycle transitions, an in-progress
 * create stream, or confirmed commands on a ready sandbox.
 */
export function hasFleetActivity(
  list: SandboxList | undefined,
  snapshot: SnapshotResult | undefined,
  createLogs: readonly string[] | null | undefined,
): boolean {
  if (createLogs != null) return true;
  const records = list?.sandboxes ?? [];
  if (
    records.some(
      (record) => record.state === "creating" || record.state === "stopping",
    )
  ) {
    return true;
  }

  const readyIds = new Set(
    records.filter((record) => record.state === "ready").map((record) => record.id),
  );
  return (snapshot?.sandboxes ?? []).some(
    (entry) => readyIds.has(entry.sandbox_id) && inFlightCount(entry) > 0,
  );
}

function activeCommandsForRecord(
  record: SandboxRecord,
  snapshot: SandboxSnapshot | undefined,
): number | null {
  if (record.state !== "ready" || snapshot?.sandbox_id !== record.id) return null;
  return inFlightCount(snapshot);
}

export function fleetRecordMatches(
  record: SandboxRecord,
  query: string,
  snapshot?: SandboxSnapshot,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const activeCommands = activeCommandsForRecord(record, snapshot);
  const status = sandboxStatus(record.state, activeCommands);
  return [record.id, record.workspace_root, record.state, status.state, status.label]
    .some((value) => value.toLowerCase().includes(needle));
}

/** Filter without reordering, matching every field promised by the spec. */
export function filterFleetRecords(
  records: readonly SandboxRecord[],
  query: string,
  snapshot?: SnapshotResult | null,
): SandboxRecord[] {
  if (query.trim() === "") return [...records];
  const snapshots = snapshotsBySandbox(snapshot);
  return records.filter((record) =>
    fleetRecordMatches(record, query, snapshots.get(record.id)),
  );
}

export function activeCommandTotal(
  list: SandboxList | undefined,
  snapshot: SnapshotResult | undefined,
): number | null {
  if (!list) return null;
  const readyRecords = list.sandboxes.filter((record) => record.state === "ready");
  if (readyRecords.length === 0) return 0;
  if (!snapshot) return null;

  const snapshots = snapshotsBySandbox(snapshot);
  let total = 0;
  for (const record of readyRecords) {
    const entry = snapshots.get(record.id);
    if (!entry) return null;
    total += inFlightCount(entry);
  }
  return total;
}

/** Build the four truthful Dashboard metrics from confirmed inputs. */
export function dashboardSummary(
  list: SandboxList | undefined,
  snapshot: SnapshotResult | undefined,
  usage: ReadonlyMap<string, SandboxCurrentUsage>,
): FleetSummary {
  if (!list) {
    return {
      total: null,
      ready: null,
      activeCommands: null,
      averageMemoryBytes: null,
    };
  }

  return {
    total: list.sandboxes.length,
    ready: list.sandboxes.filter((record) => record.state === "ready").length,
    activeCommands: activeCommandTotal(list, snapshot),
    averageMemoryBytes: averageMemoryBytes(list.sandboxes, usage),
  };
}

/** Compatibility name for fleet-oriented consumers. */
export const fleetSummary = dashboardSummary;

function primaryActionFor(state: SandboxState): SandboxPrimaryAction | null {
  switch (state) {
    case "ready":
      return { kind: "open", label: "Open", disabled: false };
    case "stopping":
      return { kind: "open", label: "Open", disabled: true };
    case "stopped":
    case "failed":
      return { kind: "inspect", label: "Inspect", disabled: false };
    case "creating":
      return null;
  }
}

/** Derive a card's data-only view model; formatting and navigation stay in UI. */
export function sandboxCardViewModel(
  record: SandboxRecord,
  snapshot: SandboxSnapshot | undefined,
  usage: SandboxCurrentUsage | undefined,
): SandboxCardViewModel {
  const activeCommands = activeCommandsForRecord(record, snapshot);
  const hasCurrentData = record.state === "ready";
  const status = sandboxStatus(record.state, activeCommands);

  return {
    id: record.id,
    workspaceRoot: record.workspace_root,
    lifecycleState: record.state,
    displayState: status.state,
    status,
    cpuPercent: hasCurrentData ? (usage?.cpuPercent ?? null) : null,
    memoryBytes: hasCurrentData ? (usage?.memoryBytes ?? null) : null,
    sessions:
      hasCurrentData && snapshot?.sandbox_id === record.id
        ? snapshot.workspaces.length
        : null,
    activeCommands,
    primaryAction: primaryActionFor(record.state),
  };
}

export const createSandboxCardViewModel = sandboxCardViewModel;
