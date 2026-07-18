import type { SandboxState } from "@/api/types";

export type SandboxDisplayState = SandboxState | "active";

/** Semantic tones; UI components decide how these map to theme colors. */
export type SandboxStatusTone =
  | "active"
  | "success"
  | "warning"
  | "walnut"
  | "neutral"
  | "danger";

export interface SandboxStatusPresentation {
  state: SandboxDisplayState;
  lifecycleState: SandboxState;
  label: "Active" | "Ready" | "Creating" | "Stopping" | "Stopped" | "Failed";
  tone: SandboxStatusTone;
  pulse: boolean;
}

const LIFECYCLE_PRESENTATION: Record<
  SandboxState,
  Omit<SandboxStatusPresentation, "lifecycleState">
> = {
  creating: {
    state: "creating",
    label: "Creating",
    tone: "warning",
    pulse: false,
  },
  ready: {
    state: "ready",
    label: "Ready",
    tone: "success",
    pulse: false,
  },
  stopping: {
    state: "stopping",
    label: "Stopping",
    tone: "walnut",
    pulse: false,
  },
  stopped: {
    state: "stopped",
    label: "Stopped",
    tone: "neutral",
    pulse: false,
  },
  failed: {
    state: "failed",
    label: "Failed",
    tone: "danger",
    pulse: false,
  },
};

const ACTIVE_PRESENTATION: Omit<SandboxStatusPresentation, "lifecycleState"> = {
  state: "active",
  label: "Active",
  tone: "active",
  pulse: true,
};

/** Active is derived only from confirmed commands on a manager-ready record. */
export function displayStateFor(
  lifecycleState: SandboxState,
  activeCommands: number | null | undefined,
): SandboxDisplayState {
  return lifecycleState === "ready" &&
    typeof activeCommands === "number" &&
    Number.isFinite(activeCommands) &&
    activeCommands > 0
    ? "active"
    : lifecycleState;
}

export function sandboxStatus(
  lifecycleState: SandboxState,
  activeCommands: number | null | undefined,
): SandboxStatusPresentation {
  const presentation =
    displayStateFor(lifecycleState, activeCommands) === "active"
      ? ACTIVE_PRESENTATION
      : LIFECYCLE_PRESENTATION[lifecycleState];

  return { ...presentation, lifecycleState };
}

/** Compatibility alias for consumers that describe the result as a view. */
export const statusPresentation = sandboxStatus;
