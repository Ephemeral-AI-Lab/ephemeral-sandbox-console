import { useState } from "react";
import { Button, Group, Modal, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { Unlink } from "lucide-react";
import { useErrorToast } from "@/components/ErrorToast";
import { removeSandboxCluster } from "@/core/sandboxClusters";

export function RemoveClusterAction({
  className,
  clusterId,
  memberCount,
}: {
  className?: string;
  clusterId: string;
  memberCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const { showError } = useErrorToast();

  const close = () => {
    if (!busy) setOpen(false);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeSandboxCluster(clusterId);
      await queryClient.invalidateQueries({ queryKey: ["sandbox-clusters"] });
      setOpen(false);
      notifications.show({
        title: "Cluster removed",
        message: `${memberCount} sandboxes are still running as individuals.`,
        color: "blue",
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        aria-label={`Remove cluster ${clusterId}`}
        className={className}
        color="danger"
        leftSection={<Unlink aria-hidden size={14} />}
        onClick={() => setOpen(true)}
        size="compact-xs"
        variant="subtle"
      >
        Remove
      </Button>
      <Modal.Root
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
        onClose={close}
        opened={open}
        transitionProps={{ duration: 0 }}
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Body>
            <Group justify="space-between" mb="md" wrap="nowrap">
              <Modal.Title>Remove sandbox cluster</Modal.Title>
              <Modal.CloseButton
                aria-label="Close remove cluster dialog"
                disabled={busy}
              />
            </Group>
            <Text c="dimmed" size="sm">
              This dissolves <Text component="span" ff="monospace">{clusterId}</Text>.
              Its {memberCount} sandboxes stay running and return to the Sandbox view.
            </Text>
            <Group gap="sm" justify="flex-end" mt="lg">
              <Button disabled={busy} onClick={close} variant="subtle">
                Cancel
              </Button>
              <Button color="danger" loading={busy} onClick={() => void remove()}>
                Remove cluster
              </Button>
            </Group>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
