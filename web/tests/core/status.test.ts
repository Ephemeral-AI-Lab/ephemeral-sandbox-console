import { describe, expect, it } from "vitest";
import type { SandboxState } from "@/api/types";
import { displayStateFor, sandboxStatus } from "@/core/status";

describe("sandbox display-state policy", () => {
  it("derives Active only for a ready sandbox with confirmed active commands", () => {
    expect(displayStateFor("ready", 1)).toBe("active");
    expect(displayStateFor("ready", 0)).toBe("ready");
    expect(displayStateFor("ready", null)).toBe("ready");
    expect(displayStateFor("ready", Number.NaN)).toBe("ready");
    expect(displayStateFor("stopping", 4)).toBe("stopping");
  });

  it.each<[
    SandboxState,
    string,
    string,
  ]>([
    ["ready", "Ready", "success"],
    ["creating", "Creating", "warning"],
    ["stopping", "Stopping", "walnut"],
    ["stopped", "Stopped", "neutral"],
    ["failed", "Failed", "danger"],
  ])("maps %s to truthful label and tone", (state, label, tone) => {
    expect(sandboxStatus(state, 0)).toMatchObject({
      state,
      lifecycleState: state,
      label,
      tone,
      pulse: false,
    });
  });

  it("marks only Active as eligible to pulse", () => {
    expect(sandboxStatus("ready", 2)).toEqual({
      state: "active",
      lifecycleState: "ready",
      label: "Active",
      tone: "active",
      pulse: true,
    });
  });
});
