import { rpc, sandboxScope, systemScope } from "@/api/rpc";

export interface ResourceSample {
  ts: number;
  sample_delta_ms: number | null;
  metrics: Record<string, number | boolean | string>;
  deltas: Record<string, number>;
}

export interface ResourceSeries {
  latest: ResourceSample | null;
  history: ResourceSample[];
}

export interface ActiveExecution {
  namespace_execution_id: string;
  operation: string;
  lifecycle_state: string;
  command?: string | null;
}

export type WorkspaceFinalizationState =
  | "active"
  | "finalizing"
  | "finalize_failed";

export interface WorkspaceSnapshot {
  workspace_id: string;
  lifecycle_state: string;
  finalization_state: WorkspaceFinalizationState;
  network_profile: "shared" | "isolated";
  layers: { base_root_hash: string; layer_count: number };
  namespace_fd_count: number;
  resources: ResourceSeries;
  active_namespace_executions: ActiveExecution[];
}

export interface SandboxSnapshot {
  sandbox_id: string;
  lifecycle_state: string;
  availability: string;
  sampled_at_unix_ms: number;
  errors: string[];
  daemon: { daemon_pid: number; runtime_dir: string } | null;
  resources: ResourceSeries;
  workspaces: WorkspaceSnapshot[];
  stack: { layer_count: number; layers_bytes: number; active_leases: number };
}

export interface SnapshotResult {
  sandboxes: SandboxSnapshot[];
}

export function fetchFleetSnapshot(): Promise<SnapshotResult> {
  return rpc<SnapshotResult>("snapshot", systemScope);
}

export function fetchSandboxSnapshot(
  sandboxId: string,
  signal?: AbortSignal,
): Promise<SnapshotResult> {
  return fetchObservabilityView<SandboxSnapshot>(sandboxId, "snapshot", {}, signal).then(
    (snapshot) => ({
      sandboxes: [snapshot],
    }),
  );
}

export function fetchObservabilityView<T = unknown>(
  sandboxId: string,
  operation: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  return rpc<T>(operation, sandboxScope(sandboxId), args, signal);
}

export function inFlightCount(snapshot: SandboxSnapshot): number {
  return snapshot.workspaces.reduce(
    (total, workspace) => total + workspace.active_namespace_executions.length,
    0,
  );
}

export interface CgroupSeries {
  view: "cgroup";
  scope: string;
  series: ResourceSample[];
  topology: WorkspaceProcessTopology;
}

export interface SandboxResourcesResult {
  view: "resources";
  scope: "sandbox";
  sandbox_id: string;
  source: "daemon_disk";
  availability: "available" | "partial";
  errors: string[];
  series: ResourceSample[];
}

export interface FleetResourceCurrent {
  availability: "available" | "partial";
  errors: string[];
  current: ResourceSample | null;
}

export interface FleetResourcesResult {
  view: "resources";
  scope: "fleet";
  availability: "available" | "partial";
  errors: string[];
  sandboxes: Record<string, FleetResourceCurrent>;
}

export interface WorkspaceProcessTopology {
  schema_version: 2;
  available: boolean;
  source: "proc_namespaces" | null;
  error: string | null;
  truncated: boolean;
  warnings: string[];
  workspaces: WorkspaceProcesses[];
  daemon?: DaemonProcessMetrics | null;
}

export interface TopologyResult {
  view: "topology";
  scope: "sandbox";
  topology: WorkspaceProcessTopology;
}

export interface DaemonResult {
  view: "daemon";
  scope: "sandbox";
  daemon: DaemonProcessMetrics;
}

export interface DaemonProcessMetrics {
  available: boolean;
  error: string | null;
  sampled_at_unix_ms: number;
  pid: number;
  name: string | null;
  state: string | null;
  virtual_memory_bytes: number | null;
  resident_memory_bytes: number | null;
  peak_resident_memory_bytes: number | null;
  proportional_set_size_bytes: number | null;
  unique_set_size_bytes: number | null;
  private_dirty_bytes?: number | null;
  anonymous_huge_pages_bytes?: number | null;
  anonymous_memory_bytes: number | null;
  file_memory_bytes: number | null;
  shared_memory_bytes: number | null;
  data_memory_bytes: number | null;
  swap_bytes: number | null;
  cpu_time_us: number | null;
  start_time_ticks: number | null;
  thread_count: number | null;
  file_descriptor_count: number | null;
  io_read_bytes: number | null;
  io_write_bytes: number | null;
  read_syscalls: number | null;
  write_syscalls: number | null;
  voluntary_context_switches: number | null;
  involuntary_context_switches: number | null;
  cgroup_memberships: string[];
  cgroup_path?: string | null;
  warnings: string[];
  runtime_usage?: {
    active_commands: number | null;
  };
  ownership?: {
    open_workspaces: number;
  };
}

