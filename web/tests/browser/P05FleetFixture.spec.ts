import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { measureInputToPaintP95 } from "./performance";

type SandboxState = "creating" | "ready" | "stopping" | "stopped" | "failed";

type SandboxRecord = ReturnType<typeof record>;

function record(
  id: string,
  state: SandboxState = "ready",
  workspaceRoot = `/workspaces/${id}`,
) {
  return {
    id,
    workspace_root: workspaceRoot,
    state,
    daemon: state === "ready" ? { host: "127.0.0.1", port: 7801 } : null,
    daemon_http: state === "ready" ? { host: "127.0.0.1", port: 7802 } : null,
    shared_base: null,
    activity_revision: 1,
  };
}

function records(count: number, states: SandboxState[] = ["ready"]) {
  return Array.from({ length: count }, (_, index) =>
    record(
      `sandbox-${String(index + 1).padStart(2, "0")}`,
      states[index % states.length],
    ),
  );
}

const sample = {
  ts: 1_700_000_000_000,
  sample_delta_ms: 5_000,
  metrics: { mem_cur: 24_000_000, disk_bytes: 4_000_000, files: 17 },
  deltas: { cpu_usec: 12_000 },
};

type ResourceSample = typeof sample;

function snapshotFor(
  list: SandboxRecord[],
  activeCommandsById: Readonly<Record<string, number>> | undefined,
) {
  const defaultActiveId = list.find((entry) => entry.state === "ready")?.id;

  return {
    sandboxes: list.map((entry, index) => {
      const activeCount = activeCommandsById
        ? (activeCommandsById[entry.id] ?? 0)
        : entry.id === defaultActiveId
          ? 1
          : 0;

      return {
        sandbox_id: entry.id,
        lifecycle_state: entry.state,
        availability: entry.state === "ready" ? "available" : "pending",
        sampled_at_unix_ms: 1_700_000_000_000,
        errors: [],
        daemon: entry.daemon
          ? { daemon_pid: index + 1, runtime_dir: `/runtime/${entry.id}` }
          : null,
        resources: { latest: sample, history: [sample] },
        workspaces:
          entry.state === "ready"
            ? [
                {
                  workspace_id: `workspace-${index + 1}`,
                  lifecycle_state: "running",
                  network_profile: "shared",
                  layers: { base_root_hash: `root-${index + 1}`, layer_count: 2 },
                  namespace_fd_count: 3,
                  resources: { latest: sample, history: [sample] },
                  active_namespace_executions: Array.from(
                    { length: activeCount },
                    (_, commandIndex) => ({
                      namespace_execution_id: `fixture-command-${index}-${commandIndex}`,
                      operation: "exec",
                      lifecycle_state: "running",
                    }),
                  ),
                },
              ]
            : [],
        stack: { layer_count: 2, layers_bytes: 6_000_000, active_leases: 1 },
      };
    }),
  };
}

const catalog = {
  management: {
    operation_execution_space: "manager",
    families: [],
    routes: [],
    operations: [
      {
        name: "create_sandbox",
        family: "sandbox",
        summary: "Create a deterministic fixture sandbox.",
        description: "",
        related: [],
        args: [
          {
            name: "name",
            kind: "string",
            required: true,
            help: "Unique sandbox name.",
            default: "fixture-new",
          },
          {
            name: "image",
            kind: "string",
            required: true,
            help: "Docker image.",
            default: "node:22-alpine",
          },
          {
            name: "workspace_root",
            kind: "path",
            required: true,
            help: "Host workspace folder.",
            default: "/synthetic-large",
          },
          {
            name: "count",
            kind: "integer",
            required: false,
            help: "Worker count.",
            default: "1",
          },
        ],
      },
    ],
  },
  runtime: {
    operation_execution_space: "runtime",
    families: [],
    routes: [],
    operations: [],
  },
  observability: {
    operation_execution_space: "observability",
    families: [],
    routes: [],
    operations: [],
  },
};

type FixtureOptions = {
  list?: SandboxRecord[];
  failList?: boolean;
  failAfterFirstList?: boolean;
  listDelayMs?: number;
  activeCommandsById?: Record<string, number>;
  failSnapshotIds?: string[];
  usageById?: Record<string, ResourceSample[]>;
  emptyUsageIds?: string[];
};

