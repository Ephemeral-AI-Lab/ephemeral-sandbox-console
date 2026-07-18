import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, Group, Input, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import {
  buildArgs,
  findOperation,
  type OperationSpecDoc,
  useCatalogs,
} from "@/api/catalog";
import { listDockerImages } from "@/api/hostResources";
import { rpcStream, systemScope } from "@/api/rpc";
import { useErrorToast } from "@/components/ErrorToast";
import { WorkspacePicker } from "@/pages/fleet/WorkspacePicker";
import classes from "@/pages/fleet/CreateSandboxModal.module.css";

function defaultValues(spec: OperationSpecDoc | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of spec?.args ?? []) {
    if (arg.default !== null) values[arg.name] = arg.default;
  }
  return values;
}

/**
 * Builds `create_sandbox` arguments from the catalog while using controls
 * suited to its Docker image and host-folder inputs.
 * Submits with `_stream_logs`; progress renders on the fleet's Creating
 * card, the web equivalent of the CLI's `--progress`.
 */
export function CreateSandboxModal({
  compactOnNarrow = false,
  onStream,
}: {
  compactOnNarrow?: boolean;
  onStream: (logs: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const catalogs = useCatalogs();
  const { showError } = useErrorToast();
  const queryClient = useQueryClient();

  const spec = findOperation(catalogs.data?.management, "create_sandbox");
  const images = useQuery({
    queryKey: ["docker-images"],
    queryFn: listDockerImages,
    enabled: open,
  });

  useEffect(() => {
    if (!open || !spec) return;
    setValues((current) => ({ ...defaultValues(spec), ...current }));
  }, [open, spec]);

  const submit = async () => {
    if (!spec) return;
    const built = buildArgs(spec.args, values);
    setErrors(built.errors);
    if (Object.keys(built.errors).length > 0) return;
    setBusy(true);
    const logs: string[] = [];
    onStream(logs.slice());
    setOpen(false);
    try {
      await rpcStream("create_sandbox", systemScope, built.args, (line) => {
        logs.push(line);
        onStream(logs.slice());
        void queryClient.invalidateQueries({ queryKey: ["fleet"] });
      });
      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      onStream(null);
      setValues(defaultValues(spec));
    }
  };

  const openModal = () => {
    setOpen(true);
    setWorkspacePickerOpen(false);
    setErrors({});
    setValues(defaultValues(spec));
  };

  return (
    <>
      <Button
        aria-label="New Sandbox"
        data-new-sandbox-trigger
        leftSection={<Plus aria-hidden size={16} />}
        variant="filled"
        disabled={busy}
        onClick={openModal}
      >
        {busy ? "Creating…" : compactOnNarrow ? (
          <>
            <span data-new-label-full>New Sandbox</span>
            <span data-new-label-short>New</span>
          </>
        ) : "New Sandbox"}
      </Button>
      <Modal.Root
        opened={open}
        onClose={() => setOpen(false)}
        closeOnEscape={!workspacePickerOpen}
        centered
        size="lg"
        transitionProps={{ duration: 0 }}
      >
        <Modal.Overlay />
        <Modal.Content className={classes.content} data-create-sandbox-modal>
          <Modal.Header className={classes.header} component="div">
            <div className={classes.heading}>
              <Modal.Title className={classes.title}>Create sandbox</Modal.Title>
              <Text className={classes.summary} size="sm" c="dimmed">
                {spec?.summary ?? "Create a host-side sandbox record and runtime sandbox."}
              </Text>
            </div>
            <Modal.CloseButton aria-label="Close create sandbox" size="md" />
          </Modal.Header>
          <Modal.Body className={classes.body}>
            <form
              className={classes.form}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Stack className={classes.fields} gap="lg">
                {(spec?.args ?? []).map((arg) => {
                  const error =
                    errors[arg.name] ??
                    (arg.name === "image" && images.isError
                      ? (images.error as Error).message
                      : arg.name === "image" && images.data?.length === 0
                        ? "No Docker images are available."
                        : undefined);

                  return (
                    <Input.Wrapper
                      key={arg.name}
                      className={classes.field}
                      id={`create-${arg.name}`}
                      label={<Text component="span" ff="monospace" size="sm">{arg.name}</Text>}
                      required={arg.required}
                      description={error ? undefined : arg.help}
                      error={error}
                    >
                      {arg.name === "image" ? (
                        <Select
                          id={`create-${arg.name}`}
                          value={values[arg.name] ?? ""}
                          onChange={(value) =>
                            setValues((current) => ({ ...current, [arg.name]: value ?? "" }))
                          }
                          data={images.data ?? []}
                          placeholder={
                            images.isPending ? "Loading Docker images…" : "Select a Docker image"
                          }
                          size="md"
                          disabled={
                            images.isPending ||
                            images.isError ||
                            (images.data?.length ?? 0) === 0
                          }
                        />
                      ) : arg.name === "workspace_root" ? (
                        <WorkspacePicker
                          id={`create-${arg.name}`}
                          value={values[arg.name] ?? ""}
                          onOpenChange={setWorkspacePickerOpen}
                          onChange={(path) =>
                            setValues((current) => ({ ...current, [arg.name]: path }))
                          }
                        />
                      ) : (
                        <TextInput
                          id={`create-${arg.name}`}
                          type={arg.name === "count" ? "number" : undefined}
                          min={arg.name === "count" ? 1 : undefined}
                          step={arg.name === "count" ? 1 : undefined}
                          inputMode={arg.name === "count" ? "numeric" : undefined}
                          value={values[arg.name] ?? ""}
                          size="md"
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [arg.name]: event.target.value,
                            }))
                          }
                          placeholder={arg.help}
                        />
                      )}
                    </Input.Wrapper>
                  );
                })}
              </Stack>
              <Group className={classes.actions} justify="flex-end" gap="sm">
                <Button size="sm" variant="subtle" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="filled" type="submit" disabled={!spec}>
                  Create sandbox
                </Button>
              </Group>
            </form>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
