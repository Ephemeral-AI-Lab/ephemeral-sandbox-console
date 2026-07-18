import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonView } from "@/pages/sandbox/observability/DaemonView";

const mocks = vi.hoisted(() => ({
  fetchCgroup: vi.fn(),
  readDaemonCapture: vi.fn(),
  appendDaemonCapture: vi.fn(),
  clearDaemonCapture: vi.fn(),
}));

vi.mock("@/api/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/observability")>()),
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
    mocks.fetchCgroup.mockReset();
    mocks.fetchCgroup.mockResolvedValue(response());
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

    expect(mocks.fetchCgroup).toHaveBeenCalledWith(
      "sandbox-a",
      "sandbox",
      60_000,
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Daemon diagnostic capture")).toBeTruthy();
    expect(screen.getByText("no managed namespaces")).toBeTruthy();
    expect(screen.getByText("71MiB")).toBeTruthy();
    expect(screen.getAllByText("29MiB").length).toBeGreaterThan(0);
    expect(screen.getByText("+25MiB")).toBeTruthy();
    expect(mocks.appendDaemonCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 / 900")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const callsAfterPause = mocks.fetchCgroup.mock.calls.length;
    await flush(10_000);
    expect(mocks.fetchCgroup).toHaveBeenCalledTimes(callsAfterPause);

    view.unmount();
  });
});

function response() {
  return {
    view: "cgroup" as const,
    scope: "sandbox",
    series: [{
      ts: 1_700_000_000_000,
      sample_delta_ms: 2_000,
      metrics: { mem_cur: 74_000_000 },
      deltas: {},
    }],
    topology: {
      schema_version: 2 as const,
      available: true,
      source: "proc_namespaces" as const,
      error: null,
      truncated: false,
      warnings: [],
      workspaces: [],
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
      },
    },
  };
}
