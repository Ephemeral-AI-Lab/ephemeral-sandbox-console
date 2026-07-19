import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonView } from "@/pages/sandbox/observability/DaemonView";

const mocks = vi.hoisted(() => ({
  fetchSandboxResources: vi.fn(),
  fetchDaemonSelf: vi.fn(),
  fetchTopology: vi.fn(),
  fetchCgroup: vi.fn(),
  readDaemonCapture: vi.fn(),
  appendDaemonCapture: vi.fn(),
  clearDaemonCapture: vi.fn(),
}));

vi.mock("@/api/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/observability")>()),
  fetchSandboxResources: mocks.fetchSandboxResources,
  fetchDaemonSelf: mocks.fetchDaemonSelf,
  fetchTopology: mocks.fetchTopology,
  fetchCgroup: mocks.fetchCgroup,
}));

vi.mock("@/core/daemonCaptureStore", () => ({
  readDaemonCapture: mocks.readDaemonCapture,
  appendDaemonCapture: mocks.appendDaemonCapture,
  clearDaemonCapture: mocks.clearDaemonCapture,
}));

vi.mock("@/pages/sandbox/SandboxContext", () => ({
  useSandbox: () => ({ sandboxId: "sandbox-a", record: null, snapshot: null, recordError: null }),
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={["/daemon"]}>
        <MantineProvider>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </MantineProvider>
      </MemoryRouter>
    );
  };
}

async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("daemon diagnostic capture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchSandboxResources.mockReset();
    mocks.fetchSandboxResources.mockResolvedValue(resourcesResponse());
    mocks.fetchDaemonSelf.mockReset();
    mocks.fetchDaemonSelf.mockResolvedValue(daemonResponse());
    mocks.fetchTopology.mockReset();
    mocks.fetchCgroup.mockReset();
    mocks.readDaemonCapture.mockReset();
    mocks.readDaemonCapture.mockResolvedValue([]);
    mocks.appendDaemonCapture.mockReset();
    mocks.appendDaemonCapture.mockResolvedValue(undefined);
    mocks.clearDaemonCapture.mockReset();
    mocks.clearDaemonCapture.mockResolvedValue(undefined);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("shows process and container memory, and pauses explicit polling", async () => {
    const view = render(<DaemonView />, { wrapper: createWrapper() });
    await flush();
    await flush();
    await flush();

    expect(mocks.fetchSandboxResources).toHaveBeenCalledWith(
      "sandbox-a",
      60_000,
      expect.any(AbortSignal),
    );
    expect(mocks.fetchDaemonSelf).toHaveBeenCalledWith(
      "sandbox-a",
      expect.any(AbortSignal),
    );
    expect(mocks.fetchTopology).not.toHaveBeenCalled();
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();
    expect(screen.getByText("Daemon diagnostic capture")).toBeTruthy();
    expect(screen.getByText("no managed namespaces")).toBeTruthy();
    expect(screen.getByText("71MiB")).toBeTruthy();
    expect(screen.getAllByText("29MiB").length).toBeGreaterThan(0);
    expect(screen.getByText("+25MiB")).toBeTruthy();
    expect(mocks.appendDaemonCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 / 900")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const resourceCallsAfterPause = mocks.fetchSandboxResources.mock.calls.length;
    const daemonCallsAfterPause = mocks.fetchDaemonSelf.mock.calls.length;
    await flush(10_000);
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(resourceCallsAfterPause);
    expect(mocks.fetchDaemonSelf).toHaveBeenCalledTimes(daemonCallsAfterPause);
    expect(mocks.fetchTopology).not.toHaveBeenCalled();
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();

    view.unmount();
  });
});

function resourcesResponse() {
  return {
    view: "resources" as const,
    scope: "sandbox",
    sandbox_id: "sandbox-a",
    availability: "available" as const,
    errors: [],
    series: [{
      ts: 1_700_000_000_000,
      sample_delta_ms: 2_000,
      metrics: { mem_cur: 74_000_000 },
      deltas: {},
    }],
  };
}

function daemonResponse() {
  return {
    view: "daemon" as const,
    scope: "sandbox",
    daemon: {
      available: true,
      error: null,
      sampled_at_unix_ms: 1_700_000_000_000,
      pid: 8,
      name: "sandbox-daemon",
      state: "S (sleeping)",
      virtual_memory_bytes: 120_000_000,
      resident_memory_bytes: 30_000_000,
      peak_resident_memory_bytes: 32_000_000,
      proportional_set_size_bytes: 28_000_000,
      unique_set_size_bytes: 26_000_000,
      anonymous_memory_bytes: 25_000_000,
      file_memory_bytes: 4_000_000,
      shared_memory_bytes: 1_000_000,
      data_memory_bytes: 27_000_000,
      swap_bytes: 0,
      cpu_time_us: 1_000_000,
      start_time_ticks: 123,
      thread_count: 37,
      file_descriptor_count: 15,
      io_read_bytes: 4_096,
      io_write_bytes: 8_192,
      read_syscalls: 41,
      write_syscalls: 17,
      voluntary_context_switches: 120,
      involuntary_context_switches: 3,
      cgroup_memberships: ["0::/_daemon"],
      warnings: [],
      runtime_usage: { active_commands: 0 },
      ownership: { open_workspaces: 0 },
    },
  };
}