async function installFleetApi(page: Page, options: FixtureOptions = {}) {
  let list = [
    ...(options.list ??
      records(7, ["ready", "ready", "failed", "creating", "stopped"])),
  ];
  let listCalls = 0;
  const failSnapshotIds = new Set(options.failSnapshotIds ?? []);
  const emptyUsageIds = new Set(options.emptyUsageIds ?? []);
  const rootDirectories = Array.from({ length: 500 }, (_, index) => ({
    name: `root-folder-${String(index + 1).padStart(3, "0")}`,
    path: `/root-folder-${index + 1}`,
  }));
  const largeDirectories = Array.from({ length: 10_000 }, (_, index) => ({
    name: `folder-${index + 1}`,
    path: `/synthetic-large/folder-${index + 1}`,
  }));

  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(catalog),
    }),
  );
  await page.route("**/api/sandboxes/*/health", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  await page.route("**/api/rpc", async (route) => {
    const { op, scope, args } = route.request().postDataJSON() as {
      op: string;
      scope: { kind: "system" } | { kind: "sandbox"; sandbox_id: string };
      args: Record<string, unknown>;
    };

    if (op === "list_sandboxes") {
      listCalls += 1;
      if (options.listDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
      }
      if (options.failList || (options.failAfterFirstList && listCalls > 1)) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              kind: "gateway_unavailable",
              message: "fixture gateway unavailable",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sandboxes: list }),
      });
      return;
    }

    if (op === "snapshot") {
      const sandboxId = scope.kind === "sandbox" ? scope.sandbox_id : null;
      if (sandboxId && failSnapshotIds.has(sandboxId)) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              kind: "snapshot_unavailable",
              message: "fixture snapshot unavailable",
            },
          }),
        });
        return;
      }
      const snapshots = snapshotFor(list, options.activeCommandsById);
      const body = sandboxId
        ? snapshots.sandboxes.find((entry) => entry.sandbox_id === sandboxId)
        : snapshots;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }

    if (op === "cgroup") {
      const sandboxId = scope.kind === "sandbox" ? scope.sandbox_id : "";
      const series = emptyUsageIds.has(sandboxId)
        ? []
        : (options.usageById?.[sandboxId] ?? [sample]);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          view: "cgroup",
          scope: "sandbox",
          series,
          topology: {
            schema_version: 2,
            available: false,
            source: null,
            error: null,
            truncated: false,
            warnings: [],
            workspaces: [],
          },
        }),
      });
      return;
    }

    if (op === "destroy_sandbox") {
      const sandboxId = String(args.sandbox_id ?? "");
      list = list.filter((entry) => entry.id !== sandboxId);
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `event: log\ndata: ${JSON.stringify({ line: `destroying ${sandboxId}` })}\n\n` +
          `event: result\ndata: ${JSON.stringify({ destroyed: true })}\n\n`,
      });
      return;
    }

    if (op === "list_docker_images") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ images: ["node:22-alpine", "python:3.13-slim"] }),
      });
      return;
    }

    if (op === "list_workspace_directories") {
      const path = typeof args.path === "string" ? args.path : null;
      const body =
        path === "/synthetic-large"
          ? { path, parent: null, truncated: false, directories: largeDirectories }
          : path === null
            ? { path: null, parent: null, truncated: true, directories: rootDirectories }
            : {
                path,
                parent: "/synthetic-large",
                truncated: false,
                directories: [],
              };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }

    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          kind: "fixture_error",
          message: `unexpected operation ${op}`,
        },
      }),
    });
  });
}

async function openFleet(
  page: Page,
  options: FixtureOptions = {},
  query = "",
) {
  await installFleetApi(page, options);
  await page.goto(`/p05-fleet.html${query}`);
}

function card(page: Page, sandboxId: string): Locator {
  return page.locator("[data-fleet-card]").filter({
    has: page.getByText(sandboxId, { exact: true }),
  });
}

function metric(page: Page, label: string): Locator {
  return page.locator("[data-dashboard-metric]").filter({ hasText: label });
}

async function expectMetric(page: Page, label: string, value: string) {
  const item = metric(page, label);
  await expect(item).toBeVisible();
  await expect(item).toContainText(value);
}

