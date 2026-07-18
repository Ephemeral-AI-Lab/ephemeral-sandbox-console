import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Divider,
  Drawer,
  Group,
  Menu,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Globe2, Plus, Shield } from "lucide-react";
import { RpcError, rpc, sandboxScope } from "@/api/rpc";
import type {
  WorkspaceSessionCreated,
  WorkspaceSessionDestroyed,
  WorkspaceSessionPublishCleanupDetails,
  WorkspaceSessionPublished,
} from "@/api/types";
import { fetchSandboxSnapshot, type WorkspaceSnapshot } from "@/api/observability";
import { useErrorToast } from "@/components/ErrorToast";
import {
  WorkspaceSessionActionButtons,
  WorkspaceSessionActionFeedback,
  type WorkspaceSessionAction,
  type WorkspaceSessionProblem,
} from "@/pages/sandbox/terminal/WorkspaceSessionActions";

export type TerminalMode = "session" | "quick" | "all";

type NetworkProfile = "shared" | "isolated";

type CreatedSession = {
  workspaceSessionId: string;
  networkProfile: NetworkProfile;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protectedDropGuidance(reason: string): string {
  switch (reason) {
    case "unsupported_special_file":
      return "Remove or replace this unsupported special file before retrying.";
    case "invalid_layer_path":
      return "Rename or remove this invalid LayerStack path before retrying.";
    case "command_scratch_path":
      return "Move the change outside the command scratch path before retrying.";
    default:
      return "Resolve this blocked change before retrying the publish.";
  }
}

function closeProblem(error: unknown): WorkspaceSessionProblem {
  if (!(error instanceof RpcError) || !isRecord(error.details)) {
    return {
      kind: "failed",
      title: "Publish could not be completed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const details = error.details;
  if (
    details.stage === "destroy" &&
    details.publish_completed === true &&
    isRecord(details.publish) &&
    isRecord(details.publish.revision) &&
    isRecord(details.publish.route_summary)
  ) {
    return {
      kind: "cleanup",
      publish: (details as unknown as WorkspaceSessionPublishCleanupDetails).publish,
    };
  }

  const activeCommandSessionIds = Array.isArray(details.active_command_session_ids)
    ? details.active_command_session_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (activeCommandSessionIds.length > 0) {
    return {
      kind: "retained",
      title: "Stop active commands first",
      message: "Publishing did not start. The complete session delta was retained.",
      activeCommandSessionIds,
      conflict: false,
    };
  }

  const rejection = isRecord(details.publish_rejection)
    ? details.publish_rejection
    : null;
  const sourceConflict = rejection && isRecord(rejection.source_conflict)
    ? rejection.source_conflict
    : null;
  const protectedDrop = rejection && isRecord(rejection.protected_drop)
    ? rejection.protected_drop
    : null;
  const protectedDropPath = typeof protectedDrop?.path === "string"
    ? protectedDrop.path
    : undefined;
  const protectedDropReason = typeof protectedDrop?.reason === "string"
    ? protectedDrop.reason
    : undefined;
  const reason = typeof rejection?.reason === "string" ? rejection.reason : undefined;
  const path = typeof rejection?.path === "string"
    ? rejection.path
    : typeof sourceConflict?.path === "string"
      ? sourceConflict.path
      : protectedDropPath;
  const retained = details.session_retained === true;
  if (retained || rejection) {
    const conflict = reason === "source_conflict";
    return {
      kind: "retained",
      title: conflict ? "Publish conflict; session retained" : "Publish rejected; session retained",
      message: "No LayerStack changes were committed. The complete unpublished delta remains available in this session.",
      path,
      reason,
      protectedDrop: protectedDropReason
        ? {
            path: protectedDropPath,
            reason: protectedDropReason,
            guidance: protectedDropGuidance(protectedDropReason),
          }
        : undefined,
      conflict,
    };
  }

  return {
    kind: "failed",
    title: error.kind,
    message: error.message,
  };
}

export function SessionSidebar({
  sandboxId,
  workspaces,
  mode,
  selected,
  narrow,
  opened,
  onClose,
  onSelect,
  onFinalizationFailed,
}: {
  sandboxId: string;
  workspaces: WorkspaceSnapshot[];
  mode: TerminalMode;
  selected: string | null;
  narrow: boolean;
  opened: boolean;
  onClose: () => void;
  onSelect: (mode: TerminalMode, sessionId?: string) => void;
  onFinalizationFailed: (sessionId: string) => void;
}) {
  const [createdSession, setCreatedSession] = useState<CreatedSession | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<WorkspaceSessionAction | null>(null);
  const [discardConfirmId, setDiscardConfirmId] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<{
    workspaceSessionId: string;
    problem: WorkspaceSessionProblem;
  } | null>(null);
  const [closedSessionIds, setClosedSessionIds] = useState<Set<string>>(new Set());
  const [cleanupRequiredIds, setCleanupRequiredIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const { showError } = useErrorToast();

  const refreshSnapshot = () =>
    queryClient.invalidateQueries({ queryKey: ["sandbox", sandboxId, "snapshot"] });

  const refreshRejectedSnapshot = async () => {
    try {
      const nextSnapshot = await fetchSandboxSnapshot(sandboxId);
      queryClient.setQueryData(["sandbox", sandboxId, "snapshot"], nextSnapshot);
    } catch {
      // Preserve the structured rejection even if the immediate reconciliation
      // request fails; invalidation still lets normal polling recover later.
      await refreshSnapshot();
    }
  };

  const refreshPublishedState = () =>
    Promise.all([
      refreshSnapshot(),
      queryClient.invalidateQueries({
        queryKey: ["observability", sandboxId, "layerstack"],
      }),
      queryClient.invalidateQueries({ queryKey: ["files", sandboxId] }),
    ]);

  useEffect(() => {
    if (
      createdSession &&
      workspaces.some((workspace) => workspace.workspace_id === createdSession.workspaceSessionId)
    ) {
      setCreatedSession(null);
    }
  }, [createdSession, workspaces]);

  useEffect(() => {
    for (const workspace of workspaces) {
      if (workspace.finalization_state === "finalize_failed") {
        setCleanupRequiredIds((current) => {
          if (current.has(workspace.workspace_id)) return current;
          return new Set(current).add(workspace.workspace_id);
        });
        onFinalizationFailed(workspace.workspace_id);
      }
    }
  }, [onFinalizationFailed, workspaces]);

  useEffect(() => {
    const liveSessionIds = new Set(workspaces.map((workspace) => workspace.workspace_id));
    if (discardConfirmId && !liveSessionIds.has(discardConfirmId)) {
      setDiscardConfirmId(null);
    }
    if (actionProblem && !liveSessionIds.has(actionProblem.workspaceSessionId)) {
      setActionProblem(null);
    }
  }, [actionProblem, discardConfirmId, workspaces]);

  const createSession = async (networkProfile: NetworkProfile) => {
    if (createBusy || busyAction !== null) return;
    setCreateBusy(true);
    try {
      const output = await rpc<WorkspaceSessionCreated>(
        "create_workspace_session",
        sandboxScope(sandboxId),
        { network_profile: networkProfile },
      );
      const target = {
        workspaceSessionId: output.workspace_session_id,
        networkProfile: output.network_profile,
      };
      setCreatedSession(target);
      onSelect("session", target.workspaceSessionId);
      void refreshSnapshot();
      notifications.show({
        color: "success",
        title: "Workspace session created",
        message: `${target.workspaceSessionId} · ${target.networkProfile}`,
        withCloseButton: false,
      });
    } catch (error) {
      showError(error);
    } finally {
      setCreateBusy(false);
    }
  };

  const closeSuccessfulSession = (workspaceSessionId: string) => {
    setClosedSessionIds((current) => new Set(current).add(workspaceSessionId));
    setCleanupRequiredIds((current) => {
      if (!current.has(workspaceSessionId)) return current;
      const next = new Set(current);
      next.delete(workspaceSessionId);
      return next;
    });
    setDiscardConfirmId(null);
    setActionProblem((current) =>
      current?.workspaceSessionId === workspaceSessionId ? null : current,
    );
    if (mode === "session" && selected === workspaceSessionId) onSelect("quick");
    if (narrow) onClose();
  };

  const publishSession = async (workspaceSessionId: string) => {
    const target = workspaces.find(
      (workspace) => workspace.workspace_id === workspaceSessionId,
    );
    if (
      !target ||
      createBusy ||
      busyAction !== null ||
      target.finalization_state !== "active" ||
      target.active_namespace_executions.length > 0
    ) return;
    setBusySessionId(workspaceSessionId);
    setBusyAction("publish");
    setDiscardConfirmId(null);
    setActionProblem(null);
    try {
      const output = await rpc<WorkspaceSessionPublished>(
        "publish_workspace_session",
        sandboxScope(sandboxId),
        { workspace_session_id: workspaceSessionId },
      );
      closeSuccessfulSession(workspaceSessionId);
      await refreshPublishedState();
      notifications.show({
        color: "success",
        title: output.publish.no_op
          ? "No changes to publish; session closed"
          : "Workspace session published",
        message: output.publish.no_op
          ? output.workspace_session_id
          : `${output.workspace_session_id} · manifest v${output.publish.revision.manifest_version} · ${output.publish.revision.layer_count} ${output.publish.revision.layer_count === 1 ? "layer" : "layers"}`,
        withCloseButton: false,
      });
    } catch (error) {
      const nextProblem = closeProblem(error);
      setActionProblem({ workspaceSessionId, problem: nextProblem });
      if (nextProblem.kind === "cleanup") {
        setCleanupRequiredIds((current) => new Set(current).add(workspaceSessionId));
        onFinalizationFailed(workspaceSessionId);
        await refreshPublishedState();
        notifications.show({
          color: "yellow",
          title: "Published; cleanup required",
          message: `${workspaceSessionId} · use Finish cleanup to close the session`,
          withCloseButton: false,
        });
      } else if (nextProblem.kind === "retained") {
        await refreshRejectedSnapshot();
      } else if (nextProblem.kind === "failed") {
        showError(error);
      }
    } finally {
      setBusyAction(null);
      setBusySessionId(null);
    }
  };

  const destroySession = async (workspaceSessionId: string) => {
    const target = workspaces.find(
      (workspace) => workspace.workspace_id === workspaceSessionId,
    );
    const cleanupRequired = cleanupRequiredIds.has(workspaceSessionId) ||
      target?.finalization_state === "finalize_failed";
    if (
      !target ||
      createBusy ||
      busyAction !== null ||
      (!cleanupRequired && target.finalization_state !== "active") ||
      target.active_namespace_executions.length > 0
    ) return;
    setBusySessionId(workspaceSessionId);
    setBusyAction("discard");
    setActionProblem(null);
    try {
      const output = await rpc<WorkspaceSessionDestroyed>(
        "destroy_workspace_session",
        sandboxScope(sandboxId),
        { workspace_session_id: workspaceSessionId },
      );
      closeSuccessfulSession(workspaceSessionId);
      await refreshSnapshot();
      notifications.show({
        color: "success",
        title: cleanupRequired ? "Workspace session cleanup complete" : "Workspace session discarded",
        message: `${output.workspace_session_id} · ${output.evicted_upperdir_bytes} bytes evicted`,
        withCloseButton: false,
      });
    } catch (error) {
      setActionProblem({
        workspaceSessionId,
        problem: {
          kind: "failed",
          title: "Session could not be closed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      showError(error);
    } finally {
      setBusyAction(null);
      setBusySessionId(null);
    }
  };

  const sessions = (
    <SessionList
      workspaces={workspaces}
      createdSession={createdSession}
      createBusy={createBusy}
      mutationBusy={createBusy || busyAction !== null}
      mode={mode}
      selected={selected}
      narrow={narrow}
      busyAction={busyAction}
      busySessionId={busySessionId}
      discardConfirmId={discardConfirmId}
      actionProblem={actionProblem}
      cleanupRequiredIds={cleanupRequiredIds}
      closedSessionIds={closedSessionIds}
      onCancelDiscard={() => setDiscardConfirmId(null)}
      onDiscard={(workspaceId) => void destroySession(workspaceId)}
      onPublish={(workspaceId) => void publishSession(workspaceId)}
      onRequestDiscard={(workspaceId) => {
        setActionProblem(null);
        setDiscardConfirmId(workspaceId);
      }}
      onSelect={onSelect}
      onCreate={(networkProfile) => void createSession(networkProfile)}
    />
  );

  return (
    <>
      {narrow ? (
        <Drawer
          closeButtonProps={{ "aria-label": "Close workspace sessions" }}
          data-terminal-sessions-drawer
          opened={opened}
          onClose={() => {
            setDiscardConfirmId(null);
            onClose();
          }}
          position="left"
          size="18rem"
          title="Workspace sessions"
        >
          {sessions}
        </Drawer>
      ) : (
        <Paper
          component="aside"
          data-terminal-session-rail
          radius={0}
          withBorder
          style={{ display: "flex", flex: "0 0 16rem", flexDirection: "column", minHeight: 0 }}
        >
          {sessions}
        </Paper>
      )}
    </>
  );
}

function SessionList({
  workspaces,
  createdSession,
  createBusy,
  mutationBusy,
  mode,
  selected,
  narrow,
  busyAction,
  busySessionId,
  discardConfirmId,
  actionProblem,
  cleanupRequiredIds,
  closedSessionIds,
  onCancelDiscard,
  onDiscard,
  onPublish,
  onRequestDiscard,
  onCreate,
  onSelect,
}: {
  workspaces: WorkspaceSnapshot[];
  createdSession: CreatedSession | null;
  createBusy: boolean;
  mutationBusy: boolean;
  mode: TerminalMode;
  selected: string | null;
  narrow: boolean;
  busyAction: WorkspaceSessionAction | null;
  busySessionId: string | null;
  discardConfirmId: string | null;
  actionProblem: {
    workspaceSessionId: string;
    problem: WorkspaceSessionProblem;
  } | null;
  cleanupRequiredIds: Set<string>;
  closedSessionIds: Set<string>;
  onCancelDiscard: () => void;
  onDiscard: (workspaceId: string) => void;
  onPublish: (workspaceId: string) => void;
  onRequestDiscard: (workspaceId: string) => void;
  onCreate: (networkProfile: NetworkProfile) => void;
  onSelect: (mode: TerminalMode, sessionId?: string) => void;
}) {
  const sessions = workspaces
    .filter((workspace) => !closedSessionIds.has(workspace.workspace_id))
    .map((workspace) => ({
      workspaceSessionId: workspace.workspace_id,
      networkProfile: workspace.network_profile,
      layerCount: workspace.layers.layer_count,
      activeCommands: workspace.active_namespace_executions.length,
      finalizationState: workspace.finalization_state,
      persisted: true,
    }));
  if (
    createdSession &&
    !sessions.some((session) => session.workspaceSessionId === createdSession.workspaceSessionId)
  ) {
    sessions.push({
      ...createdSession,
      layerCount: 0,
      activeCommands: 0,
      finalizationState: "active" as const,
      persisted: false,
    });
  }

  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" p="md" pb="sm" wrap="nowrap">
        {!narrow ? <Text fw={700} size="xs" tt="uppercase">Workspace sessions</Text> : <span />}
        <Menu position="bottom-end" shadow="md" width={220}>
          <Menu.Target>
            <Button
              aria-label="New workspace session"
              disabled={busyAction !== null}
              leftSection={<Plus aria-hidden size={14} />}
              loading={createBusy}
              size="xs"
              variant="light"
            >
              New
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Network profile</Menu.Label>
            <Menu.Item
              disabled={mutationBusy}
              leftSection={<Globe2 aria-hidden size={14} />}
              onClick={() => onCreate("shared")}
            >
              <Text size="sm">Shared session</Text>
              <Text c="dimmed" size="xs">Sandbox network · retains changes</Text>
            </Menu.Item>
            <Menu.Item
              disabled={mutationBusy}
              leftSection={<Shield aria-hidden size={14} />}
              onClick={() => onCreate("isolated")}
            >
              <Text size="sm">Isolated session</Text>
              <Text c="dimmed" size="xs">No external network · retains changes</Text>
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <ScrollArea data-terminal-session-scroll style={{ flex: 1, minHeight: 0 }} type="auto">
        <Stack gap={2} px="sm" pb="sm">
          {sessions.map((session) => {
            const cleanupRequired = cleanupRequiredIds.has(session.workspaceSessionId) ||
              session.finalizationState === "finalize_failed";
            const rowBusyAction = busySessionId === session.workspaceSessionId
              ? busyAction
              : null;
            const disabledReason = session.activeCommands > 0
              ? `Stop ${session.activeCommands === 1 ? "the active command" : `${session.activeCommands} active commands`} before publishing or discarding.`
              : session.finalizationState === "finalizing"
                ? "This workspace session is finalizing."
                : createBusy
                  ? "A workspace session is being created."
                : busyAction !== null && rowBusyAction === null
                  ? "Another workspace session action is in progress."
                  : null;
            const description = [
              session.networkProfile,
              `${session.layerCount} ${session.layerCount === 1 ? "layer" : "layers"}`,
              session.activeCommands > 0
                ? `${session.activeCommands} active ${session.activeCommands === 1 ? "command" : "commands"}`
                : null,
              session.finalizationState === "finalizing" ? "finalizing" : null,
              cleanupRequired ? "cleanup required" : null,
            ].filter(Boolean).join(" · ");
            return (
              <Stack
                data-workspace-session-row={session.workspaceSessionId}
                gap={4}
                key={session.workspaceSessionId}
              >
                <Group gap={0} wrap="nowrap">
                  <NavLink
                    active={mode === "session" && selected === session.workspaceSessionId}
                    aria-label={`Use workspace session ${session.workspaceSessionId}`}
                    description={description}
                    label={session.workspaceSessionId}
                    onClick={() => onSelect("session", session.workspaceSessionId)}
                    title={session.workspaceSessionId}
                    styles={{
                      root: { flex: 1, minWidth: 0 },
                      label: {
                        fontFamily: "var(--mantine-font-family-monospace)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                    }}
                  />
                  {session.persisted ? (
                    <WorkspaceSessionActionButtons
                      busyAction={rowBusyAction}
                      cleanupRequired={cleanupRequired}
                      disabledReason={disabledReason}
                      discardConfirmation={discardConfirmId === session.workspaceSessionId}
                      mutationBusy={mutationBusy}
                      onCancelDiscard={onCancelDiscard}
                      onDiscard={() => onDiscard(session.workspaceSessionId)}
                      onPublish={() => onPublish(session.workspaceSessionId)}
                      onRequestDiscard={() => onRequestDiscard(session.workspaceSessionId)}
                      workspaceSessionId={session.workspaceSessionId}
                    />
                  ) : null}
                </Group>
                {session.persisted ? (
                  <WorkspaceSessionActionFeedback
                    cleanupRequired={cleanupRequired}
                    disabledReason={disabledReason}
                    discardConfirmation={discardConfirmId === session.workspaceSessionId}
                    problem={actionProblem?.workspaceSessionId === session.workspaceSessionId
                      ? actionProblem.problem
                      : null}
                  />
                ) : null}
              </Stack>
            );
          })}
          {sessions.length === 0 ? (
            <Text c="dimmed" p="sm" size="xs">
              No live sessions. Create one when commands need to share private changes.
            </Text>
          ) : null}
          <Divider my="xs" />
          <Text c="dimmed" px="sm" py={4} size="xs" tt="uppercase">Run once</Text>
          <NavLink
            active={mode === "quick"}
            description="shared · auto-publish"
            label="Quick run"
            onClick={() => onSelect("quick")}
          />
          <Text c="dimmed" mt="xs" px="sm" py={4} size="xs" tt="uppercase">History</Text>
          <NavLink
            active={mode === "all"}
            description="unfiltered ledger"
            label="All commands"
            onClick={() => onSelect("all")}
          />
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
