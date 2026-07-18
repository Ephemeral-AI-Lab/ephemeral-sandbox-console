import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { measureFromTimestampToPaintP95 } from "./performance";

type TerminalApi = {
  createdProfiles: string[];
  destroyedSessions: string[];
  publishedSessions: string[];
  publishArgs: Record<string, unknown>[];
  execArgs: Record<string, unknown>[];
  stdinWrites: string[];
  snapshotCalls: number;
  readCalls: number;
  failedReadCalls: number;
  failTranscript: () => void;
  holdNextPublish: () => void;
  removeSession: (workspaceSessionId: string) => Promise<void>;
  releasePublish: () => void;
  setPublishOutcome: (outcome: PublishOutcome) => void;
};

type PublishOutcome = "commit" | "no-op" | "conflict" | "protected-drop" | "partial";

const FIXTURE_NOW = 1_700_003_600_000;

function transcriptLines(commandSessionId: string) {
  if (commandSessionId === "large-command") {
    return Array.from({ length: 10_000 }, (_, index) =>
      index === 5_000
        ? `line ${index} ${"x".repeat(10_000)}`
        : `line ${String(index).padStart(5, "0")} · terminal fixture output`,
    );
  }
  return [
    "fixture process started",
    "listening on port 5173",
    "awaiting input",
  ];
}

