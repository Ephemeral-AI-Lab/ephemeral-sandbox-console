import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Box, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { SnapshotResult } from "../../src/api/observability";
import type { LedgerEntry } from "../../src/pages/sandbox/terminal/ledger";
import { TerminalTab } from "../../src/pages/sandbox/terminal/TerminalTab";
import { ephemeralSandboxTheme } from "../../src/theme";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/index.css";

const sandboxId = "terminal-fixture";
const fixtureParams = new URL(window.location.href).searchParams;
const large = fixtureParams.has("large");
const external = fixtureParams.has("external");
const cleanup = fixtureParams.has("cleanup");
const idle = fixtureParams.has("idle");
const missing = fixtureParams.has("missing");

type SessionFixtureDetail =
  | { action: "remove"; workspaceSessionId: string }
  | { action: "active"; workspaceSessionId: string }
  | { action: "finalizing"; workspaceSessionId: string }
  | { action: "finalize-failed"; workspaceSessionId: string };

const snapshot: SnapshotResult = {
  sandboxes: [
    {
      sandbox_id: sandboxId,
      lifecycle_state: "ready",
      availability: "available",
      sampled_at_unix_ms: 1_700_000_000_000,
      errors: [],
      daemon: { daemon_pid: 42, runtime_dir: "/fixture/runtime" },
      resources: { latest: null, history: [] },
      workspaces: [
        {
          workspace_id: "workspace-alpha",
          lifecycle_state: "running",
          finalization_state: "active",
          network_profile: "shared",
          layers: { base_root_hash: "fixture-base", layer_count: 2 },
          namespace_fd_count: 2,
          resources: { latest: null, history: [] },
          active_namespace_executions: idle ? [] : [
            {
              namespace_execution_id: large ? "large-command" : "running-command",
              operation: "exec_command",
              lifecycle_state: "running",
              command: external ? "backend-interactive-loop" : null,
            },
          ],
        },
        {
          workspace_id: "workspace-beta",
          lifecycle_state: "running",
          finalization_state: cleanup ? "finalize_failed" : "active",
          network_profile: "isolated",
          layers: { base_root_hash: "fixture-base", layer_count: 4 },
          namespace_fd_count: 1,
          resources: { latest: null, history: [] },
          active_namespace_executions: [],
        },
      ],
      stack: { layer_count: 4, layers_bytes: 2_000_000, active_leases: 1 },
    },
  ],
};

function entry(partial: Partial<LedgerEntry> & Pick<LedgerEntry, "localId" | "cmd">): LedgerEntry {
  return {
    commandSessionId: null,
    workspaceSessionId: null,
    autoPublish: false,
    startedAt: 1_700_000_000_000,
    status: "ok",
    exitCode: 0,
    endedAt: 1_700_000_001_000,
    inlineOutput: null,
    publishRejected: false,
    publishRejectClass: null,
    ...partial,
  };
}

const entries: LedgerEntry[] = external
  ? []
  : large
  ? [
      entry({
        localId: "large-local",
        commandSessionId: "large-command",
        cmd: "generate 10,000 diagnostic lines",
        workspaceSessionId: "workspace-alpha",
        autoPublish: true,
        status: "running",
        exitCode: null,
        endedAt: null,
      }),
    ]
  : [
      entry({
        localId: "running-local",
        commandSessionId: "running-command",
        cmd: "tail -f /var/log/fixture.log",
        workspaceSessionId: "workspace-alpha",
        autoPublish: true,
        status: "running",
        exitCode: null,
        endedAt: null,
      }),
      entry({
        localId: "rejected-local",
        commandSessionId: "rejected-command",
        cmd: "write protected output",
        workspaceSessionId: "workspace-alpha",
        autoPublish: true,
        publishRejected: true,
        publishRejectClass: "protected_path",
      }),
      entry({
        localId: "completed-local",
        cmd: "echo completed elsewhere",
        workspaceSessionId: "workspace-beta",
        autoPublish: true,
      }),
    ];

localStorage.setItem(`eos-console:ledger:${sandboxId}`, JSON.stringify(entries));

function TerminalContext({ value }: { value: SnapshotResult }) {
  return (
    <Outlet
      context={{
        sandboxId,
        record: null,
        snapshot: value,
        recordError: null,
      }}
    />
  );
}

function Fixture() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
    [],
  );
  const commandSessionId = large ? "large-command" : "running-command";
  const [fixtureSnapshot, setFixtureSnapshot] = useState(snapshot);

  useEffect(() => {
    const updateSession = (event: Event) => {
      const detail = (event as CustomEvent<SessionFixtureDetail>).detail;
      setFixtureSnapshot((current) => ({
        sandboxes: current.sandboxes.map((sandbox) => ({
          ...sandbox,
          workspaces: detail.action === "remove"
            ? sandbox.workspaces.filter(
                (workspace) => workspace.workspace_id !== detail.workspaceSessionId,
              )
            : sandbox.workspaces.map((workspace) =>
                workspace.workspace_id === detail.workspaceSessionId
                  ? {
                      ...workspace,
                      finalization_state: detail.action,
                      active_namespace_executions: [],
                    }
                  : workspace,
              ),
        })),
      }));
    };
    window.addEventListener("p06-session-fixture", updateSession);
    return () => window.removeEventListener("p06-session-fixture", updateSession);
  }, []);

  return (
    <MantineProvider forceColorScheme="light" theme={ephemeralSandboxTheme}>
      <Notifications limit={4} position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[
            cleanup
              ? "/terminal?session=workspace-beta"
              : external
                ? "/terminal?session=workspace-alpha"
                : missing
                  ? "/terminal?session=workspace-gone"
                  : `/terminal#cmd-${commandSessionId}`,
          ]}
        >
          <Box component="main" h="100%">
            <Routes>
              <Route path="/terminal" element={<TerminalContext value={fixtureSnapshot} />}>
                <Route index element={<TerminalTab />} />
              </Route>
            </Routes>
          </Box>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
