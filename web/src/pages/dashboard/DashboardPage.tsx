import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Center,
  Skeleton,
  Stack,
  Text,
  TextInput,
  VisuallyHidden,
} from "@mantine/core";
import { Search } from "lucide-react";
import { useSearchParams } from "react-router";
import { rpc, systemScope } from "@/api/rpc";
import type { SandboxList } from "@/api/types";
import { BRAND, PRODUCT_NAME } from "@/config/brand";
import {
  currentFleetList,
  filterFleetRecords,
  hasFleetActivity,
  snapshotsBySandbox,
  stabilizeFleetList,
} from "@/core/fleet";
import { useFleetCurrentUsage } from "@/poll/useFleetCurrentUsage";
import { useFleetSnapshots } from "@/poll/useFleetSnapshots";
import { usePoll } from "@/poll/usePoll";
import { DashboardSummary } from "@/pages/dashboard/DashboardSummary";
import {
  type DashboardConnectionState,
  useDashboardShell,
} from "@/pages/dashboard/DashboardShellContext";
import { CreateSandboxModal } from "@/pages/fleet/CreateSandboxModal";
import { SandboxCard } from "@/pages/fleet/SandboxCard";
import styles from "@/pages/dashboard/DashboardPage.module.css";

const CONNECTION_LABELS: Record<DashboardConnectionState, string> = {
  connecting: "Connecting to gateway",
  connected: "Connected",
  stale: "Connected · showing stale data",
  disconnected: "Gateway disconnected",
};

function connectionFor(
  fleet: SandboxList | undefined,
  error: unknown,
): DashboardConnectionState {
  if (error) return fleet ? "stale" : "disconnected";
  return fleet ? "connected" : "connecting";
}

function LoadingCards() {
  return (
    <div aria-label="Loading sandboxes" className={styles.cardGrid} data-fleet-loading>
      <VisuallyHidden aria-live="polite">Loading sandboxes…</VisuallyHidden>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton height={314} key={index} radius={16} />
      ))}
    </div>
  );
}

