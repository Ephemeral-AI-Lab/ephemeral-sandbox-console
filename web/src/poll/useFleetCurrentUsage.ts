import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchFleetResources } from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import {
  currentUsageFromSeries,
  type SandboxCurrentUsage,
} from "@/core/resources";
import { SLOW_POLL_MS } from "@/poll/usePoll";

export { currentUsageFromSeries } from "@/core/resources";
export type { SandboxCurrentUsage } from "@/core/resources";

export function useFleetCurrentUsage(records: SandboxRecord[]) {
  const query = useQuery({
    queryKey: ["fleet", "current-usage"],
    queryFn: ({ signal }) => fetchFleetResources(signal),
    enabled: records.some((record) => record.state === "ready"),
    retry: false,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
    refetchIntervalInBackground: false,
    refetchInterval: SLOW_POLL_MS,
  });

  const data = new Map<string, SandboxCurrentUsage>();
  records.forEach((record) => {
    if (record.state !== "ready") return;
    const current = query.data?.sandboxes[record.id]?.current;
    if (current) data.set(record.id, currentUsageFromSeries([current]));
  });

  return {
    data,
    isFetching: query.isFetching,
    error: query.error ?? null,
  };
}
