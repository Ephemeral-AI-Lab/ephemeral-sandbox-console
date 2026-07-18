import { describe, expect, it } from "vitest";
import type { SandboxSnapshot, SnapshotResult } from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import {
  shouldRequestSandboxSnapshot,
  snapshotActiveCommandCount,
  snapshotHasActivity,
  snapshotPollingMode,
} from "@/core/activity";

function record(state: SandboxRecord["state"] = "ready", revision = 7): SandboxRecord {
  return {
    id: "sandbox-a",
    workspace_root: "/work/a",
    state,
    daemon: null,
    daemon_http: null,
    shared_base: null,
    activity_revision: revision,
  };
}

function result({ commands = 0, leases = 0, sampledAt = 1 } = {}): SnapshotResult {
  const sandbox: SandboxSnapshot = {
    sandbox_id: "sandbox-a",
    lifecycle_state: "ready",
    availability: "available",
    sampled_at_unix_ms: sampledAt,
    errors: [],
    daemon: null,
    resources: { latest: null, history: [] },
    workspaces: [
      {
        workspace_id: "workspace-a",
        lifecycle_state: "active",
        network_profile: "shared",
        layers: { base_root_hash: "root", layer_count: 0 },
        namespace_fd_count: 0,
        resources: { latest: null, history: [] },
        active_namespace_executions: Array.from({ length: commands }, (_, index) => ({
          namespace_execution_id: `command-${index}`,
          operation: "exec_command",
          lifecycle_state: "running",
        })),
      },
    ],
    stack: { layer_count: 0, layers_bytes: 0, active_leases: leases },
  };
  return { sandboxes: [sandbox] };
}

describe("snapshot activity policy", () => {
  it("recognizes commands and leases only while the manager record is ready", () => {
    expect(snapshotHasActivity(record(), result({ commands: 1 }))).toBe(true);
    expect(snapshotHasActivity(record(), result({ leases: 1 }))).toBe(true);
    expect(snapshotHasActivity(record("stopping"), result({ commands: 1 }))).toBe(false);
    expect(snapshotHasActivity(record(), result())).toBe(false);
  });

  it("requests initially, on revision changes, and while active", () => {
    expect(shouldRequestSandboxSnapshot(record(), undefined, undefined)).toBe(true);
    expect(shouldRequestSandboxSnapshot(record(), undefined, 7)).toBe(false);
    expect(shouldRequestSandboxSnapshot(record(), result(), 7)).toBe(false);
    expect(shouldRequestSandboxSnapshot(record("ready", 8), result(), 7)).toBe(true);
    expect(
      shouldRequestSandboxSnapshot(record(), result({ commands: 1 }), 7),
    ).toBe(true);
    expect(
      shouldRequestSandboxSnapshot(record("stopping"), result({ commands: 1 }), 6),
    ).toBe(false);
  });

  it("chooses fast polling only for confirmed activity", () => {
    expect(snapshotPollingMode(record(), result({ commands: 1 }))).toBe("fast");
    expect(snapshotPollingMode(record(), result())).toBe("slow");
    expect(snapshotPollingMode(record(), undefined)).toBe("slow");
  });

  it("keeps the active-command count unknown until the matching snapshot resolves", () => {
    expect(snapshotActiveCommandCount(record(), undefined)).toBeNull();
    expect(snapshotActiveCommandCount(record(), result({ commands: 2 }))).toBe(2);
    expect(snapshotActiveCommandCount(record("failed"), result({ commands: 2 }))).toBeNull();
  });
});