async function installTerminalApi(page: Page, failInitially = false): Promise<TerminalApi> {
  let transcriptFailure = failInitially;
  let readCalls = 0;
  let failedReadCalls = 0;
  let snapshotCalls = 0;
  const stdinWrites: string[] = [];
  const createdProfiles: string[] = [];
  const destroyedSessions: string[] = [];
  const publishedSessions: string[] = [];
  const publishArgs: Record<string, unknown>[] = [];
  const execArgs: Record<string, unknown>[] = [];
  let publishOutcome: PublishOutcome = "commit";
  let holdNextPublish = false;
  let releasePublish: (() => void) | null = null;
  let rejectedSessionToRestore: string | null = null;

  const updateSessionFixture = async (
    action: "remove" | "active" | "finalizing" | "finalize-failed",
    workspaceSessionId: string,
  ) => {
    await page.evaluate(
      ({ fixtureAction, sessionId }) => {
        window.dispatchEvent(new CustomEvent("p06-session-fixture", {
          detail: { action: fixtureAction, workspaceSessionId: sessionId },
        }));
      },
      { fixtureAction: action, sessionId: workspaceSessionId },
    );
  };

  await page.route("**/api/rpc", async (route) => {
    const { op, args } = route.request().postDataJSON() as {
      op: string;
      args: Record<string, unknown>;
    };

    if (op === "snapshot") {
      snapshotCalls += 1;
      if (rejectedSessionToRestore) {
        await updateSessionFixture("active", rejectedSessionToRestore);
        rejectedSessionToRestore = null;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sandboxes: [] }),
      });
      return;
    }

    if (op === "read_command_lines") {
      readCalls += 1;
      if (transcriptFailure) {
        failedReadCalls += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { kind: "gateway_unavailable", message: "fixture transcript unavailable" } }),
        });
        return;
      }
      const commandSessionId = String(args.command_session_id ?? "running-command");
      const lines = transcriptLines(commandSessionId);
      const start = Number(args.start_offset ?? 0);
      const limit = Number(args.limit ?? 1_000);
      const end = Math.min(start + limit, lines.length);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "running",
          exit_code: null,
          wall_time_seconds: 1,
          command_total_time_seconds: 1,
          start_offset: start,
          end_offset: end,
          total_lines: lines.length,
          original_token_count: 0,
          output: lines.slice(start, end).join("\n"),
          command_session_id: commandSessionId,
          workspace_session_id: "workspace-alpha",
        }),
      });
      return;
    }

    if (op === "write_command_stdin") {
      stdinWrites.push(String(args.stdin ?? ""));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
      return;
    }

    if (op === "exec_command") {
      execArgs.push(args);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "running",
          exit_code: null,
          wall_time_seconds: 0,
          command_total_time_seconds: 0,
          start_offset: 0,
          end_offset: 0,
          total_lines: 0,
          original_token_count: 0,
          output: "",
          command_session_id: "launched-command",
          workspace_session_id: args.workspace_session_id ?? "workspace-automatic",
        }),
      });
      return;
    }

    if (op === "create_workspace_session") {
      createdProfiles.push(String(args.network_profile ?? "shared"));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          workspace_session_id: "workspace-created",
          network_profile: args.network_profile ?? "shared",
          finalize_policy: "no_op",
        }),
      });
      return;
    }

    if (op === "publish_workspace_session") {
      const workspaceSessionId = String(args.workspace_session_id ?? "");
      publishedSessions.push(workspaceSessionId);
      publishArgs.push(args);
      if (holdNextPublish) {
        holdNextPublish = false;
        await new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
        releasePublish = null;
      }

      const publish = {
        no_op: publishOutcome === "no-op",
        revision: {
          manifest_version: publishOutcome === "no-op" ? 4 : 5,
          root_hash: publishOutcome === "no-op" ? "fixture-base" : "fixture-published",
          layer_count: publishOutcome === "no-op" ? 4 : 5,
        },
        route_summary: {
          source_count: publishOutcome === "no-op" ? 0 : 2,
          ignored_count: 0,
        },
      };

      if (publishOutcome === "conflict") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              kind: "operation_failed",
              message: "workspace session publish was rejected",
              details: {
                workspace_session_id: workspaceSessionId,
                stage: "publish",
                session_retained: true,
                publish_rejection: {
                  path: "notes.txt",
                  reason: "source_conflict",
                  source_conflict: {
                    path: "notes.txt",
                    expected: { kind: "file", digest: "expected", executable: false },
                    actual: { kind: "file", digest: "actual", executable: false },
                  },
                  protected_drop: null,
                  message: null,
                },
              },
            },
          }),
        });
        return;
      }

      if (publishOutcome === "protected-drop") {
        rejectedSessionToRestore = workspaceSessionId;
        await updateSessionFixture("finalizing", workspaceSessionId);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              kind: "operation_failed",
              message: "workspace session publish was rejected",
              details: {
                workspace_session_id: workspaceSessionId,
                stage: "capture",
                session_retained: true,
                publish_rejection: {
                  path: null,
                  reason: "protected_path",
                  source_conflict: null,
                  protected_drop: {
                    path: "run.fifo",
                    reason: "unsupported_special_file",
                    file_kind: "fifo",
                  },
                  message: null,
                },
              },
            },
          }),
        });
        return;
      }

      if (publishOutcome === "partial") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              kind: "operation_failed",
              message: "workspace session published but could not be closed",
              details: {
                workspace_session_id: workspaceSessionId,
                stage: "destroy",
                publish_completed: true,
                layer_committed: true,
                publish,
                destroyed: false,
                session_state: "finalize_failed",
                recovery_operation: "destroy_workspace_session",
              },
            },
          }),
        });
        await updateSessionFixture("finalize-failed", workspaceSessionId);
        return;
      }

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          workspace_session_id: workspaceSessionId,
          publish,
          destroyed: true,
          evicted_upperdir_bytes: publishOutcome === "no-op" ? 0 : 4096,
        }),
      });
      await updateSessionFixture("remove", workspaceSessionId);
      return;
    }

    if (op === "destroy_workspace_session") {
      destroyedSessions.push(String(args.workspace_session_id ?? ""));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          workspace_session_id: args.workspace_session_id,
          destroyed: true,
          evicted_upperdir_bytes: 4096,
        }),
      });
      await updateSessionFixture("remove", String(args.workspace_session_id ?? ""));
      return;
    }

    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: { kind: "fixture_error", message: `unexpected operation ${op}` } }),
    });
  });

  return {
    createdProfiles,
    destroyedSessions,
    publishedSessions,
    publishArgs,
    execArgs,
    stdinWrites,
    get readCalls() {
      return readCalls;
    },
    get failedReadCalls() {
      return failedReadCalls;
    },
    get snapshotCalls() {
      return snapshotCalls;
    },
    failTranscript: () => { transcriptFailure = true; },
    holdNextPublish: () => { holdNextPublish = true; },
    removeSession: (workspaceSessionId) =>
      updateSessionFixture("remove", workspaceSessionId),
    releasePublish: () => { releasePublish?.(); },
    setPublishOutcome: (outcome) => { publishOutcome = outcome; },
  };
}

