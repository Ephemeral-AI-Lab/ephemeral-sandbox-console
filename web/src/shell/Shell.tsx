import { useMemo, useState } from "react";
import {
  Anchor,
  AppShell,
  Box,
  Breadcrumbs,
  Burger,
  Button,
  Drawer,
  Group,
  Stack,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";
import { startGateway } from "@/api/gateway";
import { BRAND, PRODUCT_NAME } from "@/config/brand";
import {
  DashboardShellContext,
  type DashboardConnectionState,
} from "@/pages/dashboard/DashboardShellContext";
import styles from "@/shell/Shell.module.css";

const TAB_LABELS: Record<string, string> = {
  terminal: "Terminal",
  files: "Files",
  observability: "Observability",
  preview: "Preview",
};

const OBSERVABILITY_LABELS: Record<string, string> = {
  resources: "Resources",
  daemon: "Daemon",
  cgroup: "Processes",
  traces: "Traces",
  events: "Events",
  layerstack: "Layers",
};

const CONNECTION_LABELS: Record<DashboardConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  stale: "Stale data",
  disconnected: "Disconnected",
};

type Crumb = { label: string; to?: string };
type NavigationItem = { label: string; to: string; active: boolean };

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function crumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "sandboxes" || !parts[1]) return [];

  const sandboxPath = `/sandboxes/${parts[1]}`;
  const result: Crumb[] = [
    { label: "Dashboard", to: "/" },
    { label: decodePathSegment(parts[1]), to: sandboxPath },
  ];
  const tab = parts[2];
  if (!tab) return [...result, { label: "Terminal" }];
  if (TAB_LABELS[tab]) result.push({ label: TAB_LABELS[tab] });
  if (tab === "observability" && parts[3] && OBSERVABILITY_LABELS[parts[3]]) {
    result.push({ label: OBSERVABILITY_LABELS[parts[3]] });
  }
  return result;
}

function navigationItems(pathname: string): NavigationItem[] {
  const parts = pathname.split("/").filter(Boolean);
  const dashboard: NavigationItem = {
    label: "Dashboard",
    to: "/",
    active: pathname === "/",
  };
  if (parts[0] !== "sandboxes" || !parts[1]) return [dashboard];

  const base = `/sandboxes/${parts[1]}`;
  const item = (label: string, suffix = "", nested = false): NavigationItem => {
    const to = suffix ? `${base}/${suffix}` : base;
    const active = nested
      ? pathname === to
      : suffix === "observability"
        ? pathname === to || pathname.startsWith(`${to}/`)
        : pathname === to;
    return { label: nested ? `↳ ${label}` : label, to, active };
  };

  return [
    dashboard,
    item("Terminal", "terminal"),
    item("Files", "files"),
    item("Observability", "observability"),
    item("Resources", "observability/resources", true),
    item("Daemon", "observability/daemon", true),
    item("Processes", "observability/cgroup", true),
    item("Traces", "observability/traces", true),
    item("Events", "observability/events", true),
    item("Layers", "observability/layerstack", true),
    item("Preview", "preview"),
  ];
}

