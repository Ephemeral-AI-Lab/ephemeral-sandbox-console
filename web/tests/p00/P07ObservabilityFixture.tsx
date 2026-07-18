import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Box, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { EventsView } from "../../src/pages/sandbox/observability/EventsView";
import { DaemonView } from "../../src/pages/sandbox/observability/DaemonView";
import { LayerStackView } from "../../src/pages/sandbox/observability/LayerStackView";
import { ResourcesView } from "../../src/pages/sandbox/observability/ResourcesView";
import { CgroupView } from "../../src/pages/sandbox/observability/CgroupView";
import { TracesView } from "../../src/pages/sandbox/observability/TracesView";
import { ephemeralSandboxTheme } from "../../src/theme";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/index.css";

const sandboxId = "observability-fixture";
const view = new URL(window.location.href).searchParams.get("view") ?? "events";
const record = {
  id: sandboxId,
  workspace_root: "/fixture/workspace",
  state: "ready" as const,
  daemon: { host: "127.0.0.1", port: 7801 },
  daemon_http: { host: "127.0.0.1", port: 7802 },
  shared_base: null,
  activity_revision: 0,
};

const snapshot = {
  sandboxes: [{
    sandbox_id: sandboxId,
    lifecycle_state: "ready",
    availability: "available",
    sampled_at_unix_ms: 1_700_000_000_000,
    errors: [],
    daemon: null,
    resources: { latest: null, history: [] },
    workspaces: [{
      workspace_id: "workspace-fixture",
      lifecycle_state: "running",
      finalization_state: "active",
      network_profile: "shared",
      layers: { base_root_hash: "fixture-base", layer_count: 3 },
      namespace_fd_count: 1,
      resources: { latest: null, history: [] },
      active_namespace_executions: [],
    }],
    stack: { layer_count: 3, layers_bytes: 6_000_000, active_leases: 1 },
  }],
};

if (view === "daemon") installDaemonFixture();

function SandboxContext() {
  return <Outlet context={{ sandboxId, record, recordUpdatedAt: 1, snapshot, recordError: null }} />;
}

function Fixture() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
    [],
  );
  return (
    <MantineProvider forceColorScheme="light" theme={ephemeralSandboxTheme}>
      <Notifications limit={4} position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/${view}`]}>
          <Box component="main" h="100%">
            <Routes>
              <Route element={<SandboxContext />}>
                <Route path="/events" element={<EventsView />} />
                <Route path="/resources" element={<ResourcesView />} />
                <Route path="/cgroup" element={<CgroupView />} />
                <Route path="/daemon" element={<DaemonView />} />
                <Route path="/traces" element={<TracesView />} />
                <Route path="/traces/:traceId" element={<TracesView />} />
                <Route path="/layers" element={<LayerStackView />} />
              </Route>
            </Routes>
          </Box>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}

function installDaemonFixture() {
  const nativeFetch = globalThis.fetch;
  let sampleCount = 0;
  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { op?: string } : null;
    if (body?.op !== "resources" && body?.op !== "topology") return nativeFetch(input, init);
    if (body.op === "topology") sampleCount += 1;
    const sampledAt = 1_700_004_000_000 + sampleCount * 400;
    if (body.op === "resources") {
      return new Response(JSON.stringify({
        view: "resources",
        scope: "sandbox",
        sandbox_id: "sandbox-fixture",
        availability: "available",
        errors: [],
        series: [{
          ts: sampledAt,
          sample_delta_ms: 400,
          metrics: { cgroup_available: true, mem_cur: 74_000_000, disk_bytes: 4_000_000 },
          deltas: { cpu_usec: 24_000, io_rbytes: 16_384, io_wbytes: 8_192 },
        }],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      view: "topology",
      scope: "sandbox",
      topology: {
        schema_version: 2,
        available: true,
        source: "proc_namespaces",
        error: null,
        truncated: false,
        warnings: [],
        workspaces: [],
        daemon: {
          available: true,
          error: null,
          sampled_at_unix_ms: sampledAt,
          pid: 8,
          name: "sandbox-daemon",
          state: "S (sleeping)",
          virtual_memory_bytes: 118_000_000,
          resident_memory_bytes: 30_000_000 + sampleCount * 12_000,
          peak_resident_memory_bytes: 33_000_000,
          proportional_set_size_bytes: 28_000_000 + sampleCount * 8_000,
          unique_set_size_bytes: 26_000_000 + sampleCount * 6_000,
          anonymous_memory_bytes: 25_000_000 + sampleCount * 9_000,
          file_memory_bytes: 4_000_000,
          shared_memory_bytes: 1_000_000,
          data_memory_bytes: 27_000_000,
          swap_bytes: 0,
          cpu_time_us: 1_000_000 + sampleCount * 24_000,
          start_time_ticks: 123,
          thread_count: 37,
          file_descriptor_count: 15,
          io_read_bytes: 4_096 + sampleCount * 16_384,
          io_write_bytes: 8_192 + sampleCount * 8_192,
          read_syscalls: 41 + sampleCount * 4,
          write_syscalls: 17 + sampleCount * 2,
          voluntary_context_switches: 120 + sampleCount * 12,
          involuntary_context_switches: 3 + sampleCount,
          cgroup_memberships: ["0::/_daemon"],
          warnings: [],
        },
      },
    }), { headers: { "content-type": "application/json" } });
  };
}

createRoot(document.getElementById("root")!).render(<Fixture />);