function distinctPositions(values: number[], tolerance = 3): number[] {
  return values.reduce<number[]>((positions, value) => {
    if (!positions.some((position) => Math.abs(position - value) <= tolerance)) {
      positions.push(value);
    }
    return positions;
  }, []);
}

const requiredViewports = [
  { width: 375, height: 812, cardColumns: 1, metricColumns: 2, headerHeight: 64 },
  { width: 768, height: 1024, cardColumns: 2, metricColumns: 2, headerHeight: 80 },
  { width: 1024, height: 768, cardColumns: 2, metricColumns: 2, headerHeight: 80 },
  { width: 1440, height: 900, cardColumns: 3, metricColumns: 4, headerHeight: 80 },
] as const;

for (const { width, height } of requiredViewports) {
  test(`P05 Fleet redesign at ${width}x${height} @visual`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openFleet(page);
    await expect(page.locator("[data-fleet-card]")).toHaveCount(7);
    await expectMetric(page, "Active Commands", "1");
    await expectMetric(page, "Avg Memory", "22.9 MiB");
    await expect(page).toHaveScreenshot(`p05-fleet-mixed-${width}x${height}.png`, {
      animations: "disabled",
    });
  });
}

test("P05 header, connection, summary, and page landmarks use the Phase 1 surface", async ({
  page,
}) => {
  await openFleet(page);
  await expect(page.locator("[data-fleet-card]")).toHaveCount(7);

  await expect(
    page.getByRole("link", { name: "Ephemeral Sandbox dashboard" }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Console Connected" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", {
      name: "Dashboard",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "New Sandbox" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Your sandboxes" })).toBeVisible();
  await expect(page.locator("main#main-content")).toBeVisible();
  await expect(
    page.locator("footer").filter({ has: page.locator("[data-connection-state]") }),
  ).toContainText("Ephemeral Sandbox");

  await expectMetric(page, "Total Sandboxes", "7");
  await expectMetric(page, "Ready", "4");
  await expectMetric(page, "Active Commands", "1");
  await expectMetric(page, "Avg Memory", "22.9 MiB");
});

for (const {
  width,
  height,
  cardColumns,
  metricColumns,
  headerHeight,
} of requiredViewports) {
  test(`P05 uses ${cardColumns}/${metricColumns} responsive columns without overflow at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const longId = `sandbox-${"long-identifier-".repeat(6)}tail`;
    const list = [
      record(longId, "ready", `/workspace/${"deep-directory/".repeat(12)}project`),
      ...records(6, ["ready", "failed", "creating", "stopping", "stopped"]),
    ];
    await openFleet(page, { list, activeCommandsById: { [longId]: 1 } });
    const cards = page.locator("[data-fleet-card]");
    await expect(cards).toHaveCount(7);
    await expectMetric(page, "Active Commands", "1");

    const cardBoxes = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    );
    const metricBoxes = await page.locator("[data-dashboard-metric]").evaluateAll(
      (elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x, width: box.width };
        }),
    );
    const layout = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>("[data-fleet-board]");
      const header = document.querySelector<HTMLElement>("[data-console-shell] header");
      return {
        bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        boardOverflowX: board ? getComputedStyle(board).overflowX : "",
        headerHeight: header?.getBoundingClientRect().height ?? 0,
        headerPosition: header ? getComputedStyle(header).position : "",
      };
    });

    expect(distinctPositions(cardBoxes.map((box) => box.x))).toHaveLength(cardColumns);
    expect(distinctPositions(metricBoxes.map((box) => box.x))).toHaveLength(metricColumns);
    expect(layout.bodyOverflow).toBe(false);
    expect(layout.boardOverflowX).toBe("hidden");
    expect(layout.headerHeight).toBeCloseTo(headerHeight, 0);
    expect(layout.headerPosition).toBe("fixed");
    expect(cardBoxes.every((box) => box.width > 0 && box.height >= 300)).toBe(true);
    expect(
      [...cardBoxes, ...metricBoxes].every(
        (box) => box.x >= 0 && box.x + box.width <= width + 1,
      ),
    ).toBe(true);

    const mascot = page.locator('img[src*="ephemeral-sandbox-mascot"]');
    if (width < 768) await expect(mascot).toBeHidden();
    else await expect(mascot).toBeVisible();
  });
}

test("P05 search persists in q and matches ID, lifecycle, derived state, and workspace", async ({
  page,
}) => {
  const list = [
    record("Alpha-Primary", "ready", "/projects/fir-tree"),
    record("beta-ready", "ready", "/workspaces/citrus"),
    record("gamma-failed", "failed", "/workspaces/ember"),
    record("delta-stopping", "stopping", "/workspaces/ocean"),
  ];
  await openFleet(
    page,
    {
      list,
      activeCommandsById: { "Alpha-Primary": 2, "beta-ready": 0 },
    },
    "?q=ALPHA",
  );
  const search = page.getByRole("textbox", { name: "Search sandboxes" });
  await expect(search).toHaveValue("ALPHA");
  await expect(page.locator("[data-fleet-card]")).toHaveCount(1);
  await expect(card(page, "Alpha-Primary")).toBeVisible();

  for (const [query, expectedIds] of [
    ["ACTIVE", ["Alpha-Primary"]],
    ["READY", ["Alpha-Primary", "beta-ready"]],
    ["failed", ["gamma-failed"]],
    ["/WORKSPACES/EMBER", ["gamma-failed"]],
  ] as const) {
    await search.fill(query);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe(query);
    await expect(page.locator("[data-fleet-card]")).toHaveCount(expectedIds.length);
    for (const sandboxId of expectedIds) await expect(card(page, sandboxId)).toBeVisible();
  }

  await search.fill("");
  await expect.poll(() => new URL(page.url()).searchParams.has("q")).toBe(false);
  await page.getByRole("heading", { level: 1, name: "Your sandboxes" }).click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("gamma");
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue("gamma");
  expect(new URL(page.url()).searchParams.get("q")).toBe("gamma");
});

test("P05 no-match state keeps the query visible and truthful @visual", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openFleet(page, { list: records(3) }, "?q=not-present");
  await expect(page.locator("[data-fleet-empty]")).toContainText("No matches");
  await expect(page.locator("[data-fleet-empty]")).toContainText("not-present");
  await expect(page.getByRole("textbox", { name: "Search sandboxes" })).toHaveValue(
    "not-present",
  );
  await expect(page).toHaveScreenshot("p05-fleet-no-match-375x812.png", {
    animations: "disabled",
  });
});

test("P05 initial loading announces skeletons before confirmed data @visual", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openFleet(page, { listDelayMs: 1_000 });
  await expect(page.locator("[data-fleet-loading]")).toBeVisible();
  await expect(page.getByText("Loading sandboxes…", { exact: true })).toBeAttached();
  await expect(page.locator("[data-dashboard-metric] .mantine-Skeleton-root")).toHaveCount(4);
  await expect(page).toHaveScreenshot("p05-fleet-loading-375x812.png", {
    animations: "disabled",
  });
  await expect(page.locator("[data-fleet-card]")).toHaveCount(7);
});

test("P05 empty and disconnected states remain explicit @visual", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openFleet(page, { list: [] });
  await expect(page.locator("[data-fleet-empty]")).toContainText("No sandboxes yet");
  await expectMetric(page, "Total Sandboxes", "0");
  await expectMetric(page, "Ready", "0");
  await expectMetric(page, "Active Commands", "0");
  await expectMetric(page, "Avg Memory", "—");
  await expect(page).toHaveScreenshot("p05-fleet-empty-375x812.png", {
    animations: "disabled",
  });

  const disconnectedPage = await page.context().newPage();
  await disconnectedPage.setViewportSize({ width: 375, height: 812 });
  await installFleetApi(disconnectedPage, { failList: true });
  await disconnectedPage.goto("/p05-fleet.html");
  await expect(disconnectedPage.locator("[data-fleet-error]")).toContainText(
    "Gateway unavailable",
  );
  await expect(
    disconnectedPage.getByRole("status", { name: "Console Disconnected" }),
  ).toBeVisible();
  await expectMetric(disconnectedPage, "Total Sandboxes", "—");
  await expectMetric(disconnectedPage, "Ready", "—");
  await expectMetric(disconnectedPage, "Active Commands", "—");
  await expectMetric(disconnectedPage, "Avg Memory", "—");
  await expect(disconnectedPage).toHaveScreenshot(
    "p05-fleet-disconnected-375x812.png",
    { animations: "disabled" },
  );
  await disconnectedPage.close();
});

test("P05 missing snapshots and cgroup samples render unknown, never zero @visual", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const sandboxId = "missing-telemetry";
  await openFleet(page, {
    list: [record(sandboxId)],
    failSnapshotIds: [sandboxId],
    emptyUsageIds: [sandboxId],
  });
  const sandboxCard = card(page, sandboxId);
  await expect(sandboxCard).toBeVisible();
  await expectMetric(page, "Total Sandboxes", "1");
  await expectMetric(page, "Ready", "1");
  await expectMetric(page, "Active Commands", "—");
  await expectMetric(page, "Avg Memory", "—");
  await expect(sandboxCard.getByText("—", { exact: true })).toHaveCount(4);
  await expect(page).toHaveScreenshot("p05-fleet-missing-data-375x812.png", {
    animations: "disabled",
  });
});

test("P05 preserves cached data and marks refresh failure as stale @visual", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFleet(page, { failAfterFirstList: true });
  await expect(page.locator("[data-fleet-card]")).toHaveCount(7);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const alert = page.getByRole("alert", { name: "Sandbox refresh failed" });
  await expect(alert).toContainText("Showing the last confirmed sandbox data");
  await expect(page.locator("[data-fleet-card]")).toHaveCount(7);
  await expect(page.getByRole("status", { name: "Console Stale data" })).toBeVisible();
  await expect(page.locator('[data-connection-state="stale"]')).toContainText(
    "showing stale data",
  );
  await expect(page).toHaveScreenshot("p05-fleet-stale-1440x900.png", {
    animations: "disabled",
  });
});

test("P05 lifecycle and derived states expose truthful actions @visual", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const list = [
    record("ready-active", "ready"),
    record("ready-idle", "ready"),
    record("creating-now", "creating"),
    record("stopping-now", "stopping"),
    record("stopped-now", "stopped"),
    record("failed-now", "failed"),
  ];
  await openFleet(page, {
    list,
    activeCommandsById: {
      "ready-active": 2,
      "ready-idle": 0,
      "failed-now": 3,
    },
  });
  await expect(card(page, "ready-active").getByText("Active", { exact: true })).toBeVisible();
  await expect(card(page, "ready-active").getByRole("link", { name: "Open" })).toBeVisible();
  await expect(card(page, "ready-idle").getByText("Ready", { exact: true })).toBeVisible();
  await expect(card(page, "creating-now").getByText("Creating", { exact: true })).toBeVisible();
  await expect(card(page, "creating-now").getByRole("button", { name: "Creating…" })).toBeDisabled();
  await expect(card(page, "stopping-now").getByText("Stopping", { exact: true })).toBeVisible();
  await expect(card(page, "stopping-now").getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await expect(card(page, "stopped-now").getByRole("link", { name: "Inspect" })).toBeVisible();
  await expect(card(page, "failed-now").getByText("Failed", { exact: true })).toBeVisible();
  await expect(card(page, "failed-now").getByRole("link", { name: "Inspect" })).toBeVisible();
  await expect(card(page, "failed-now")).toContainText("failed to reach ready");
  await expect(page).toHaveScreenshot("p05-fleet-lifecycle-1440x900.png", {
    animations: "disabled",
  });
});

test("P05 Open and Inspect use keyboard activation and encoded detail routes", async ({
  page,
}) => {
  const readyId = "ready / encoded";
  const failedId = "failed detail";
  await openFleet(page, {
    list: [record(readyId), record(failedId, "failed")],
    activeCommandsById: { [readyId]: 1 },
  });
  await expect(page.locator("[data-fleet-card]")).toHaveCount(2);

  const open = card(page, readyId).getByRole("link", { name: "Open" });
  await open.focus();
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-fixture-sandbox-route]")).toBeVisible();
  await expect(page.locator("[data-fixture-sandbox-id]")).toHaveText(readyId);
  expect(new URL(page.url()).pathname).toBe(
    "/p05-fleet.html/sandboxes/ready%20%2F%20encoded",
  );

  await page.goBack();
  await expect(page.locator("[data-fleet-card]")).toHaveCount(2);
  const inspect = card(page, failedId).getByRole("link", { name: "Inspect" });
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-fixture-sandbox-id]")).toHaveText(failedId);
  expect(new URL(page.url()).pathname).toBe(
    "/p05-fleet.html/sandboxes/failed%20detail",
  );
});

test("P05 Destroy remains inert until typed confirmation and then refreshes Fleet", async ({
  page,
}) => {
  const sandboxId = "destroy-me";
  const destroyRequests: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/rpc") && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.op === "destroy_sandbox") destroyRequests.push(body);
    }
  });
  await openFleet(page, { list: [record(sandboxId, "stopped")] });

  const trigger = card(page, sandboxId).getByRole("button", {
    name: `Destroy ${sandboxId}`,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Destroy sandbox" });
  await expect(dialog).toBeVisible();
  expect(destroyRequests).toHaveLength(0);

  const confirmation = dialog.getByPlaceholder(sandboxId);
  const destroy = dialog.getByRole("button", { name: "Destroy sandbox" });
  await confirmation.fill("wrong-id");
  await expect(destroy).toBeDisabled();
  await confirmation.fill(sandboxId);
  await expect(destroy).toBeEnabled();
  await destroy.focus();
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(card(page, sandboxId)).toHaveCount(0);
  await expect(page.locator("[data-fleet-empty]")).toContainText("No sandboxes yet");
  expect(destroyRequests).toHaveLength(1);
  expect(destroyRequests[0]).toMatchObject({
    op: "destroy_sandbox",
    scope: { kind: "system" },
    args: { sandbox_id: sandboxId },
  });
});

test("P05 reduced motion removes entrance, hover, and active pulse motion @visual", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFleet(page, {
    list: [record("active-reduced-motion"), record("ready-reduced-motion")],
    activeCommandsById: {
      "active-reduced-motion": 1,
      "ready-reduced-motion": 0,
    },
  });
  const activeCard = card(page, "active-reduced-motion");
  await expect(activeCard.getByText("Active", { exact: true })).toBeVisible();
  const motion = await activeCard.evaluate((element) => {
    const cardStyle = getComputedStyle(element);
    const dot = element.querySelector<HTMLElement>("[data-pulse] span");
    const dotStyle = dot ? getComputedStyle(dot) : null;
    return {
      animationName: cardStyle.animationName,
      transitionDuration: cardStyle.transitionDuration,
      transform: cardStyle.transform,
      pulseAnimationName: dotStyle?.animationName ?? "missing",
    };
  });
  expect(motion.animationName).toBe("none");
  expect(motion.transitionDuration).toBe("0s");
  expect(motion.transform).toBe("none");
  expect(motion.pulseAnimationName).toBe("none");
  await expect(page).toHaveScreenshot("p05-fleet-reduced-motion-1440x900.png", {
    animations: "allow",
  });
});

test("P05 uses only repository-hosted fonts and artwork", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await openFleet(page, { list: [record("local-assets")] });
  await expect(card(page, "local-assets")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const mascot = page.locator('img[src*="ephemeral-sandbox-mascot"]');
  await expect(mascot).toHaveJSProperty("complete", true);
  await expect
    .poll(() => mascot.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  const forbidden = requests.filter((url) =>
    /fonts\.googleapis|fonts\.gstatic|tailwind|material-symbol|stitch|googleusercontent/i.test(
      url,
    ),
  );
  expect(forbidden).toEqual([]);
  expect(requests.some((url) => url.includes("/fonts/inter-latin-"))).toBe(true);
  expect(requests.some((url) => url.includes("/fonts/jetbrains-mono-latin-"))).toBe(
    true,
  );
  expect(requests.some((url) => url.includes("/brand/ephemeral-sandbox-mascot-"))).toBe(
    true,
  );
  expect(
    requests.every((url) => {
      const parsed = new URL(url);
      return parsed.hostname === "127.0.0.1";
    }),
  ).toBe(true);
});

test("P05 WorkspacePicker searches virtually, preserves the create draft, and restores focus @visual", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openFleet(page, { list: [record("picker-sandbox")] });
  await expect(page.locator("[data-fleet-card]")).toHaveCount(1);

  await page.getByRole("button", { name: "New Sandbox" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create sandbox" });
  await expect(createDialog).toBeVisible();
  const nameInput = createDialog.locator("#create-name");
  await nameInput.fill("preserve-this-draft");
  const workspaceTrigger = createDialog.locator("#create-workspace_root");
  await workspaceTrigger.focus();
  await workspaceTrigger.click();

  const pickerDialog = page.getByRole("dialog", { name: "Select workspace folder" });
  await expect(pickerDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pickerDialog).toBeHidden();
  await expect(workspaceTrigger).toBeFocused();
  await expect(nameInput).toHaveValue("preserve-this-draft");

  await workspaceTrigger.click();
  await expect(pickerDialog).toBeVisible();
  await pickerDialog.getByRole("button", { name: "Search child folders" }).click();
  const searchInput = pickerDialog.getByRole("textbox", {
    name: "Search child folders",
  });
  await expect(searchInput).toBeFocused();
  const renderedOptionCount = await pickerDialog
    .locator("[data-workspace-folder-option]")
    .count();
  expect(renderedOptionCount).toBeGreaterThan(0);
  expect(renderedOptionCount).toBeLessThan(64);
  const searchStartedAt = Date.now();
  await searchInput.fill("folder-9999");
  await expect(pickerDialog.getByRole("option", { name: "folder-9999" })).toBeVisible();
  expect(Date.now() - searchStartedAt).toBeLessThan(1_000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    pickerDialog.getByText("/synthetic-large/folder-9999", { exact: true }),
  ).toBeVisible();
  await pickerDialog.getByRole("button", { name: "Use this folder" }).click();
  await expect(pickerDialog).toBeHidden();
  await expect(workspaceTrigger).toContainText("/synthetic-large/folder-9999");

  await workspaceTrigger.click();
  await pickerDialog.getByRole("button", { name: "Roots" }).click();
  await expect(pickerDialog.locator("[data-workspace-picker-truncated]")).toContainText(
    "first 500 child folders",
  );
  await expect(page).toHaveScreenshot("p05-workspace-picker-truncated-375x812.png", {
    animations: "disabled",
  });
});

test("P12 keeps 10k WorkspacePicker filtering below the input-to-paint budget", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFleet(page, { list: [record("performance-picker")] });
  await page.getByRole("button", { name: "New Sandbox" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create sandbox" });
  await createDialog.locator("#create-workspace_root").click();
  const picker = page.getByRole("dialog", { name: "Select workspace folder" });
  await picker.getByRole("button", { name: "Search child folders" }).click();
  const input = picker.getByRole("textbox", { name: "Search child folders" });

  await measureInputToPaintP95(page, "WorkspacePicker 10k filter", async (iteration) => {
    const folder = `folder-${9_999 - iteration}`;
    await input.fill(folder);
    await expect(picker.getByRole("option", { name: folder })).toBeVisible();
  });
});

test("P05 creation and WorkspacePicker retain visible keyboard focus at 375x812 @visual", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openFleet(page, { list: [record("creation-sandbox")] });
  await expect(page.locator("[data-fleet-card]")).toHaveCount(1);

  const createTrigger = page.getByRole("button", { name: "New Sandbox" });
  await createTrigger.focus();
  await expect(createTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "Create sandbox" });
  await expect(createDialog).toBeVisible();
  await expect(page).toHaveScreenshot("p05-create-375x812.png", {
    animations: "disabled",
  });

  const nameInput = createDialog.locator("#create-name");
  await nameInput.fill("draft");
  await page.keyboard.press("/");
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue("draft/");

  const workspaceTrigger = createDialog.locator("#create-workspace_root");
  await workspaceTrigger.focus();
  await page.keyboard.press("Enter");
  const pickerDialog = page.getByRole("dialog", { name: "Select workspace folder" });
  await expect(pickerDialog).toBeVisible();
  const showSearch = pickerDialog.getByRole("button", { name: "Search child folders" });
  await showSearch.focus();
  await page.keyboard.press("Enter");
  await expect(
    pickerDialog.getByRole("textbox", { name: "Search child folders" }),
  ).toBeFocused();
  await expect(page).toHaveScreenshot("p05-workspace-picker-375x812.png", {
    animations: "disabled",
  });
});

test("P05 Fleet and creation surfaces have no Axe violations @a11y", async ({ page }) => {
  await openFleet(page, { list: records(3, ["ready", "failed", "stopped"]) });
  await expect(page.locator("[data-fleet-card]")).toHaveCount(3);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "New Sandbox" }).click();
  await expect(page.getByRole("dialog", { name: "Create sandbox" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