async function openTerminal(page: Page, large = false, failInitially = false) {
  const api = await installTerminalApi(page, failInitially);
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`/p06-terminal.html${large ? "?large=1" : ""}`);
  await expect(page.locator("[data-terminal-workspace]")).toBeVisible();
  await expect(page.locator("[data-terminal-command]")).toHaveCount(large ? 1 : 3);
  return api;
}

async function openTerminalScenario(page: Page, query: string, commandCount = 3) {
  const api = await installTerminalApi(page);
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`/p06-terminal.html${query}`);
  await expect(page.locator("[data-terminal-workspace]")).toBeVisible();
  await expect(page.locator("[data-terminal-command]")).toHaveCount(commandCount);
  return api;
}

async function openExternalTerminal(page: Page) {
  const api = await installTerminalApi(page);
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/p06-terminal.html?external=1");
  await expect(page.locator("[data-terminal-workspace]")).toBeVisible();
  await expect(page.locator("[data-terminal-command]")).toHaveCount(1);
  return api;
}

for (const [width, height] of [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1440, 900],
] as const) {
  test(`P06 Terminal session navigation at ${width}x${height} @visual`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openTerminal(page);

    if (width < 768) {
      await expect(page.locator("[data-terminal-session-rail]")).toHaveCount(0);
      await page.getByRole("button", { name: "Open sessions" }).click();
      await expect(page.getByRole("dialog", { name: "Workspace sessions" })).toBeVisible();
    } else {
      await expect(page.locator("[data-terminal-session-rail]")).toBeVisible();
    }

    await expect(page).toHaveScreenshot(`p06-terminal-navigation-${width}x${height}.png`, {
      animations: "disabled",
    });
  });
}

test("P06 sidebar selection sets the execution target and blocks invalid inline timeouts @visual", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const api = await openTerminal(page);

  await page.getByRole("button", { name: "Open sessions" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace sessions" });
  await drawer.getByText("workspace-beta", { exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("[data-terminal-command]")).toHaveCount(1);
  await expect(page.getByText("Command in workspace-beta", { exact: true })).toBeVisible();
  await expect(page.locator("[data-terminal-session-picker]")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Command" }).fill("pwd");
  await page.getByLabel("Timeout in seconds").fill("45");
  await page.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => api.execArgs.at(-1)).toMatchObject({
    cmd: "pwd",
    timeout_ms: 45_000,
    workspace_session_id: "workspace-beta",
  });

  await page.getByRole("button", { name: "Open sessions" }).click();
  await page.getByRole("dialog", { name: "Workspace sessions" }).getByText("All commands", { exact: true }).click();
  await expect(page.locator("[data-terminal-command]")).toHaveCount(4);
  await expect(page.locator("[data-terminal-composer]")).toHaveCount(0);
  await expect(page.getByText("Choose a workspace session or Quick run to run a command.")).toBeVisible();

  await page.getByRole("button", { name: "Open sessions" }).click();
  await page.getByRole("dialog", { name: "Workspace sessions" }).getByText("workspace-beta", { exact: true }).click();

  const timeout = page.getByLabel("Timeout in seconds");
  await timeout.fill("0");
  await expect(page.getByText("Enter 1–86400 seconds.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Command" }).focus();
  await expect(page).toHaveScreenshot("p06-terminal-invalid-timeout-375x812.png", { animations: "disabled" });
});

test("P06 creates and safely discards explicit workspace sessions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);

  await page.getByRole("button", { name: "New workspace session" }).click();
  await page.getByText("Isolated session", { exact: true }).click();
  await expect.poll(() => api.createdProfiles).toEqual(["isolated"]);
  await expect(page.getByText("Workspace session created")).toBeVisible();
  await expect(page.getByText("Command in workspace-created", { exact: true })).toBeVisible();
  await expect(page.getByText("history: workspace-created")).toBeVisible();

  await page.getByRole("textbox", { name: "Command" }).fill("pwd");
  await page.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => api.execArgs.at(-1)?.workspace_session_id).toBe("workspace-created");
  expect(api.execArgs.at(-1)?.timeout_ms).toBe(300_000);

  const sessionRail = page.locator("[data-terminal-session-rail]");
  const activeSessionClose = sessionRail.getByRole("button", {
    name: "Close workspace session workspace-alpha",
  });
  await expect(activeSessionClose).toBeDisabled();
  await expect(activeSessionClose).toHaveAttribute("title", "Stop the active command first");
  await expect(sessionRail.getByText("Selected session")).toHaveCount(0);

  await sessionRail.getByText("workspace-alpha", { exact: true }).click();
  await expect(page.getByText("history: workspace-alpha")).toBeVisible();
  await sessionRail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Close workspace session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard & close" }).click();
  await expect.poll(() => api.destroyedSessions).toEqual(["workspace-beta"]);
  await expect(page.getByText("Workspace session discarded")).toBeVisible();
  await expect(page.getByText("history: workspace-alpha")).toBeVisible();
});

