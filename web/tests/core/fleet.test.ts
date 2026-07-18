import { describe, expect, it } from "vitest";
import type { SandboxSnapshot, SnapshotResult } from "@/api/observability";
import type { SandboxList, SandboxRecord } from "@/api/types";
import {
  currentFleetList,
  dashboardSummary,
  filterFleetRecords,
  hasFleetActivity,
  sandboxCardViewModel,
  stabilizeFleetList,
} from "@/core/fleet";
import type { SandboxCurrentUsage } from "@/core/resources";

function record(
  id: string,
  state: SandboxRecord["state"] = "ready",
  workspaceRoot = `/work/${id}`,
): SandboxRecord {
  return {
    id,
    workspace_root: workspaceRoot,
    state,
    daemon: null,
    daemon_http: null,
    shared_base: null,
    activity_revision: 0,
  };
}

function snapshot(id: string, commands = 0, sessions = 1): SandboxSnapshot {
  return {
    sandbox_id: id,
    lifecycle_state: "ready",
    availability: "available",
    sampled_at_unix_ms: 1,
    errors: [],
    daemon: null,
    resources: { latest: null, history: [] },
    workspaces: Array.from({ length: sessions }, (_, workspaceIndex) => ({
      workspace_id: `workspace-${workspaceIndex}`,
      lifecycle_state: "active",
      finalization_state: "active" as const,
      network_profile: "shared" as const,
      layers: { base_root_hash: "root", layer_count: 0 },
      namespace_fd_count: 0,
      resources: { latest: null, history: [] },
      active_namespace_executions: workspaceIndex === 0
        ? Array.from({ length: commands }, (_, commandIndex) => ({
            namespace_execution_id: `command-${commandIndex}`,
            operation: "exec_command",
            lifecycle_state: "running",
          }))
        : [],
    })),
    stack: { layer_count: 0, layers_bytes: 0, active_leases: 0 },
  };
}

const slow: SandboxList = { sandboxes: [record("current")] };
const fast: SandboxList = { sandboxes: [record("new", "creating")] };

describe("fleet list policy", () => {
  it("uses fast data only while fast polling is active", () => {
    expect(currentFleetList(slow, fast, true)).toBe(fast);
    expect(currentFleetList(slow, fast, false)).toBe(slow);
    expect(currentFleetList(slow, undefined, true)).toBe(slow);
  });

  it("keeps known cards stable and appends new records in incoming order", () => {
    const incoming = {
      sandboxes: [record("new-a"), record("known-b"), record("known-a"), record("new-b")],
    };
    expect(
      stabilizeFleetList(incoming, ["known-a", "known-b"])?.sandboxes.map(({ id }) => id),
    ).toEqual(["known-a", "known-b", "new-a", "new-b"]);
  });

  it("detects only create/transitional/ready-command fleet activity", () => {
    expect(hasFleetActivity(slow, undefined, [])).toBe(true);
    expect(hasFleetActivity(fast, undefined, null)).toBe(true);
    expect(
      hasFleetActivity(slow, { sandboxes: [snapshot("current", 1)] }, null),
    ).toBe(true);
    expect(
      hasFleetActivity(
        { sandboxes: [record("current", "stopped")] },
        { sandboxes: [snapshot("current", 1)] },
        null,
      ),
    ).toBe(false);
  });
});

describe("fleet filtering", () => {
  const records = [
    record("alpha-ready", "ready", "/workspaces/Ada/Project One"),
    record("beta-building", "creating", "/srv/build"),
    record("gamma", "failed", "/srv/problem"),
  ];
  const snapshots: SnapshotResult = {
    sandboxes: [snapshot("alpha-ready", 2)],
  };

  it("matches ID, lifecycle state, derived display state, and workspace case-insensitively", () => {
    expect(filterFleetRecords(records, "ALPHA", snapshots).map(({ id }) => id)).toEqual([
      "alpha-ready",
    ]);
    expect(filterFleetRecords(records, "creating", snapshots).map(({ id }) => id)).toEqual([
      "beta-building",
    ]);
    expect(filterFleetRecords(records, "active", snapshots).map(({ id }) => id)).toEqual([
      "alpha-ready",
    ]);
    expect(filterFleetRecords(records, "project one", snapshots).map(({ id }) => id)).toEqual([
      "alpha-ready",
    ]);
    expect(filterFleetRecords(records, "ready", snapshots).map(({ id }) => id)).toEqual([
      "alpha-ready",
    ]);
  });

  it("keeps source order and treats whitespace-only input as no filter", () => {
    expect(filterFleetRecords(records, "   ").map(({ id }) => id)).toEqual(
      records.map(({ id }) => id),
    );
  });
});