export function Shell() {
  const location = useLocation();
  const isDashboard = location.pathname === "/";
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [createLogs, setCreateLogs] = useState<string[] | null>(null);
  const [connection, setConnection] =
    useState<DashboardConnectionState>("connecting");
  const trail = crumbs(location.pathname);
  const items = navigationItems(location.pathname);
  const activeIndex = Math.max(
    0,
    items.reduce((active, item, index) => (item.active ? index : active), -1),
  );
  const shellState = useMemo(
    () => ({ connection, createLogs, setConnection, setCreateLogs }),
    [connection, createLogs],
  );
  const backendStart = useMutation({
    mutationFn: startGateway,
    onSuccess: () => window.location.reload(),
  });

  const focusActiveNavigation = () => {
    [...document.querySelectorAll<HTMLElement>("[data-shell-active-navigation]")]
      .find((element) => element.getClientRects().length > 0)
      ?.focus();
  };

  return (
    <DashboardShellContext.Provider value={shellState}>
      <AppShell
        className={styles.shell}
        data-console-shell
        data-dashboard-shell={isDashboard || undefined}
        header={{
          height: isDashboard
            ? "64px"
            : "52px",
        }}
        padding={0}
      >
        <Anchor href="#main-content" id="skip-link">
          Skip to main content
        </Anchor>
        <AppShell.Header
          className={`${styles.header} ${isDashboard ? styles.dashboardHeader : styles.detailHeader}`}
        >
          <Group className={styles.headerInner} gap="md" justify="space-between" wrap="nowrap">
            <Group gap="sm" miw={0} wrap="nowrap">
              {!isDashboard ? (
                <Burger
                  aria-label={navigationOpen ? "Close navigation" : "Open navigation"}
                  hiddenFrom="sm"
                  onClick={() => setNavigationOpen((opened) => !opened)}
                  opened={navigationOpen}
                  size="sm"
                />
              ) : null}
              <Anchor
                aria-label={`${PRODUCT_NAME} dashboard`}
                className={styles.brandLink}
                component={Link}
                to="/"
                underline="never"
              >
                <picture aria-hidden className={styles.brandMark}>
                  <source srcSet={BRAND.mascot.webpUrl} type="image/webp" />
                  <img
                    alt=""
                    draggable="false"
                    src={BRAND.mascot.pngUrl}
                  />
                </picture>
                <Text className={styles.brandName} fw={700} truncate>
                  {PRODUCT_NAME}
                </Text>
              </Anchor>
              {isDashboard ? (
                <Box
                  aria-label={`Console ${CONNECTION_LABELS[connection]}`}
                  className={styles.consolePill}
                  role="status"
                >
                  <span
                    aria-hidden
                    className={styles.connectionDot}
                    data-connection={connection}
                  />
                  <span>Console</span>
                  <VisuallyHidden> — {CONNECTION_LABELS[connection]}</VisuallyHidden>
                </Box>
              ) : null}
              {!isDashboard && trail.length > 0 ? (
                <Box data-console-breadcrumbs visibleFrom="sm">
                  <Breadcrumbs separator="›">
                    {trail.map((crumb) =>
                      crumb.to ? (
                        <Anchor
                          component={Link}
                          key={`${crumb.label}-${crumb.to}`}
                          size="sm"
                          to={crumb.to}
                        >
                          {crumb.label}
                        </Anchor>
                      ) : (
                        <Text c="dimmed" key={crumb.label} size="sm">
                          {crumb.label}
                        </Text>
                      ),
                    )}
                  </Breadcrumbs>
                </Box>
              ) : null}
            </Group>
          </Group>
        </AppShell.Header>

        <Drawer
          onClose={() => setNavigationOpen(false)}
          onEnterTransitionEnd={focusActiveNavigation}
          opened={navigationOpen}
          position="left"
          size="xs"
          title="Navigation"
        >
          <nav aria-label="Primary navigation">
            <Stack gap="xs">
              {items.map((item, index) => (
                <Button
                  component={Link}
                  data-shell-active-navigation={index === activeIndex || undefined}
                  justify="flex-start"
                  key={item.to}
                  onClick={() => setNavigationOpen(false)}
                  to={item.to}
                  variant={item.active ? "filled" : "subtle"}
                >
                  {item.label}
                </Button>
              ))}
            </Stack>
          </nav>
        </Drawer>

        <AppShell.Main
          className={isDashboard ? styles.dashboardMain : styles.detailMain}
          data-console-main
          id="main-content"
          tabIndex={-1}
        >
          <Outlet />
        </AppShell.Main>
        {isDashboard ? (
          <Box
            aria-live="polite"
            className={styles.backendControl}
            data-backend-control
          >
            {backendStart.isError ? (
              <Text className={styles.backendError}>
                {(backendStart.error as Error).message}
              </Text>
            ) : null}
            <Button
              className={styles.backendButton}
              data-backend-start-reload
              leftSection={<RefreshCw aria-hidden size={16} strokeWidth={1.9} />}
              loading={backendStart.isPending}
              onClick={() => backendStart.mutate()}
              title="Start backend and reload console"
              type="button"
            >
              Start/reload backend
            </Button>
          </Box>
        ) : null}
      </AppShell>
    </DashboardShellContext.Provider>
  );
}
