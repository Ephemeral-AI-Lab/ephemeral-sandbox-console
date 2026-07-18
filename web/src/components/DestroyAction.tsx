import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { rpcStream, systemScope } from "@/api/rpc";
import { useErrorToast } from "@/components/ErrorToast";
import { ActionIcon, Button } from "@mantine/core";

export function DestroyAction({
  sandboxId,
  label,
  touchTarget = false,
}: {
  sandboxId: string;
  label?: string;
  touchTarget?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { showError } = useErrorToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const destroy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await rpcStream(
        "destroy_sandbox",
        systemScope,
        { sandbox_id: sandboxId },
        () => undefined,
      );
      await queryClient.invalidateQueries({ queryKey: ["fleet"] });
      if (location.pathname !== "/") void navigate("/");
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return !label ? (
    <ActionIcon
      aria-label={`Destroy ${sandboxId}`}
      color="danger"
      disabled={busy}
      loading={busy}
      onClick={() => void destroy()}
      size={touchTarget ? 44 : 40}
      title={`Destroy ${sandboxId}`}
      variant="subtle"
    >
      <Trash2 aria-hidden size={18} />
    </ActionIcon>
  ) : (
    <Button
      size="compact-xs"
      color="danger"
      variant="filled"
      aria-label={`Destroy ${sandboxId}`}
      disabled={busy}
      loading={busy}
      onClick={() => void destroy()}
    >
      <Trash2 aria-hidden size={12} />
      {label}
    </Button>
  );
}
