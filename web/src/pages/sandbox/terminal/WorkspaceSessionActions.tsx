import { useEffect, useRef } from "react";
import { ActionIcon, Alert, Code, Group, Stack, Text, Tooltip } from "@mantine/core";
import { Trash2, Upload, Wrench, X } from "lucide-react";
import type { WorkspaceSessionPublishSummary } from "@/api/types";
import classes from "./WorkspaceSessionActions.module.css";

export type WorkspaceSessionAction = "publish" | "discard";

const actionTargetStyle = { display: "inline-flex", flex: "0 0 44px" } as const;
const actionIconStyle = { height: 44, minHeight: 44, minWidth: 44, width: 44 } as const;

export type WorkspaceSessionProblem =
  | {
      kind: "retained";
      title: string;
      message: string;
      path?: string;
      reason?: string;
      protectedDrop?: {
        path?: string;
        reason: string;
        guidance: string;
      };
      activeCommandSessionIds?: string[];
      conflict: boolean;
    }
  | {
      kind: "cleanup";
      publish: WorkspaceSessionPublishSummary;
    }
  | {
      kind: "failed";
      title: string;
      message: string;
    };

export function WorkspaceSessionActionButtons({
  workspaceSessionId,
  cleanupRequired,
  disabledReason,
  mutationBusy,
  busyAction,
  discardConfirmation,
  onPublish,
  onRequestDiscard,
  onCancelDiscard,
  onDiscard,
}: {
  workspaceSessionId: string;
  cleanupRequired: boolean;
  disabledReason: string | null;
  mutationBusy: boolean;
  busyAction: WorkspaceSessionAction | null;
  discardConfirmation: boolean;
  onPublish: () => void;
  onRequestDiscard: () => void;
  onCancelDiscard: () => void;
  onDiscard: () => void;
}) {
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const disabled = mutationBusy || disabledReason !== null;
  const publishHint = disabledReason ?? `Publish ${workspaceSessionId} to LayerStack and close it`;
  const discardHint = disabledReason ?? `Discard unpublished changes in ${workspaceSessionId}`;

  useEffect(() => {
    if (discardConfirmation) keepButtonRef.current?.focus();
  }, [discardConfirmation]);

  return (
    <Group data-workspace-session-actions gap={0} style={{ flexShrink: 0 }} wrap="nowrap">
      {cleanupRequired ? (
        <Tooltip
          label={disabledReason ?? `Finish cleanup for ${workspaceSessionId}`}
          withArrow
          withinPortal={false}
        >
          <span style={actionTargetStyle}>
            <ActionIcon
              aria-label={`Finish cleanup for workspace session ${workspaceSessionId}`}
              className={classes.action}
              color="yellow"
              disabled={disabled}
              loading={busyAction === "discard"}
              onClick={onDiscard}
              size={44}
              style={actionIconStyle}
              title={disabledReason ?? `Finish cleanup for ${workspaceSessionId}`}
              variant="subtle"
            >
              <Wrench aria-hidden size={16} />
            </ActionIcon>
          </span>
        </Tooltip>
      ) : discardConfirmation ? (
        <>
          <Tooltip label="Keep workspace session" withArrow withinPortal={false}>
            <span style={actionTargetStyle}>
              <ActionIcon
                aria-label={`Keep workspace session ${workspaceSessionId}`}
                className={classes.action}
                disabled={mutationBusy}
                onClick={onCancelDiscard}
                ref={keepButtonRef}
                size={44}
                style={actionIconStyle}
                title="Keep workspace session"
                variant="subtle"
              >
                <X aria-hidden size={16} />
              </ActionIcon>
            </span>
          </Tooltip>
          <Tooltip
            label={disabledReason ?? "Confirm discard and close"}
            withArrow
            withinPortal={false}
          >
            <span style={actionTargetStyle}>
              <ActionIcon
                aria-label={`Confirm discard and close workspace session ${workspaceSessionId}`}
                className={classes.action}
                color="danger"
                disabled={disabled}
                loading={busyAction === "discard"}
                onClick={onDiscard}
                size={44}
                style={actionIconStyle}
                title={disabledReason ?? "Confirm discard and close"}
                variant="subtle"
              >
                <Trash2 aria-hidden size={16} />
              </ActionIcon>
            </span>
          </Tooltip>
        </>
      ) : (
        <>
          <Tooltip label={publishHint} withArrow withinPortal={false}>
            <span style={actionTargetStyle}>
              <ActionIcon
                aria-label={`Publish and close workspace session ${workspaceSessionId}`}
                className={classes.action}
                disabled={disabled}
                loading={busyAction === "publish"}
                onClick={onPublish}
                size={44}
                style={actionIconStyle}
                title={publishHint}
                variant="subtle"
              >
                <Upload aria-hidden size={16} />
              </ActionIcon>
            </span>
          </Tooltip>
          <Tooltip label={discardHint} withArrow withinPortal={false}>
            <span style={actionTargetStyle}>
              <ActionIcon
                aria-label={`Discard workspace session ${workspaceSessionId}`}
                className={classes.action}
                color="danger"
                disabled={disabled}
                onClick={onRequestDiscard}
                size={44}
                style={actionIconStyle}
                title={discardHint}
                variant="subtle"
              >
                <Trash2 aria-hidden size={16} />
              </ActionIcon>
            </span>
          </Tooltip>
        </>
      )}
    </Group>
  );
}

