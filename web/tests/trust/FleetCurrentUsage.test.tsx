import { act, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FleetResourcesResult,
  ResourceSample,
  SandboxSnapshot,
} from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import { SandboxCard } from "@/pages/fleet/SandboxCard";
import {
  currentUsageFromSeries,
  useFleetCurrentUsage,
} from "@/poll/useFleetCurrentUsage";

const mocks = vi.hoisted(() => ({
  fetchFleetResources: vi.fn(),
  fetchCgroup: vi.fn(),
}));

vi.mock("@/api/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/observability")>()),
  fetchFleetResources: mocks.fetchFleetResources,
  fetchCgroup: mocks.fetchCgroup,
}));

function record(id: string, state: SandboxRecord["state"] = "ready"): SandboxRecord {
  return {
    id,
    workspace_root: `/work/${id}`,
    state,
    daemon: null,
    daemon_http: null,
    shared_base: null,
    activity_revision: 0,
  };
}

function sample(
  ts: number,
  sampleDeltaMs: number,
  cpuDelta: number,
  memory: number,
): ResourceSample {
  return {
    ts,
    sample_delta_ms: sampleDeltaMs,
    metrics: { mem_cur: memory },
    deltas: { cpu_usec: cpuDelta },
  };
}

function fleetResources(
  samples: Record<string, ResourceSample | null>,
): FleetResourcesResult {
  return {
    view: "resources",
    scope: "fleet",
    availability: "available",
    errors: [],
    sandboxes: Object.fromEntries(Object.entries(samples).map(([id, current]) => [
      id,
      { availability: "available", errors: [], current },
    ])),
  };
}

function snapshot(id: string): SandboxSnapshot {
  return {
    sandbox_id: id,
    lifecycle_state: "ready",
    availability: "available",
    sampled_at_unix_ms: 1,
    errors: [],
    daemon: null,
    resources: { latest: null, history: [] },
    workspaces: [],
    stack: { layer_count: 0, layers_bytes: 0, active_leases: 0 },
  };
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <MantineProvider>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </MantineProvider>
      </MemoryRouter>
    );
  };
}

function Harness({ records }: { records: SandboxRecord[] }) {
  const usage = useFleetCurrentUsage(records);
  return <div>{usage.data.get("sandbox-a")?.memoryBytes ?? "unavailable"}</div>;
}

async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("Fleet current usage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchFleetResources.mockReset();
    mocks.fetchFleetResources.mockResolvedValue(
      fleetResources({
        "sandbox-a": sample(1_005, 2_000, 20_000, 21_000_000),
      }),
    );
    mocks.fetchCgroup.mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the newest memory gauge and newest stable CPU interval", () => {
    expect(
      currentUsageFromSeries([
        sample(1_000, 2_000, 20_000, 20_000_000),
        sample(1_005, 5, 0, 21_000_000),
      ]),
    ).toEqual({
      cpuPercent: 1,
      memoryBytes: 21_000_000,
      sampledAt: 1_005,
    });
  });

  it("uses one manager fleet request per cadence independent of ready count", async () => {
    const records = Array.from({ length: 10_000 }, (_, index) => record(
      index === 0 ? "sandbox-a" : `sandbox-${index}`,
    ));
    records.push(record("failed-sandbox", "failed"));
    render(<Harness records={records} />, {
      wrapper: createWrapper(),
    });
    await flush();

    expect(mocks.fetchFleetResources).toHaveBeenCalledTimes(1);
    expect(mocks.fetchFleetResources).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();
    expect(screen.getByText("21000000")).toBeTruthy();

    await flush(2_000);
    expect(mocks.fetchFleetResources).toHaveBeenCalledTimes(2);
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();
  });

  it("drops cached current usage when a sandbox leaves ready", async () => {
    const view = render(<Harness records={[record("sandbox-a")]} />, {
      wrapper: createWrapper(),
    });
    await flush();
    expect(screen.getByText("21000000")).toBeTruthy();

    view.rerender(<Harness records={[record("sandbox-a", "stopping")]} />);
    expect(screen.getByText("unavailable")).toBeTruthy();
  });

  it("renders current values without CPU or memory history graphics", () => {
    render(
      <SandboxCard
        record={record("sandbox-a")}
        snapshot={snapshot("sandbox-a")}
        usage={{ cpuPercent: 1, memoryBytes: 21_000_000, sampledAt: 1_005 }}
        createLogs={undefined}
      />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("MEM")).toBeTruthy();
    expect(screen.getByText("1.0%")).toBeTruthy();
    expect(screen.getByText("20MiB")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "CPU history" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Memory history" })).toBeNull();
  });
});
