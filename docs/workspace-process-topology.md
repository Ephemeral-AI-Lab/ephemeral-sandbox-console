# Workspace process topology

The console presents sandbox workspace and process placement at the stable
route `/sandboxes/:sandboxId/observability/cgroup`. The backend operation remains
`cgroup` for compatibility, while the visible tab and breadcrumb are labeled
**Processes**. Backend collection, manager routing, and procfs security remain
owned by the Ephemeral Sandbox core; this document owns the console's response
and presentation behavior.

## Response and presentation

The console consumes the schema-version-2 `topology` object returned by the
`cgroup` operation. An available topology reports `source: "proc_namespaces"`
and contains zero or more workspaces. Each workspace exposes:

- its workspace ID and `active`, `idle`, or `partial` state;
- holder PID, PID namespace, and mount namespace;
- its namespace-init process and any workload processes; and
- process name, host PID, namespace PID, state, kind, and optional cgroup
  membership and resource counters.

Cgroup membership is diagnostic monospace text. It is never rendered as a
delegated hierarchy, and read-only or root memberships such as `0::/` do not by
themselves mean that process topology is unavailable.

The view preserves useful data during normal collection and refresh states:

- an available empty topology says that no active workspaces exist;
- an idle workspace remains visible with its namespace init and says that no
  workload processes are running;
- a partial workspace keeps readable process and namespace data and displays a
  non-blocking warning;
- truncation and collection warnings are visible without hiding the returned
  workspaces;
- a top-level unavailable response displays the reported cause and continues
  automatic refresh; and
- a failed refresh keeps the previous successful topology visible while showing
  the retrying error.

## Resource estimates

Workspace RSS and CPU values are explicitly labeled as estimates derived from
the processes visible in successful topology samples:

- RSS is the sum of available `resident_memory_bytes` values in the current
  sample. It can count shared pages more than once.
- CPU is the sum of non-negative `cpu_time_us` deltas divided by elapsed wall
  time. The first successful sample waits for a second sample before showing a
  CPU percentage.
- CPU samples match by workspace ID and `(pid, start_time_ticks)`, so PID reuse
  does not inherit an earlier process's counter. Missing counters and counter
  regressions are ignored.
- Estimates reset when the selected sandbox changes. They can miss processes
  that start and exit between refreshes and are not lifetime accounting.

Authoritative sandbox resource charts remain on **Resources**.

## Responsive and accessible behavior

The Processes navigation remains a semantic tab. Workspace state is conveyed by
text as well as color, process tables have accessible column names, and loading,
empty, warning, and unavailable messages use status or alert semantics.

Desktop layouts use a compact table inside each workspace card. Narrow layouts
stack process fields into cards without document-level horizontal overflow.
Long workspace IDs and cgroup membership lines wrap or scroll inside their
value cells.

Stable behavior hooks are:

- page root: `data-process-topology`;
- empty state: `data-process-topology-empty`;
- workspace: `data-workspace-id="<id>"`;
- process: `data-process-pid="<pid>"`;
- idle state: `data-workspace-idle`;
- RSS estimate: `data-workspace-rss-estimate`;
- CPU estimate: `data-workspace-cpu-estimate`; and
- estimate limitations: `data-resource-estimate-note`.

## Owned implementation and tests

- [`CgroupView.tsx`](../web/src/pages/sandbox/observability/CgroupView.tsx)
  renders topology, states, estimates, and responsive process views.
- [`processEstimates.ts`](../web/src/pages/sandbox/observability/processEstimates.ts)
  derives PID-reuse-safe RSS and CPU estimates.
- [`P04ShellNavigation.spec.ts`](../web/tests/browser/P04ShellNavigation.spec.ts)
  protects the stable URL and visible Processes label.
- [`P07ObservabilityFixture.spec.ts`](../web/tests/browser/P07ObservabilityFixture.spec.ts)
  covers active, idle, partial, empty, unavailable, stale-refresh, membership,
  resource-estimate, and narrow-layout behavior.
- [`ProcessEstimates.test.ts`](../web/tests/trust/ProcessEstimates.test.ts)
  covers first-sample behavior, CPU deltas, PID reuse, and partial counters.
