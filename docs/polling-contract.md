# Console polling contract

The console owns browser request scheduling. Core owns resource sampling,
activity revisions, daemon snapshots, and the backend routes themselves. This
document defines the client behavior that prevents a monitoring page from
waking idle sandbox daemons.

## Activity and snapshot gating

- Timestamp-only and resource-counter changes are not activity and do not
  change the snapshot fingerprint.
- Fleet and detail views request a daemon snapshot once for initial state, once
  for each new manager `activity_revision`, and while the last snapshot reports
  an active execution or lease.
- Once a snapshot resolves to idle, continuous daemon snapshot polling stops.
  Manager-owned status polling may continue at its idle cadence.
- A failed initial snapshot attempt is recorded for its revision so an idle
  failure cannot become an unbounded retry loop. A later revision may retry.
- Daemons without activity-revision support are not continuously polled;
  explicit refresh remains available.

## Browser and route lifecycle

- A hidden tab stops interval polling. Returning focus may refresh manager
  state, but it does not unconditionally request a daemon snapshot.
- The Resources surface reads only the manager-owned cgroup/resource route; it
  never uses a daemon snapshot as a resource sampler.
- Leaving a polling surface aborts or disables its outstanding sampling
  requests through the query lifecycle.

## Verification ownership

The scheduling implementation lives in:

- `web/src/poll/usePoll.ts`
- `web/src/poll/useFleetSnapshots.ts`
- `web/src/poll/useSandboxSnapshot.ts`
- `web/src/poll/useFleetCurrentUsage.ts`

Fake-timer and request-counter coverage lives in:

- `web/tests/trust/usePoll.test.ts`
- `web/tests/trust/FleetSnapshotPolling.test.tsx`
- `web/tests/trust/SandboxSnapshotPolling.test.tsx`
- `web/tests/trust/FleetCurrentUsage.test.tsx`

Backend purity, resource-ring behavior, activity-revision semantics, and live
memory/disk conformance remain owned by the core and external E2E repositories.
