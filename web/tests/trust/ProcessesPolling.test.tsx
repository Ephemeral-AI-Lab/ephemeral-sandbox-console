import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonProcessMetrics,
  WorkspaceProcessTopology,
} from "@/api/observability";
import type { SandboxRecord } from "@/api/types";
import { CgroupView } from "@/pages/sandbox/observability/CgroupView";

const mocks = vi.hoisted(() => ({
  fetchCgroup: vi.fn(),
  fetchTopology: vi.fn(),
  context: {
    sandboxId: "sandbox-a",
    record: null as SandboxRecord | null,
    snapshot: null,
    recordError: null,
    recordUpdatedAt: 100,
  },
}));

vi.mock("@/api/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/observability")>()),
  fetchCgroup: mocks.fetchCgroup,
  fetchTopology: mocks.fetchTopology,
}));

vi.mock("@/pages/sandbox/SandboxContext", () => ({
  useSandbox: () => mocks.context,
}));

const readyRecord: SandboxRecord = {
  id: "sandbox-a",
  workspace_root: "/work",
  state: "ready",
  daemon: null,
  daemon_http: null,
  shared_base: null,
  activity_revision: 0,
};

function topology(
  state: "active" | "idle" | "partial" = "idle",
  sampledAt = 1,
): WorkspaceProcessTopology {
  return {
    schema_version: 2,
    available: true,
    source: "proc_namespaces",
    error: null,
    truncated: false,
    warnings: [],
    workspaces: [
      {
        workspace_id: "workspace-a",
        state,
        holder_pid: 101,
        pid_namespace: "pid:[1]",
        mount_namespace: "mnt:[2]",
        processes: [
          {
            pid: 101,
            namespace_pid: 1,
            parent_pid: 1,
            name: "sandbox-daemon",
            state: "S (sleeping)",
            kind: "namespace_init",
            cgroup_memberships: [],
            resident_memory_bytes: 1_024,
            cpu_time_us: sampledAt * 10,
            start_time_ticks: 11,
          },
          ...(state === "active"
            ? [
                {
                  pid: 102,
                  namespace_pid: 2,
                  parent_pid: 101,
                  name: "worker",
                  state: "S (sleeping)",
                  kind: "process" as const,
                  cgroup_memberships: [],
                  resident_memory_bytes: 2_048,
                  cpu_time_us: sampledAt * 20,
                  start_time_ticks: 12,
                },
              ]
            : []),
        ],
      },
    ],
    daemon: daemonMetrics(sampledAt),
  };
}

function daemonMetrics(sampledAt: number): DaemonProcessMetrics {
  return {
    available: true,
    error: null,
    sampled_at_unix_ms: sampledAt,
    pid: 8,
    name: "sandbox-daemon",
    state: "S (sleeping)",
    virtual_memory_bytes: 10_000 + sampledAt,
    resident_memory_bytes: 9_000 + sampledAt,
    peak_resident_memory_bytes: 9_500 + sampledAt,
    proportional_set_size_bytes: 8_000 + sampledAt,
    unique_set_size_bytes: 7_000 + sampledAt,
    anonymous_memory_bytes: 6_000 + sampledAt,
    file_memory_bytes: 1_000,
    shared_memory_bytes: 500,
    data_memory_bytes: 5_000,
    swap_bytes: 0,
    cpu_time_us: 1_000 + sampledAt,
    start_time_ticks: 10,
    thread_count: 2,
    file_descriptor_count: 3,
    io_read_bytes: sampledAt,
    io_write_bytes: sampledAt,
    read_syscalls: sampledAt,
    write_syscalls: sampledAt,
    voluntary_context_switches: sampledAt,
    involuntary_context_switches: sampledAt,
    cgroup_memberships: [],
    warnings: [],
  };
}

function response(value: WorkspaceProcessTopology) {
  return {
    view: "topology" as const,
    scope: "sandbox" as const,
    topology: value,
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
      <MemoryRouter initialEntries={["/cgroup"]}>
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

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("revision-gated Processes polling", () => {
  let nextTopology: WorkspaceProcessTopology;

  beforeEach(() => {
    vi.useFakeTimers();
    nextTopology = topology("idle");
    mocks.context.sandboxId = "sandbox-a";
    mocks.context.record = structuredClone(readyRecord);
    mocks.context.recordUpdatedAt = 100;
    mocks.fetchCgroup.mockReset();
    mocks.fetchCgroup.mockResolvedValue({
      view: "cgroup",
      scope: "sandbox",
      series: [],
      topology: nextTopology,
    });
    mocks.fetchTopology.mockReset();
    mocks.fetchTopology.mockImplementation(async () =>
      response(structuredClone(nextTopology)),
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  it("uses only explicit topology and stops after resolving an idle page", async () => {
    render(<CgroupView />, { wrapper: createWrapper() });
    await flush();

    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);
    expect(mocks.fetchTopology).toHaveBeenCalledWith(
      "sandbox-a",
      expect.any(AbortSignal),
    );
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();

    await flush(30_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);
  });

  it("does not turn a stable partial result into a polling loop", async () => {
    nextTopology = topology("partial");
    render(<CgroupView />, { wrapper: createWrapper() });
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    await flush(30_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);
  });

  it("polls active topology until idle without treating timestamp or counters as activity", async () => {
    nextTopology = topology("active", 1);
    render(<CgroupView />, { wrapper: createWrapper() });
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    nextTopology = topology("idle", 2);
    await flush(400);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(2);

    nextTopology = topology("idle", 99_999);
    await flush(30_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(2);
  });

  it("stops an active cadence while hidden and resumes only after the manager check", async () => {
    nextTopology = topology("active", 1);
    const view = render(<CgroupView />, { wrapper: createWrapper() });
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    setHidden(true);
    focusManager.setFocused(false);
    await flush(10_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    setHidden(false);
    focusManager.setFocused(true);
    await flush(10_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    mocks.context.recordUpdatedAt = 200;
    view.rerender(<CgroupView />);
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(2);
  });

  it("requests exactly once for a manager revision and direct refresh", async () => {
    const view = render(<CgroupView />, { wrapper: createWrapper() });
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    mocks.context.record = { ...readyRecord, activity_revision: 1 };
    mocks.context.recordUpdatedAt = 200;
    view.rerender(<CgroupView />);
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(2);

    await flush(10_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh process topology" }));
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(3);

    await flush(10_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(3);
  });

  it("does not poll while hidden and waits for the manager focus check", async () => {
    setHidden(true);
    focusManager.setFocused(false);
    const view = render(<CgroupView />, { wrapper: createWrapper() });
    await flush(10_000);
    expect(mocks.fetchTopology).not.toHaveBeenCalled();

    // A manager response that finished while hidden must not count as the
    // focus check which orders the next daemon request.
    mocks.context.recordUpdatedAt = 150;
    view.rerender(<CgroupView />);
    setHidden(false);
    focusManager.setFocused(true);
    await flush(10_000);
    expect(mocks.fetchTopology).not.toHaveBeenCalled();

    mocks.context.recordUpdatedAt = 200;
    view.rerender(<CgroupView />);
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    setHidden(true);
    focusManager.setFocused(false);
    await flush(10_000);
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(1);

    setHidden(false);
    focusManager.setFocused(true);
    await flush();
    mocks.context.record = { ...readyRecord, activity_revision: 1 };
    mocks.context.recordUpdatedAt = 300;
    view.rerender(<CgroupView />);
    await flush();
    expect(mocks.fetchTopology).toHaveBeenCalledTimes(2);
  });
});
