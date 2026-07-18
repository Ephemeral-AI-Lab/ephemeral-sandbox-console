import { describe, expect, it } from "vitest";
import type { SandboxList, SandboxRecord } from "@/api/types";
import {
  clusterFromCreateResult,
  parseSandboxClusters,
  resolveSandboxClusters,
  type SandboxClusterRecord,
} from "@/core/sandboxClusters";

function record(id: string, workspaceRoot = "/work/shared"): SandboxRecord {
  return {
    id,
    workspace_root: workspaceRoot,
    state: "ready",
    daemon: null,
    daemon_http: null,
    shared_base: null,
    activity_revision: 0,
  };
}

function cluster(memberIds: string[]): SandboxClusterRecord {
  return {
    id: "cluster-batch-a",
    memberIds,
    workspaceRoot: "/work/shared",
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

describe("sandbox cluster identity", () => {
  it("keeps sandbox-mode singles individual and accepts cluster-mode singles", () => {
    const first = record("eos-11111111-a");
    const second = record("eos-22222222-b");
    const createdAt = "2026-07-18T00:00:00.000Z";

    expect(clusterFromCreateResult(first)).toBeNull();
    expect(
      clusterFromCreateResult(first, createdAt, { allowSingleMember: true }),
    ).toEqual({
      id: "cluster-11111111",
      memberIds: [first.id],
      workspaceRoot: "/work/shared",
      createdAt,
    });
    expect(
      clusterFromCreateResult(
        { sandboxes: [first, second] } satisfies SandboxList,
        createdAt,
      ),
    ).toEqual({
      id: "cluster-11111111",
      memberIds: [first.id, second.id],
      workspaceRoot: "/work/shared",
      createdAt,
    });
  });

  it("does not infer a cluster from a shared workspace path", () => {
    const records = [record("individual-a"), record("individual-b")];

    expect(resolveSandboxClusters(records, [])).toEqual({
      clusters: [],
      individuals: records,
    });
  });

  it("groups only registered batch members and leaves unrelated records individual", () => {
    const first = record("batch-a");
    const second = record("batch-b");
    const unrelated = record("unrelated");

    expect(
      resolveSandboxClusters(
        [first, second, unrelated],
        [cluster([first.id, second.id])],
      ),
    ).toEqual({
      clusters: [{ ...cluster([first.id, second.id]), members: [first, second] }],
      individuals: [unrelated],
    });
  });

  it("keeps a lone surviving member in its cluster", () => {
    const survivor = record("batch-a");
    const registered = cluster([survivor.id, "destroyed"]);

    expect(
      resolveSandboxClusters([survivor], [registered]),
    ).toEqual({
      clusters: [{ ...registered, members: [survivor] }],
      individuals: [],
    });
  });

  it("accepts one-member persisted clusters and ignores malformed data", () => {
    expect(parseSandboxClusters(JSON.stringify([cluster(["only-member"])]))).toEqual([
      cluster(["only-member"]),
    ]);
    expect(parseSandboxClusters("not-json")).toEqual([]);
    expect(parseSandboxClusters(JSON.stringify([{ id: "missing-members" }]))).toEqual(
      [],
    );
    expect(parseSandboxClusters(JSON.stringify([cluster([])]))).toEqual([]);
  });
});
