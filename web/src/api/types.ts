export type SandboxState =
  | "creating"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface Endpoint {
  host: string;
  port: number;
}

export interface SharedBase {
  source: string;
  target: string;
  root_hash: string;
  readonly: boolean;
}

export interface SandboxRecord {
  id: string;
  workspace_root: string;
  state: SandboxState;
  daemon: Endpoint | null;
  daemon_http: Endpoint | null;
  shared_base: SharedBase | null;
  /** Absent only while connected to a pre-revision manager. */
  activity_revision?: number;
}

export interface SandboxList {
  sandboxes: SandboxRecord[];
}

export type CommandStatus =
  | "running"
  | "ok"
  | "error"
  | "timed_out"
  | "cancelled";

export interface CommandOutput {
  status: CommandStatus;
  exit_code: number | null;
  wall_time_seconds: number;
  command_total_time_seconds: number;
  start_offset: number;
  end_offset: number;
  total_lines: number;
  original_token_count: number;
  output: string;
  command_session_id?: string;
  workspace_session_id?: string;
  publish_rejected?: boolean;
  publish_reject_class?: string;
}

export interface WorkspaceSessionCreated {
  workspace_session_id: string;
  network_profile: "shared" | "isolated";
  finalize_policy: "no_op";
}

export interface WorkspaceSessionDestroyed {
  workspace_session_id: string;
  destroyed: true;
  evicted_upperdir_bytes: number;
}

export interface WorkspaceSessionRevision {
  manifest_version: number;
  root_hash: string;
  layer_count: number;
}

export interface WorkspaceSessionPublishSummary {
  no_op: boolean;
  revision: WorkspaceSessionRevision;
  route_summary: {
    source_count: number;
    ignored_count: number;
  };
}

export interface WorkspaceSessionPublished {
  workspace_session_id: string;
  publish: WorkspaceSessionPublishSummary;
  destroyed: true;
  evicted_upperdir_bytes: number;
}

export type WorkspaceSessionPublishRejectionReason =
  | "invalid_base_revision"
  | "protected_path"
  | "source_conflict"
  | "opaque_dir_protected_descendant"
  | "opaque_dir_mixed_routes"
  | "opaque_dir_expansion_limit"
  | "route_preparation_failed";

export type WorkspaceSessionProtectedDropReason =
  | "unsupported_special_file"
  | "invalid_layer_path"
  | "command_scratch_path";

export interface WorkspaceSessionPublishRejection {
  path: string | null;
  reason: WorkspaceSessionPublishRejectionReason;
  source_conflict: {
    path: string;
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
  } | null;
  protected_drop: {
    path?: string;
    reason: WorkspaceSessionProtectedDropReason;
    [key: string]: unknown;
  } | null;
  message: string | null;
}

export interface WorkspaceSessionPublishRetainedDetails {
  workspace_session_id: string;
  stage: "capture" | "publish";
  session_retained: true;
  publish_rejection?: WorkspaceSessionPublishRejection;
  active_command_session_ids?: string[];
}

export interface WorkspaceSessionPublishCleanupDetails {
  workspace_session_id: string;
  stage: "destroy";
  publish_completed: true;
  layer_committed: boolean;
  publish: WorkspaceSessionPublishSummary;
  destroyed: false;
  session_state: "finalize_failed";
  recovery_operation: "destroy_workspace_session";
}
