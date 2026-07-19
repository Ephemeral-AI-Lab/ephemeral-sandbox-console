import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { fetchSandboxResources } from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import {
  currentUsageFromSeries,
  type SandboxCurrentUsage,
} from "@/core/resources";
import { SLOW_POLL_MS } from "@/poll/usePoll";

export { currentUsageFromSeries } from "@/core/resources";
export type { SandboxCurrentUsage } from "@/core/resources";

export const FLEET_USAGE_WINDOW_MS = 10_000;

export function useFleetCurrentUsage(records: SandboxRecord[]) {
  const queries = useQueries({
    queries: records.map((record) => ({
      queryKey: ["sandbox", record.id, "current-usage"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchSandboxResources(record.id, FLEET_USAGE_WINDOW_MS, signal),
      enabled: record.state === "ready",
      retry: false,
      placeholderData: keepPreviousData,
      refetchOnWindowFocus: "always" as const,
      refetchIntervalInBackground: false,
      refetchInterval: SLOW_POLL_MS,
    })),
  });

  const data = new Map<string, SandboxCurrentUsage>();
  records.forEach((record, index) => {
    const series = queries[index]?.data?.series;
    if (record.state === "ready" && series) {
      data.set(record.id, currentUsageFromSeries(series));
    }
  });

  return {
    data,
    isFetching: queries.some((query) => query.isFetching),
    error: queries.find((query) => query.error)?.error ?? null,
  };
}
