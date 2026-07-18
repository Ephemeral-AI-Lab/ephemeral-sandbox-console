import { Alert, Button, Code, Modal, SimpleGrid, Stack, Text } from "@mantine/core";
import { CircleCheckBig } from "lucide-react";
import type { WorkspaceSessionPublishSummary } from "@/api/types";

export type CloseWorkspaceSessionAction = "publish" | "discard";

export type CloseWorkspaceSessionProblem =
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

export function CloseWorkspaceSessionDialog({
  workspaceSessionId,
  opened,
  cleanupRequired,
  busyAction,
  problem,
  onClose,
  onPublish,
  onDiscard,
}: {
  workspaceSessionId: string | null;
  opened: boolean;
  cleanupRequired: boolean;
  busyAction: CloseWorkspaceSessionAction | null;
  problem: CloseWorkspaceSessionProblem | null;
  onClose: () => void;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  const busy = busyAction !== null;
  const cleanup = cleanupRequired || problem?.kind === "cleanup";

  return (
    <Modal
      centered
      closeButtonProps={{ "aria-label": "Close workspace session dialog" }}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      data-close-workspace-session-dialog
      opened={opened && workspaceSessionId !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      size="lg"
      title={
        <Text component="span" fw={700}>
          <CircleCheckBig
            aria-hidden
            color="var(--mantine-color-eyeBlue-7)"
            size={18}
            style={{ marginRight: 8, verticalAlign: "text-bottom" }}
          />
          Close workspace session
        </Text>
      }
      transitionProps={{ duration: 0 }}
      withCloseButton={!busy}
    >
      <Stack gap="md">
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
              <Text size="sm">Use Discard &amp; close to complete the guarded cleanup.</Text>
            </Stack>
          </Alert>
        ) : (
          <Text c="dimmed" size="sm">
            Choose what happens to this session&apos;s unpublished changes. Publishing merges them
            into the latest LayerStack snapshot when safe, then closes{" "}
            <Code style={{ overflowWrap: "anywhere" }}>{workspaceSessionId}</Code>.
          </Text>
        )}

        {problem?.kind === "retained" ? (
          <Alert color={problem.conflict ? "orange" : "red"} data-workspace-session-retained title={problem.title}>
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
                  and close it here.
                </Text>
              ) : null}
            </Stack>
          </Alert>
        ) : problem?.kind === "failed" ? (
          <Alert color="red" title={problem.title}>
            {problem.message}
          </Alert>
        ) : null}

        <SimpleGrid cols={{ base: 1, sm: cleanup ? 2 : 3 }} spacing="sm">
          <Button disabled={busy} onClick={onClose} size="md" variant="subtle">
            Cancel
          </Button>
          <Button
            color="danger"
            disabled={busy}
            loading={busyAction === "discard"}
            onClick={onDiscard}
            size="md"
            variant="filled"
          >
            {busyAction === "discard" ? "Discarding…" : "Discard & close"}
          </Button>
          {!cleanup ? (
            <Button
              disabled={busy}
              loading={busyAction === "publish"}
              onClick={onPublish}
              size="md"
              variant="filled"
            >
              {busyAction === "publish" ? "Publishing…" : "Publish to LayerStack & close"}
            </Button>
          ) : null}
        </SimpleGrid>
      </Stack>
    </Modal>
  );
}
