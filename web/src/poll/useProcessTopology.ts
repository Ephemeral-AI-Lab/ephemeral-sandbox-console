import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchTopology,
  type TopologyResult,
  type WorkspaceProcessTopology,
} from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import { FAST_POLL_MS } from "@/poll/usePoll";

export function topologyHasActivity(
  topology: WorkspaceProcessTopology | null | undefined,
): boolean {
  return topology?.available === true &&
    topology.workspaces.some((workspace) => workspace.state === "active");
}

export function shouldRequestProcessTopology(
  record: SandboxRecord | null,
  result: TopologyResult | undefined,
  lastRequestedRevision: number | null | undefined,
): boolean {
  if (record?.state !== "ready") return false;
  if (result === undefined) {
    if (lastRequestedRevision === undefined) return true;
    return typeof record.activity_revision === "number" &&
      record.activity_revision !== lastRequestedRevision;
  }
  if (topologyHasActivity(result.topology)) return true;
  return typeof record.activity_revision === "number" &&
    record.activity_revision !== lastRequestedRevision;
}

/**
 * Processes is the only ordinary Console consumer of daemon topology. It
 * resolves once, polls only while workload topology is active, and otherwise
 * waits for a manager activity revision or an explicit refresh.
 *
 * Returning from a hidden tab first waits for the parent manager record query
 * to complete. The topology query itself never refetches merely due to focus.
 */
export function useProcessTopology(
  sandboxId: string,
  record: SandboxRecord | null,
  recordUpdatedAt?: number,
) {
  const visibility = useDocumentVisibility(recordUpdatedAt);
  const lastRequest = useRef<{
    sandboxId: string;
    revision: number | null;
  } | null>(null);
  const lastRequestedRevision = lastRequest.current?.sandboxId === sandboxId
    ? lastRequest.current.revision
    : undefined;
  const managerCheckedSinceFocus = visibility.managerCheckFloor === null ||
    (typeof recordUpdatedAt === "number" &&
      recordUpdatedAt > visibility.managerCheckFloor);

  const query = useQuery<TopologyResult, Error>({
    queryKey: ["observability", sandboxId, "topology"],
    queryFn: async ({ signal }) => {
      const revision = record?.activity_revision;
      // Record the attempt before I/O so an unavailable daemon cannot create
      // an idle retry loop. A later manager revision can attempt once again.
      lastRequest.current = {
        sandboxId,
        revision: typeof revision === "number" ? revision : null,
      };
      return fetchTopology(sandboxId, signal);
    },
    enabled: (queryState) =>
      visibility.visible &&
      managerCheckedSinceFocus &&
      sandboxId !== "" &&
      record?.id === sandboxId &&
      shouldRequestProcessTopology(
        record,
        queryState.state.data,
        lastRequestedRevision,
      ),
    retry: false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchInterval: (queryState) =>
      visibility.visible &&
      managerCheckedSinceFocus &&
      topologyHasActivity(queryState.state.data?.topology)
        ? FAST_POLL_MS
        : false,
  });

  return {
    ...query,
    canRefresh: visibility.visible &&
      managerCheckedSinceFocus &&
      record?.id === sandboxId &&
      record.state === "ready",
    refresh: query.refetch,
  };
}

interface DocumentVisibility {
  visible: boolean;
  managerCheckFloor: number | null;
}

function useDocumentVisibility(recordUpdatedAt?: number): DocumentVisibility {
  const recordUpdatedAtRef = useRef(recordUpdatedAt);
  recordUpdatedAtRef.current = recordUpdatedAt;
  const [visibility, setVisibility] = useState<DocumentVisibility>(() => {
    const visible = typeof document === "undefined" || !document.hidden;
    return {
      visible,
      managerCheckFloor: visible ? null : (recordUpdatedAt ?? 0),
    };
  });

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const update = () => {
      const visible = !document.hidden;
      setVisibility((current) => {
        if (visible === current.visible) return current;
        return {
          visible,
          // A manager response completed while hidden must not count as the
          // focus check. Capture the current manager timestamp atomically with
          // the visibility event and wait for a newer successful inspect.
          managerCheckFloor: visible
            ? (recordUpdatedAtRef.current ?? 0)
            : current.managerCheckFloor,
        };
      });
    };
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visibility;
}