export function DashboardPage() {
  const shell = useDashboardShell();
  const [localCreateLogs, setLocalCreateLogs] = useState<string[] | null>(null);
  const createLogs = shell?.createLogs ?? localCreateLogs;
  const setCreateLogs = shell?.setCreateLogs ?? setLocalCreateLogs;
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("q") ?? "";
  const searchRef = useRef<HTMLInputElement>(null);

  const list = usePoll({
    key: ["fleet", "list_sandboxes"],
    fn: () => rpc<SandboxList>("list_sandboxes", systemScope),
    mode: "slow",
  });
  const snapshot = useFleetSnapshots(list.data?.sandboxes ?? []);
  const lifecycleActive = hasFleetActivity(list.data, snapshot.data, createLogs);
  const listFast = usePoll({
    key: ["fleet", "list_sandboxes", "fast"],
    fn: () => rpc<SandboxList>("list_sandboxes", systemScope),
    mode: "fast",
    enabled: lifecycleActive,
  });

  const sourceFleet = currentFleetList(list.data, listFast.data, lifecycleActive);
  const previousOrder = useRef<string[]>([]);
  const fleet = useMemo(
    () => stabilizeFleetList(sourceFleet, previousOrder.current),
    [sourceFleet],
  );

  useEffect(() => {
    previousOrder.current = fleet?.sandboxes.map((record) => record.id) ?? [];
  }, [fleet]);

  const records = fleet?.sandboxes ?? [];
  const currentUsage = useFleetCurrentUsage(records);
  const snapshotMap = snapshotsBySandbox(snapshot.data);
  const visible = filterFleetRecords(records, filter, snapshot.data);
  const fleetError = lifecycleActive ? listFast.error ?? list.error : list.error;
  const isInitialLoading = list.isPending && !fleet;
  const connection = connectionFor(fleet, fleetError);
  const setShellConnection = shell?.setConnection;

  useEffect(() => {
    setShellConnection?.(connection);
  }, [connection, setShellConnection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const updateFilter = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  return (
    <Box
      className={styles.page}
      data-fleet-board
      data-route-scroll-owner="dashboard"
    >
      <div className={styles.pageInner}>
        <div aria-hidden className={styles.mascot}>
          <picture>
            <source srcSet={BRAND.mascot.webpUrl} type="image/webp" />
            <img
              alt={BRAND.mascot.decorativeAlt}
              className={styles.mascotImage}
              draggable="false"
              src={BRAND.mascot.pngUrl}
            />
          </picture>
        </div>

        <div className={styles.content}>
          {!shell ? (
            <div className={styles.fallbackAction}>
              <CreateSandboxModal onStream={setCreateLogs} />
            </div>
          ) : null}

          <DashboardSummary
            list={fleet}
            loading={isInitialLoading}
            snapshot={snapshot.data}
            usage={currentUsage.data}
          />

          <section aria-labelledby="dashboard-title" className={styles.collectionSection}>
            <div className={styles.collectionHeading}>
              <h1 className={styles.pageTitle} id="dashboard-title">
                Your sandboxes
              </h1>
              <TextInput
                aria-keyshortcuts="/"
                aria-label="Search sandboxes"
                className={styles.search}
                classNames={{ input: styles.searchInput }}
                data-fleet-filter
                leftSection={<Search aria-hidden size={18} strokeWidth={1.8} />}
                onChange={(event) => updateFilter(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.currentTarget.blur();
                }}
                placeholder="Search by ID, state, or workspace…"
                ref={searchRef}
                rightSection={<span className={styles.shortcut}>/</span>}
                rightSectionPointerEvents="none"
                value={filter}
              />
            </div>
            <hr className={styles.divider} />

            {fleetError && fleet ? (
              <Alert
                className={styles.feedback}
                color="warning"
                title="Sandbox refresh failed"
                variant="light"
              >
                Showing the last confirmed sandbox data. {(fleetError as Error).message}
                {" — retrying automatically."}
              </Alert>
            ) : null}

            {isInitialLoading ? (
              <LoadingCards />
            ) : fleetError && !fleet ? (
              <Center className={styles.statePanel} data-fleet-error>
                <Stack align="center" gap={0}>
                  <p className={styles.stateTitle}>Gateway unavailable</p>
                  <p className={styles.stateCopy}>
                    {(fleetError as Error).message} — check that the sandbox gateway is
                    running. The console will retry automatically.
                  </p>
                </Stack>
              </Center>
            ) : visible.length === 0 && fleet ? (
              <Center className={styles.statePanel} data-fleet-empty>
                <Stack align="center" gap="md">
                  <div>
                    <p className={styles.stateTitle}>
                      {records.length === 0 ? "No sandboxes yet" : "No matches"}
                    </p>
                    <p className={styles.stateCopy}>
                      {records.length === 0
                        ? "Create your first sandbox to begin an isolated workspace."
                        : `No sandbox matches “${filter}”. Try another ID, state, or workspace.`}
                    </p>
                  </div>
                  {records.length === 0 ? (
                    <CreateSandboxModal onStream={setCreateLogs} />
                  ) : null}
                </Stack>
              </Center>
            ) : (
              <div className={styles.cardGrid} data-fleet-card-collection>
                {visible.map((record, index) => (
                  <div
                    className={styles.cardCell}
                    key={record.id}
                    style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}
                  >
                    <SandboxCard
                      createLogs={
                        record.state === "creating" ? (createLogs ?? undefined) : undefined
                      }
                      record={record}
                      snapshot={snapshotMap.get(record.id)}
                      usage={currentUsage.data.get(record.id)}
                    />
                  </div>
                ))}
                {createLogs !== null &&
                !records.some((record) => record.state === "creating") ? (
                  <article className={styles.creationCard} data-fleet-creation-card>
                    <div className={styles.metadataLabel}>Creating sandbox</div>
                    <p className={styles.creationLog}>
                      {createLogs.length === 0 ? "Starting…" : createLogs.join("\n")}
                    </p>
                  </article>
                ) : null}
              </div>
            )}

            {(list.isFetching || listFast.isFetching) && fleet ? (
              <Text aria-hidden className={styles.refreshing} data-fleet-refreshing>
                Refreshing confirmed data…
              </Text>
            ) : null}
          </section>
        </div>

        <footer className={styles.footer}>
          <span>© {new Date().getFullYear()} {PRODUCT_NAME}.</span>
          <span
            aria-live="polite"
            className={styles.footerStatus}
            data-connection-state={connection}
          >
            <span
              aria-hidden
              className={styles.footerDot}
              data-connection={connection}
            />
            {CONNECTION_LABELS[connection]}
          </span>
        </footer>
      </div>
    </Box>
  );
}
