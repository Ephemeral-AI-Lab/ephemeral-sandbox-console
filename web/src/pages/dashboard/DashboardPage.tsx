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
import { Boxes, ChevronDown, Search } from "lucide-react";
import { useSearchParams } from "react-router";
import type { SandboxSnapshot } from "@/api/observability";
import { rpc, systemScope } from "@/api/rpc";
import type { SandboxList, SandboxRecord } from "@/api/types";
import { PRODUCT_NAME } from "@/config/brand";
import {
  currentFleetList,
  filterFleetRecords,
  hasFleetActivity,
  snapshotsBySandbox,
  stabilizeFleetList,
} from "@/core/fleet";
import type { SandboxCurrentUsage } from "@/core/resources";
import {
  listSandboxClusters,
  readSandboxClusters,
  resolveSandboxClusters,
  SANDBOX_CLUSTERS_CHANGED_EVENT,
  type ResolvedSandboxCluster,
} from "@/core/sandboxClusters";
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
import { RemoveClusterAction } from "@/components/RemoveClusterAction";
import styles from "@/pages/dashboard/DashboardPage.module.css";

const CONNECTION_LABELS: Record<DashboardConnectionState, string> = {
  connecting: "Connecting to gateway",
  connected: "Connected",
  stale: "Connected · showing stale data",
  disconnected: "Gateway disconnected",
};

type DashboardView = "sandbox" | "cluster";

interface ClusterSearchResult {
  cluster: ResolvedSandboxCluster;
  members: SandboxRecord[];
}

function connectionFor(
  fleet: SandboxList | undefined,
  error: unknown,
): DashboardConnectionState {
  if (error) return fleet ? "stale" : "disconnected";
  return fleet ? "connected" : "connecting";
}

function LoadingCards({ label = "Loading sandboxes" }: { label?: string }) {
  return (
    <div aria-label={label} className={styles.cardGrid} data-fleet-loading>
      <VisuallyHidden aria-live="polite">{label}…</VisuallyHidden>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton height={314} key={index} radius={16} />
      ))}
    </div>
  );
}

