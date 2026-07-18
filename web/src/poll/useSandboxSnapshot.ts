import { useRef } from "react";
import type { SandboxRecord } from "@/api/types";
import {
  fetchSandboxSnapshot,
  type SnapshotResult,
} from "@/api/observability";
import {
  shouldRequestSandboxSnapshot,
  snapshotPollingMode,
} from "@/core/activity";
import { usePoll } from "@/poll/usePoll";

export {
  shouldRequestSandboxSnapshot,
  snapshotHasActivity,
  snapshotPollingMode,
} from "@/core/activity";

/**
 * Daemon snapshot polling is revision-gated. Manager record polling discovers
 * mutations; this query runs once initially, once per new revision, or while a
 * previously returned snapshot says an execution is active. An idle disabled
 * query is not refetched merely because the browser regains focus.
 */
export function useSandboxSnapshot(
  sandboxId: string,
  record: SandboxRecord | null,
) {
  const lastSnapshotRevision = useRef<number | null | undefined>(undefined);
  return usePoll<SnapshotResult>({
    key: ["sandbox", sandboxId, "snapshot"],
    fn: async (signal) => {
      const revision = record?.activity_revision;
      // Record the attempt before I/O. A failed initial lookup must not become
      // an unbounded idle retry loop, but a later revision may try once again.
      lastSnapshotRevision.current = typeof revision === "number" ? revision : null;
      const result = await fetchSandboxSnapshot(sandboxId, signal);
      return result;
    },
    mode: (data) => snapshotPollingMode(record, data),
    enabled: (data) =>
      sandboxId !== "" &&
      shouldRequestSandboxSnapshot(record, data, lastSnapshotRevision.current),
    refetchOnWindowFocus: false,
  });
}