test("UI-01 close action and decision dialog are accessible, responsive, and busy-safe @a11y @visual", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);
  const rail = page.locator("[data-terminal-session-rail]");
  const activeClose = rail.getByRole("button", {
    name: "Close workspace session workspace-alpha",
  });
  await expect(activeClose).toBeDisabled();
  await activeClose.locator("..").hover();
  await expect(page.getByText("Stop the active command first", { exact: true })).toBeVisible();

  const closeBeta = rail.getByRole("button", {
    name: "Close workspace session workspace-beta",
  });
  await expect(closeBeta).toHaveCSS("height", "44px");
  await expect(closeBeta).toHaveCSS("width", "44px");
  await closeBeta.click();
  let dialog = page.getByRole("dialog", { name: "Close workspace session" });
  await expect(dialog).toContainText(
    "Choose what happens to this session's unpublished changes. Publishing merges them into the latest LayerStack snapshot when safe, then closes workspace-beta.",
  );
  await expect(dialog.getByRole("button", { name: "Publish to LayerStack & close" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Discard & close" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close workspace session dialog" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).disableRules("page-has-heading-one").analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(api.publishedSessions).toEqual([]);
  expect(api.destroyedSessions).toEqual([]);

  await closeBeta.click();
  dialog = page.getByRole("dialog", { name: "Close workspace session" });
  api.holdNextPublish();
  await dialog.getByRole("button", { name: "Publish to LayerStack & close" }).click();
  await expect.poll(() => api.publishedSessions).toEqual(["workspace-beta"]);
  await expect(dialog.getByRole("button", { name: "Publishing…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Discard & close" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(closeBeta).toBeDisabled();
  api.releasePublish();
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/p06-terminal.html?idle=1");
  await expect(page.locator("[data-terminal-workspace]")).toBeVisible();
  await page.getByRole("button", { name: "Open sessions" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace sessions" });
  const narrowClose = drawer.getByRole("button", {
    name: "Close workspace session workspace-beta",
  });
  await expect(narrowClose).toBeVisible();
  await narrowClose.click();
  dialog = page.getByRole("dialog", { name: "Close workspace session" });
  const cancelBox = await dialog.getByRole("button", { name: "Cancel" }).boundingBox();
  const discardBox = await dialog.getByRole("button", { name: "Discard & close" }).boundingBox();
  const publishBox = await dialog.getByRole("button", { name: "Publish to LayerStack & close" }).boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(discardBox).not.toBeNull();
  expect(publishBox).not.toBeNull();
  expect(discardBox!.y).toBeGreaterThan(cancelBox!.y);
  expect(publishBox!.y).toBeGreaterThan(discardBox!.y);
  await expect(drawer).toBeHidden();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).disableRules("page-has-heading-one").analyze()).violations).toEqual([]);
  await expect(page).toHaveScreenshot("ui-01-close-workspace-session-narrow-375x812.png", {
    animations: "disabled",
  });
});

test("UI-02 commit and no-op success close the row and select Quick run", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);
  const rail = page.locator("[data-terminal-session-rail]");

  await rail.getByText("workspace-beta", { exact: true }).click();
  await expect(page.getByText("history: workspace-beta")).toBeVisible();
  await rail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  await page.getByRole("dialog", { name: "Close workspace session" })
    .getByRole("button", { name: "Publish to LayerStack & close" })
    .click();
  await expect.poll(() => api.publishArgs).toEqual([{ workspace_session_id: "workspace-beta" }]);
  await expect(rail.getByText("workspace-beta", { exact: true })).toHaveCount(0);
  await expect(page.getByText("history: quick run · shared · auto-publish")).toBeVisible();
  await expect(page.getByText("Workspace session published")).toBeVisible();
  await expect(page.getByText("workspace-beta · manifest v5 · 5 layers")).toBeVisible();

  api.setPublishOutcome("no-op");
  await page.goto("/p06-terminal.html?idle=1");
  await expect(page.locator("[data-terminal-session-rail]")).toBeVisible();
  const reloadedRail = page.locator("[data-terminal-session-rail]");
  await reloadedRail.getByText("workspace-beta", { exact: true }).click();
  await reloadedRail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  await page.getByRole("dialog", { name: "Close workspace session" })
    .getByRole("button", { name: "Publish to LayerStack & close" })
    .click();
  await expect.poll(() => api.publishedSessions).toEqual(["workspace-beta", "workspace-beta"]);
  await expect(reloadedRail.getByText("workspace-beta", { exact: true })).toHaveCount(0);
  await expect(page.getByText("history: quick run · shared · auto-publish")).toBeVisible();
  await expect(page.getByText("No changes to publish; session closed")).toBeVisible();
});