export function WorkspaceSessionActionFeedback({
  cleanupRequired,
  disabledReason,
  discardConfirmation,
  problem,
}: {
  cleanupRequired: boolean;
  disabledReason: string | null;
  discardConfirmation: boolean;
  problem: WorkspaceSessionProblem | null;
}) {
  const cleanup = cleanupRequired || problem?.kind === "cleanup";

  return (
    <Stack className={classes.feedback} gap="xs">
      {discardConfirmation ? (
        <Text
          aria-live="polite"
          c="danger.7"
          data-workspace-discard-confirmation
          px={4}
          role="status"
          size="xs"
        >
          Discard unpublished changes? Select the red trash again to close without publishing.
        </Text>
      ) : null}
      {disabledReason ? (
        <Text c="dimmed" data-workspace-session-action-disabled-reason px={4} size="xs">
          {disabledReason}
        </Text>
      ) : null}

      {cleanup ? (
        <Alert color="yellow" data-workspace-cleanup-required title="Published; cleanup required">
          <Stack gap={6}>
            <Text size="sm">
              LayerStack publication completed, but the session could not be closed. Commands,
              files, and publishing stay disabled until cleanup finishes.
            </Text>
            {problem?.kind === "cleanup" ? (
              <Text size="xs">
                {problem.publish.no_op ? "No layer was committed" : "Committed"} at manifest v
                {problem.publish.revision.manifest_version} · {problem.publish.revision.layer_count}{" "}
                {problem.publish.revision.layer_count === 1 ? "layer" : "layers"}.
              </Text>
            ) : null}
            <Text size="sm">Use Finish cleanup to close the finalized session.</Text>
          </Stack>
        </Alert>
      ) : null}

      {problem?.kind === "retained" ? (
        <Alert
          color={problem.conflict ? "orange" : "red"}
          data-workspace-session-retained
          title={problem.title}
        >
          <Stack gap={6}>
            <Text size="sm">{problem.message}</Text>
            {problem.path || problem.reason ? (
              <Text size="xs">
                {problem.path ? <>Path: <Code>{problem.path}</Code></> : null}
                {problem.path && problem.reason ? " · " : null}
                {problem.reason ? <>Reason: <Code>{problem.reason}</Code></> : null}
              </Text>
            ) : null}
            {problem.protectedDrop ? (
              <Stack gap={2}>
                <Text size="xs">
                  Blocked change
                  {problem.protectedDrop.path && problem.protectedDrop.path !== problem.path
                    ? <> at <Code>{problem.protectedDrop.path}</Code></>
                    : null}
                  : <Code>{problem.protectedDrop.reason}</Code>
                </Text>
                <Text size="sm">{problem.protectedDrop.guidance}</Text>
              </Stack>
            ) : null}
            {problem.activeCommandSessionIds?.length ? (
              <Text size="xs">
                Active commands: <Code>{problem.activeCommandSessionIds.join(", ")}</Code>
              </Text>
            ) : null}
            {problem.conflict ? (
              <Text size="sm">
                Inspect or edit the retained session, then retry publishing. You can also discard
                it from this row.
              </Text>
            ) : null}
          </Stack>
        </Alert>
      ) : problem?.kind === "failed" ? (
        <Alert color="red" title={problem.title}>
          {problem.message}
        </Alert>
      ) : null}
    </Stack>
  );
}
