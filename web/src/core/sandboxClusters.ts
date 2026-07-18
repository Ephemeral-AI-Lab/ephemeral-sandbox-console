import type { SandboxList, SandboxRecord } from "@/api/types";

const STORAGE_KEY = "ephemeral-sandbox-console:sandbox-clusters:v1";
export const SANDBOX_CLUSTERS_CHANGED_EVENT = "sandbox-clusters-changed";

export interface SandboxClusterRecord {
  id: string;
  memberIds: string[];
  workspaceRoot: string;
  createdAt: string;
}

export interface ResolvedSandboxCluster extends SandboxClusterRecord {
  members: SandboxRecord[];
}

export interface SandboxClusterRegistrationOptions {
  allowSingleMember?: boolean;
}

function isSandboxRecord(value: unknown): value is SandboxRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SandboxRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspace_root === "string" &&
    typeof candidate.state === "string"
  );
}

function recordsFromCreateResult(
  result: SandboxRecord | SandboxList,
): SandboxRecord[] {
  if ("sandboxes" in result && Array.isArray(result.sandboxes)) {
    return result.sandboxes.filter(isSandboxRecord);
  }
  return isSandboxRecord(result) ? [result] : [];
}

function clusterSuffix(sandboxId: string): string {
  const normalized = sandboxId.replace(/^eos-/, "");
  return normalized.split("-")[0] || normalized.slice(0, 8) || "batch";
}

export function clusterFromCreateResult(
  result: SandboxRecord | SandboxList,
  createdAt = new Date().toISOString(),
  options: SandboxClusterRegistrationOptions = {},
): SandboxClusterRecord | null {
  const records = recordsFromCreateResult(result);
  const minimumMembers = options.allowSingleMember ? 1 : 2;
  if (records.length < minimumMembers) return null;

  return {
    id: `cluster-${clusterSuffix(records[0].id)}`,
    memberIds: records.map((record) => record.id),
    workspaceRoot: records[0].workspace_root,
    createdAt,
  };
}

function isClusterRecord(value: unknown): value is SandboxClusterRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SandboxClusterRecord>;
  return (
    typeof candidate.id === "string" &&
    Array.isArray(candidate.memberIds) &&
    candidate.memberIds.length >= 1 &&
    candidate.memberIds.every((id) => typeof id === "string") &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.createdAt === "string"
  );
}

export function parseSandboxClusters(value: string | null): SandboxClusterRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isClusterRecord) : [];
  } catch {
    return [];
  }
}

export function readSandboxClusters(): SandboxClusterRecord[] {
  if (typeof window === "undefined") return [];
  try {
    return parseSandboxClusters(
      window.localStorage.getItem(STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

function mergeSandboxClusters(
  first: SandboxClusterRecord[],
  second: SandboxClusterRecord[],
): SandboxClusterRecord[] {
  return second.reduce((clusters, cluster) => {
    const memberIds = new Set(cluster.memberIds);
    return [
      ...clusters.filter(
        (candidate) =>
          candidate.id !== cluster.id &&
          !candidate.memberIds.some((memberId) => memberIds.has(memberId)),
      ),
      cluster,
    ];
  }, first);
}

async function persistSandboxCluster(
  cluster: SandboxClusterRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch("/api/sandbox-clusters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cluster),
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listSandboxClusters(
  signal?: AbortSignal,
): Promise<SandboxClusterRecord[]> {
  const local = readSandboxClusters();
  try {
    const response = await fetch("/api/sandbox-clusters", { signal });
    if (!response.ok) return local;
    const body = (await response.json()) as { clusters?: unknown };
    const remote = parseSandboxClusters(JSON.stringify(body.clusters ?? []));
    const merged = mergeSandboxClusters(remote, local);

    // One-time migration for clusters created by the earlier origin-local
    // implementation. The server registry then makes them visible from both
    // localhost and 127.0.0.1 without touching the sandboxes themselves.
    if (local.length > 0) {
      await Promise.all(local.map((cluster) => persistSandboxCluster(cluster, signal)));
    }
    return merged;
  } catch {
    return local;
  }
}

export async function registerSandboxCluster(
  result: SandboxRecord | SandboxList,
  options: SandboxClusterRegistrationOptions = {},
): Promise<SandboxClusterRecord | null> {
  const cluster = clusterFromCreateResult(result, new Date().toISOString(), options);
  if (!cluster) return null;

  if (typeof window !== "undefined") {
    const existing = mergeSandboxClusters(readSandboxClusters(), [cluster]);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
      window.dispatchEvent(new Event(SANDBOX_CLUSTERS_CHANGED_EVENT));
    } catch {
      // The shared server registry remains available when browser storage is
      // unavailable or full.
    }
  }
  await persistSandboxCluster(cluster);
  return cluster;
}

export async function removeSandboxCluster(
  clusterId: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/sandbox-clusters", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: clusterId }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Could not remove sandbox cluster (HTTP ${response.status})`);
  }

  if (typeof window === "undefined") return;
  const remaining = readSandboxClusters().filter((cluster) => cluster.id !== clusterId);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
    window.dispatchEvent(new Event(SANDBOX_CLUSTERS_CHANGED_EVENT));
  } catch {
    // The server registry is authoritative when browser storage is unavailable.
  }
}

export function resolveSandboxClusters(
  records: SandboxRecord[],
  registry: SandboxClusterRecord[],
): { clusters: ResolvedSandboxCluster[]; individuals: SandboxRecord[] } {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const clusteredIds = new Set<string>();
  const clusters: ResolvedSandboxCluster[] = [];

  for (const cluster of registry) {
    const members = [...new Set(cluster.memberIds)]
      .map((id) => recordsById.get(id))
      .filter(
        (record): record is SandboxRecord =>
          record !== undefined && !clusteredIds.has(record.id),
      );
    if (members.length === 0) continue;
    members.forEach((member) => clusteredIds.add(member.id));
    clusters.push({ ...cluster, members });
  }

  return {
    clusters,
    individuals: records.filter((record) => !clusteredIds.has(record.id)),
  };
}