function SandboxClusterCollection({
  cluster,
  createLogs,
  members,
  snapshotMap,
  usage,
}: {
  cluster: ResolvedSandboxCluster;
  createLogs: string[] | null;
  members: SandboxRecord[];
  snapshotMap: ReadonlyMap<string, SandboxSnapshot>;
  usage: ReadonlyMap<string, SandboxCurrentUsage>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const readyCount = cluster.members.filter((member) => member.state === "ready").length;
  const readyLabel =
    readyCount === cluster.members.length
      ? `${readyCount} ready`
      : `${readyCount} of ${cluster.members.length} ready`;

  return (
    <article
      aria-label={`Sandbox cluster ${cluster.id}`}
      className={styles.clusterShell}
      data-sandbox-cluster
      data-sandbox-cluster-id={cluster.id}
    >
      <header className={styles.clusterHeader}>
        <div className={styles.clusterIdentity}>
          <span aria-hidden className={styles.clusterIcon}>
            <Boxes size={20} strokeWidth={1.8} />
          </span>
          <div className={styles.clusterCopy}>
            <div className={styles.clusterTitleRow}>
              <span className={styles.clusterTitle}>{cluster.id}</span>
              <span className={styles.clusterBadge}>Cluster</span>
              <span className={styles.clusterCount}>
                {cluster.members.length}{" "}
                {cluster.members.length === 1 ? "sandbox" : "sandboxes"}
              </span>
            </div>
            <div className={styles.clusterWorkspace} title={cluster.workspaceRoot}>
              <span className={styles.clusterWorkspaceLabel}>Workspace</span>
              {cluster.workspaceRoot || "—"}
            </div>
          </div>
        </div>
        <div className={styles.clusterActions}>
          <span
            className={styles.clusterReady}
            data-complete={readyCount === cluster.members.length || undefined}
          >
            <span aria-hidden className={styles.clusterReadyDot} />
            {readyLabel}
          </span>
          <RemoveClusterAction
            className={styles.removeClusterAction}
            clusterId={cluster.id}
            memberCount={cluster.members.length}
          />
          <button
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${cluster.id}`}
            className={styles.clusterToggle}
            data-collapsed={collapsed || undefined}
            onClick={() => setCollapsed((current) => !current)}
            title={collapsed ? "Expand cluster" : "Collapse cluster"}
            type="button"
          >
            <ChevronDown aria-hidden size={20} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {!collapsed ? (
        <div className={styles.clusterBody}>
          <div className={styles.clusterGrid} data-fleet-card-collection>
            {members.map((record, index) => (
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
                  usage={usage.get(record.id)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function DashboardPage() {
  const shell = useDashboardShell();
  const [localCreateLogs, setLocalCreateLogs] = useState<string[] | null>(null);
  const createLogs = shell?.createLogs ?? localCreateLogs;
  const setCreateLogs = shell?.setCreateLogs ?? setLocalCreateLogs;
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("q") ?? "";
  const activeView: DashboardView =
    searchParams.get("view") === "cluster" ? "cluster" : "sandbox";
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
  const clusterList = usePoll({
    key: ["sandbox-clusters"],
    fn: listSandboxClusters,
    mode: "slow",
  });
  const clusterRegistry = clusterList.data ?? readSandboxClusters();

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
  const presentation = useMemo(
    () => resolveSandboxClusters(records, clusterRegistry),
    [clusterRegistry, records],
  );
  const visibleSandboxes = filterFleetRecords(records, filter, snapshot.data);
  const clusterIdsBySandbox = useMemo(
    () =>
      new Map(
        presentation.clusters.flatMap((cluster) =>
          cluster.members.map((member) => [member.id, cluster.id] as const),
        ),
      ),
    [presentation.clusters],
  );
  const visibleClusters = useMemo<ClusterSearchResult[]>(() => {
    const needle = filter.trim().toLowerCase();
    return presentation.clusters.flatMap((cluster) => {
      const clusterMatches = [cluster.id, cluster.workspaceRoot].some((value) =>
        value.toLowerCase().includes(needle),
      );
      const members =
        needle === "" || clusterMatches
          ? cluster.members
          : filterFleetRecords(cluster.members, filter, snapshot.data);
      return members.length > 0 ? [{ cluster, members }] : [];
    });
  }, [filter, presentation.clusters, snapshot.data]);
  const fleetError = lifecycleActive ? listFast.error ?? list.error : list.error;
  const isInitialLoading = list.isPending && !fleet;
  const isClusterRegistryLoading =
    activeView === "cluster" && clusterList.isPending;
  const connection = connectionFor(fleet, fleetError);
  const setShellConnection = shell?.setConnection;

  useEffect(() => {
    setShellConnection?.(connection);
  }, [connection, setShellConnection]);

  useEffect(() => {
    const synchronizeClusters = () => void clusterList.refetch();
    window.addEventListener("storage", synchronizeClusters);
    window.addEventListener(SANDBOX_CLUSTERS_CHANGED_EVENT, synchronizeClusters);
    return () => {
      window.removeEventListener("storage", synchronizeClusters);
      window.removeEventListener(SANDBOX_CLUSTERS_CHANGED_EVENT, synchronizeClusters);
    };
  }, [clusterList.refetch]);

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

  const updateView = (view: DashboardView) => {
    const next = new URLSearchParams(searchParams);
    if (view === "cluster") next.set("view", "cluster");
    else next.delete("view");
    setSearchParams(next, { replace: true });
  };

  const showCreationCard =
    activeView === "sandbox" &&
    createLogs !== null &&
    !records.some((record) => record.state === "creating");
  const isViewEmpty =
    activeView === "sandbox"
      ? visibleSandboxes.length === 0 && !showCreationCard
      : visibleClusters.length === 0;
  const emptyTitle =
    records.length === 0
      ? "No sandboxes yet"
      : filter
        ? "No matches"
        : activeView === "cluster"
          ? "No clusters"
          : "No sandboxes";
  const emptyCopy =
    records.length === 0
      ? "Create your first sandbox to begin an isolated workspace."
      : filter
        ? `No ${activeView === "cluster" ? "sandbox cluster" : "sandbox"} matches “${filter}”. Try another ID, state, or workspace.`
        : activeView === "cluster"
          ? "Use Create sandbox and choose Cluster to create one or more sandboxes as a cluster."
          : "Create a sandbox to begin an isolated workspace.";

  return (
    <Box
      className={styles.page}
      data-fleet-board
      data-route-scroll-owner="dashboard"
    >
      <div className={styles.pageInner}>
        <div className={styles.content}>
          <DashboardSummary
            list={fleet}
            loading={isInitialLoading}
            snapshot={snapshot.data}
            usage={currentUsage.data}
          />

          <section aria-labelledby="dashboard-title" className={styles.collectionSection}>
            <div className={styles.collectionHeading}>
              <div className={styles.titleRow} data-collection-title-row>
                <h1 className={styles.pageTitle} id="dashboard-title">
                  Your sandboxes
                </h1>
                <CreateSandboxModal onStream={setCreateLogs} />
              </div>
              <div className={styles.collectionToolbar} data-collection-toolbar>
                <div
                  aria-label="Sandbox collection view"
                  className={styles.viewSwitcher}
                  data-sandbox-view-switcher
                  role="group"
                >
                  <button
                    aria-pressed={activeView === "sandbox"}
                    className={styles.viewSwitchButton}
                    onClick={() => updateView("sandbox")}
                    type="button"
                  >
                    Sandbox
                    <span aria-hidden className={styles.viewCount}>
                      {records.length}
                    </span>
                  </button>
                  <button
                    aria-pressed={activeView === "cluster"}
                    className={styles.viewSwitchButton}
                    onClick={() => updateView("cluster")}
                    type="button"
                  >
                    Cluster
                    <span aria-hidden className={styles.viewCount}>
                      {presentation.clusters.length}
                    </span>
                  </button>
                </div>
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

            {isInitialLoading || isClusterRegistryLoading ? (
              <LoadingCards
                label={isClusterRegistryLoading ? "Loading sandbox clusters" : undefined}
              />
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
            ) : isViewEmpty && fleet ? (
              <Center className={styles.statePanel} data-fleet-empty>
                <Stack align="center" gap="md">
                  <div>
                    <p className={styles.stateTitle}>{emptyTitle}</p>
                    <p className={styles.stateCopy}>{emptyCopy}</p>
                  </div>
                </Stack>
              </Center>
            ) : activeView === "sandbox" ? (
              <div className={styles.sandboxList}>
                <div aria-hidden className={styles.listHeader}>
                  <span>Sandbox / state</span>
                  <span>Workspace</span>
                  <span>Runtime</span>
                  <span>Actions</span>
                </div>
                <div className={styles.cardGrid} data-fleet-card-collection>
                  {visibleSandboxes.map((record, index) => (
                    <div
                      className={styles.cardCell}
                      key={record.id}
                      style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}
                    >
                      <SandboxCard
                        clusterId={clusterIdsBySandbox.get(record.id)}
                        createLogs={
                          record.state === "creating" ? (createLogs ?? undefined) : undefined
                        }
                        record={record}
                        snapshot={snapshotMap.get(record.id)}
                        usage={currentUsage.data.get(record.id)}
                      />
                    </div>
                  ))}
                  {showCreationCard ? (
                    <article className={styles.creationCard} data-fleet-creation-card>
                      <div className={styles.metadataLabel}>Creating sandbox</div>
                      <p className={styles.creationLog}>
                        {createLogs.length === 0 ? "Starting…" : createLogs.join("\n")}
                      </p>
                    </article>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className={styles.clusterList} data-sandbox-cluster-collection>
                {visibleClusters.map(({ cluster, members }) => (
                  <SandboxClusterCollection
                    cluster={cluster}
                    createLogs={createLogs}
                    key={cluster.id}
                    members={members}
                    snapshotMap={snapshotMap}
                    usage={currentUsage.data}
                  />
                ))}
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