describe("fleet summaries and cards", () => {
  const records = [record("one"), record("two"), record("failed", "failed")];
  const list = { sandboxes: records };
  const snapshots = { sandboxes: [snapshot("one", 2, 3), snapshot("two", 1, 1)] };
  const usage = new Map<string, SandboxCurrentUsage>([
    ["one", { cpuPercent: 1.5, memoryBytes: 100, sampledAt: 1 }],
    ["two", { cpuPercent: null, memoryBytes: 300, sampledAt: 1 }],
  ]);

  it("uses unknown metrics before a list is confirmed", () => {
    expect(dashboardSummary(undefined, undefined, new Map())).toEqual({
      total: null,
      ready: null,
      activeCommands: null,
      averageMemoryBytes: null,
    });
  });

  it("reports a confirmed empty fleet without inventing a memory sample", () => {
    expect(dashboardSummary({ sandboxes: [] }, undefined, new Map())).toEqual({
      total: 0,
      ready: 0,
      activeCommands: 0,
      averageMemoryBytes: null,
    });
  });

  it("keeps active commands unknown until every ready snapshot resolves", () => {
    expect(
      dashboardSummary(list, { sandboxes: [snapshot("one", 2)] }, usage),
    ).toMatchObject({ activeCommands: null });
  });

  it("sums commands and averages only available memory samples", () => {
    expect(dashboardSummary(list, snapshots, usage)).toEqual({
      total: 3,
      ready: 2,
      activeCommands: 3,
      averageMemoryBytes: 200,
    });
  });

  it("builds a ready/active card with live data and an Open action", () => {
    expect(sandboxCardViewModel(records[0]!, snapshots.sandboxes[0], usage.get("one")))
      .toMatchObject({
        id: "one",
        lifecycleState: "ready",
        displayState: "active",
        cpuPercent: 1.5,
        memoryBytes: 100,
        sessions: 3,
        activeCommands: 2,
        primaryAction: { kind: "open", label: "Open", disabled: false },
        status: { label: "Active", tone: "active", pulse: true },
      });
  });

  it("keeps missing live values unknown and ignores stale data for non-ready cards", () => {
    expect(sandboxCardViewModel(record("ready"), undefined, undefined)).toMatchObject({
      sessions: null,
      activeCommands: null,
      cpuPercent: null,
      memoryBytes: null,
      displayState: "ready",
    });
    expect(
      sandboxCardViewModel(
        record("failed", "failed"),
        snapshot("failed", 4, 2),
        { cpuPercent: 5, memoryBytes: 10, sampledAt: 1 },
      ),
    ).toMatchObject({
      sessions: null,
      activeCommands: null,
      cpuPercent: null,
      memoryBytes: null,
      primaryAction: { kind: "inspect", label: "Inspect", disabled: false },
    });
  });

  it("disables Open while stopping and exposes Inspect after stop", () => {
    expect(sandboxCardViewModel(record("a", "stopping"), undefined, undefined).primaryAction)
      .toEqual({ kind: "open", label: "Open", disabled: true });
    expect(sandboxCardViewModel(record("a", "stopped"), undefined, undefined).primaryAction)
      .toEqual({ kind: "inspect", label: "Inspect", disabled: false });
    expect(sandboxCardViewModel(record("a", "creating"), undefined, undefined).primaryAction)
      .toBeNull();
  });
});