export interface WorkspaceProcesses {
  workspace_id: string;
  state: "active" | "idle" | "partial";
  holder_pid: number;
  pid_namespace: string | null;
  mount_namespace: string | null;
  processes: WorkspaceProcess[];
}

export interface WorkspaceProcess {
  pid: number;
  namespace_pid: number;
  parent_pid: number;
  name: string;
  state: string;
  kind: "namespace_init" | "process";
  cgroup_memberships: string[];
  resident_memory_bytes?: number | null;
  cpu_time_us?: number | null;
  start_time_ticks?: number | null;
}

export function fetchCgroup(
  sandboxId: string,
  scope: string,
  windowMs: number,
  signal?: AbortSignal,
): Promise<CgroupSeries> {
  return fetchObservabilityView<CgroupSeries>(sandboxId, "cgroup", {
    scope,
    window_ms: windowMs,
  }, signal);
}

export function fetchSandboxResources(
  sandboxId: string,
  windowMs: number,
  signal?: AbortSignal,
): Promise<SandboxResourcesResult> {
  return fetchObservabilityView<SandboxResourcesResult>(sandboxId, "resources", {
    window_ms: windowMs,
  }, signal);
}

export function fetchFleetResources(
  signal?: AbortSignal,
): Promise<FleetResourcesResult> {
  return rpc<FleetResourcesResult>("resources", systemScope, {}, signal);
}

export function fetchTopology(
  sandboxId: string,
  signal?: AbortSignal,
): Promise<TopologyResult> {
  return fetchObservabilityView<TopologyResult>(sandboxId, "topology", {}, signal);
}

export function fetchDaemonSelf(
  sandboxId: string,
  signal?: AbortSignal,
): Promise<DaemonResult> {
  return fetchObservabilityView<DaemonResult>(sandboxId, "daemon", {}, signal);
}

export interface TraceEvent {
  ts: number;
  trace: string;
  parent: string | null;
  name: string;
  attrs: Record<string, unknown>;
}

export interface TraceSpan {
  ts: number;
  trace: string;
  span: string;
  name: string;
  dur_ms: number | null;
  status: string;
  attrs: Record<string, unknown>;
}

/** An event attached to a span, positioned from the trace start by the API. */
export interface TraceEventNode {
  offset_ms: number;
  event: TraceEvent;
}

export interface TraceNode {
  span: TraceSpan;
  offset_ms: number;
  children: TraceNode[];
  events: TraceEventNode[];
}

export interface TraceResult {
  view: "trace";
  trace: string;
  spans: TraceNode[];
}

export function fetchTrace(sandboxId: string, traceId: string): Promise<TraceResult> {
  return fetchObservabilityView<TraceResult>(sandboxId, "trace", {
    trace_id: traceId,
  });
}

export interface EventsResult {
  view: "events";
  events: TraceEvent[];
}

export function fetchEvents(
  sandboxId: string,
  filters: { name?: string; sinceMs?: number; lastN?: number },
): Promise<EventsResult> {
  const args: Record<string, unknown> = {};
  if (filters.name) args["name"] = filters.name;
  if (filters.sinceMs !== undefined) args["since_ms"] = filters.sinceMs;
  if (filters.lastN !== undefined) args["last_n"] = filters.lastN;
  return fetchObservabilityView<EventsResult>(sandboxId, "events", args);
}

export interface StackLayer {
  layer_id: string;
  bytes: number;
  leased_by_workspaces: number;
  booked_by: string[];
}

export interface LayerStackResult {
  view: "layerstack";
  manifest_version: number;
  root_hash: string;
  active_lease_count: number;
  total_bytes: number;
  layers: StackLayer[];
}

export function fetchLayerStack(sandboxId: string): Promise<LayerStackResult> {
  return fetchObservabilityView<LayerStackResult>(sandboxId, "layerstack");
}

export interface LayerStackWorkspaceMount {
  layer_id: string;
  shared_with: string[];
}

export interface LayerStackWorkspaceResult {
  view: "layerstack";
  workspace: string;
  mounts: LayerStackWorkspaceMount[];
  upper_bytes: number | null;
}

export function fetchLayerStackWorkspace(
  sandboxId: string,
  workspaceId: string,
): Promise<LayerStackWorkspaceResult> {
  return fetchObservabilityView<LayerStackWorkspaceResult>(sandboxId, "layerstack", {
    workspace_id: workspaceId,
  });
}

export type LayerStackLayerEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "delete"
  | "opaque_dir";

export interface LayerStackLayerEntry {
  path: string;
  kind: LayerStackLayerEntryKind;
}

export interface LayerStackLayerResult {
  view: "layerstack";
  layer_id: string;
  entries: LayerStackLayerEntry[];
  truncated: boolean;
}

export function fetchLayerStackLayer(
  sandboxId: string,
  layerId: string,
): Promise<LayerStackLayerResult> {
  return fetchObservabilityView<LayerStackLayerResult>(sandboxId, "layerstack", {
    layer_id: layerId,
  });
}