test("UI-03 source conflict retains the row and selection with retry and discard guidance", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);
  api.setPublishOutcome("conflict");
  const rail = page.locator("[data-terminal-session-rail]");
  await rail.getByText("workspace-beta", { exact: true }).click();
  await rail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Close workspace session" });
  await dialog.getByRole("button", { name: "Publish to LayerStack & close" }).click();

  await expect(dialog.getByText("Publish conflict; session retained")).toBeVisible();
  await expect(dialog.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(dialog.getByText("source_conflict", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Inspect or edit the retained session, then retry publishing.");
  await expect(dialog.getByRole("button", { name: "Publish to LayerStack & close" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Discard & close" })).toBeEnabled();
  await expect(rail.getByText("workspace-beta", { exact: true })).toBeVisible();
  await expect(page.getByText("history: workspace-beta")).toBeVisible();

  api.setPublishOutcome("commit");
  await dialog.getByRole("button", { name: "Publish to LayerStack & close" }).click();
  await expect.poll(() => api.publishedSessions).toEqual(["workspace-beta", "workspace-beta"]);
  await expect(dialog).toBeHidden();
  await expect(rail.getByText("workspace-beta", { exact: true })).toHaveCount(0);
  await expect(page.getByText("history: quick run · shared · auto-publish")).toBeVisible();
});

test("UI-03 protected capture drop shows its nested path, reason, and recovery guidance", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);
  api.setPublishOutcome("protected-drop");
  const rail = page.locator("[data-terminal-session-rail]");
  await rail.getByText("workspace-beta", { exact: true }).click();
  await rail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Close workspace session" });
  await dialog.getByRole("button", { name: "Publish to LayerStack & close" }).click();

  await expect(dialog.getByText("Publish rejected; session retained")).toBeVisible();
  await expect(dialog.getByText("run.fifo", { exact: true })).toBeVisible();
  await expect(dialog.getByText("protected_path", { exact: true })).toBeVisible();
  await expect(dialog.getByText("unsupported_special_file", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Remove or replace this unsupported special file before retrying.");
  await expect.poll(() => api.snapshotCalls).toBe(1);
  await expect(rail.getByText("workspace-beta", { exact: true })).toBeVisible();
  await expect(page.getByText("history: workspace-beta")).toBeVisible();
  await expect(page.getByText("Command in workspace-beta", { exact: true })).toBeVisible();
});

test("P06 missing and snapshot-removed session selections fall back without stale execution targets", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const api = await openTerminalScenario(page, "?missing=1");

  await expect(page.getByText("history: quick run · shared · auto-publish")).toBeVisible();
  await expect(page.getByText("Quick run", { exact: true }).last()).toBeVisible();
  await page.getByRole("textbox", { name: "Command" }).fill("echo deep-link-safe");
  await page.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => api.execArgs.at(-1)?.cmd).toBe("echo deep-link-safe");
  expect(api.execArgs.at(-1)).not.toHaveProperty("workspace_session_id");

  await page.goto("/p06-terminal.html?idle=1");
  const rail = page.locator("[data-terminal-session-rail]");
  await expect(rail).toBeVisible();
  await rail.getByText("workspace-beta", { exact: true }).click();
  await expect(page.getByText("Command in workspace-beta", { exact: true })).toBeVisible();
  await api.removeSession("workspace-beta");
  await expect(page.getByText("history: quick run · shared · auto-publish")).toBeVisible();
  await expect(page.getByText("Command in workspace-beta", { exact: true })).toHaveCount(0);

  await page.getByRole("textbox", { name: "Command" }).fill("echo snapshot-safe");
  await page.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => api.execArgs.at(-1)?.cmd).toBe("echo snapshot-safe");
  expect(api.execArgs.at(-1)).not.toHaveProperty("workspace_session_id");
});

test("UI-04 post-commit close failure is cleanup-only before and after reload @visual", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);
  api.setPublishOutcome("partial");
  const rail = page.locator("[data-terminal-session-rail]");
  await rail.getByText("workspace-beta", { exact: true }).click();
  await rail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  let dialog = page.getByRole("dialog", { name: "Close workspace session" });
  await dialog.getByRole("button", { name: "Publish to LayerStack & close" }).click();

  await expect(dialog.getByText("Published; cleanup required", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish to LayerStack & close" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Discard & close" })).toBeEnabled();
  await expect(page.getByText("Published; cleanup required", { exact: true }).last()).toBeVisible();
  await expect(page.locator("[data-terminal-composer]")).toHaveCount(0);
  await expect(page.locator("[data-terminal-session-unavailable]")).toContainText(
    "Commands, files, and publishing are disabled.",
  );
  await expect(rail.getByText("isolated · 4 layers · cleanup required", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("ui-04-published-cleanup-required-1440x900.png", {
    animations: "disabled",
  });

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rail.getByText("workspace-beta", { exact: true })).toBeVisible();
  await page.goto("/p06-terminal.html?cleanup=1");
  await expect(page.getByText("history: workspace-beta")).toBeVisible();
  await expect(page.locator("[data-terminal-composer]")).toHaveCount(0);
  await expect(page.locator("[data-terminal-session-unavailable]")).toContainText(
    "Commands, files, and publishing are disabled.",
  );
  const reloadedRail = page.locator("[data-terminal-session-rail]");
  await reloadedRail.getByRole("button", { name: "Close workspace session workspace-beta" }).click();
  dialog = page.getByRole("dialog", { name: "Close workspace session" });
  await expect(dialog.getByText("Published; cleanup required", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish to LayerStack & close" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Discard & close" }).click();
  await expect.poll(() => api.destroyedSessions).toEqual(["workspace-beta"]);
  await expect(reloadedRail.getByText("workspace-beta", { exact: true })).toHaveCount(0);
  await expect(page.getByText("history: quick run · shared · auto-publish")).toBeVisible();
  await expect(page.getByText("Workspace session cleanup complete")).toBeVisible();
});

test("P06 automatic execution omits the workspace session id", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const api = await openTerminal(page);

  await expect(page.getByText("Quick run", { exact: true }).last()).toBeVisible();
  await expect(page.locator("[data-terminal-session-picker]")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Command" }).fill("pwd");
  await page.getByLabel("Timeout in seconds").press("Enter");
  await expect.poll(() => api.execArgs).toHaveLength(0);
  await expect(page.getByRole("textbox", { name: "Command" })).toBeFocused();
  await page.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => api.execArgs).toHaveLength(1);
  expect(api.execArgs[0]).toMatchObject({ cmd: "pwd", timeout_ms: 300_000, yield_time_ms: 0 });
  expect(api.execArgs[0]).not.toHaveProperty("workspace_session_id");
});

test("P06 hydrates and accepts stdin for a command started outside the browser", async ({ page }) => {
  const api = await openExternalTerminal(page);
  const toggle = page.getByRole("button", { name: "Expand command backend-interactive-loop" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const frame = page.locator("#terminal-running-command");
  await frame.getByRole("textbox", { name: "Standard input" }).fill("hello from browser");
  await frame.getByRole("button", { name: "Send line" }).click();
  await expect.poll(() => api.stdinWrites).toEqual(["hello from browser\n"]);
});

test("P06 keeps stale transcript output, authoritative publish rejection, and one control write visible @visual", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await openTerminal(page);
  await expect(page.locator("[data-terminal-line]")).toHaveCount(3);
  await expect(page.getByText("publish rejected · protected_path")).toBeVisible();

  const frame = page.locator("#terminal-running-command");
  await frame.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("c");
  await page.keyboard.up("Control");
  await expect.poll(() => api.stdinWrites).toEqual(["\u0003"]);

  const readsBeforeFailure = api.readCalls;
  api.failTranscript();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.readCalls).toBeGreaterThan(readsBeforeFailure);
  await expect.poll(() => api.failedReadCalls).toBeGreaterThan(0);
  await expect(page.locator("[data-terminal-transcript-stale]")).toBeVisible();
  await expect(page).toHaveScreenshot("p06-terminal-stale-rejected-1440x900.png", { animations: "disabled" });
});

test("P06 virtualizes 10k lines, contains a 10k-character line, and preserves tail navigation @visual", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTerminal(page, true);
  const transcript = page.locator("[data-terminal-transcript]");
  await expect(transcript).toContainText("line 09999");
  await expect.poll(() => transcript.locator("[data-terminal-line]").count()).toBeLessThan(128);

  await transcript.evaluate(async (element) => {
    element.scrollTop = 5_000 * 18;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const longLine = transcript.locator('[data-index="5000"]');
  await longLine.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  await longLine.evaluate((line) => {
    const pane = line.closest<HTMLElement>("[data-terminal-transcript]")!;
    const lineTop = line.getBoundingClientRect().top;
    const paneRect = pane.getBoundingClientRect();
    const paddingTop = Number.parseFloat(getComputedStyle(pane).paddingTop);
    pane.scrollTop = Math.round(pane.scrollTop + lineTop - paneRect.top - paddingTop);
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(longLine).toBeInViewport();
  const midGeometry = await longLine.evaluate((line) => ({
    scrollWidth: line.scrollWidth,
    clientWidth: line.clientWidth,
  }));
  expect(midGeometry.scrollWidth).toBeLessThanOrEqual(midGeometry.clientWidth);
  await expect(page).toHaveScreenshot("p06-terminal-10k-mid-1440x900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.003,
  });

  await transcript.evaluate(async (element) => {
    element.scrollTop = element.scrollHeight;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await page.waitForTimeout(100);
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const lastLine = transcript.getByText("line 09999 · terminal fixture output");
  await lastLine.scrollIntoViewIfNeeded();
  await expect(lastLine).toBeInViewport();
  await expect(page).toHaveScreenshot("p06-terminal-10k-tail-1440x900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.003,
  });
});

test("P12 keeps 10k Terminal scrolling below the input-to-paint budget", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTerminal(page, true);
  const transcript = page.locator("[data-terminal-transcript]");

  await measureFromTimestampToPaintP95(page, "Terminal 10k scroll", async (iteration) => {
    const index = (iteration * 463 + 251) % 10_000;
    return transcript.evaluate((element, target) => {
      const startedAt = performance.now();
      element.scrollTop = target / 9_999 * (element.scrollHeight - element.clientHeight);
      return startedAt;
    }, index);
  });
});

test("P06 Terminal has no Axe violations in the expanded running state @a11y", async ({ page }) => {
  await openTerminal(page);
  await expect(page.locator("[data-terminal-line]")).toHaveCount(3);
  expect((await new AxeBuilder({ page }).disableRules("page-has-heading-one").analyze()).violations).toEqual([]);
});

test("P06 makes the last transcript output explicit when its initial refresh fails", async ({ page }) => {
  await openTerminal(page, false, true);
  await expect(page.locator("[data-terminal-transcript-stale]")).toBeVisible();
});
