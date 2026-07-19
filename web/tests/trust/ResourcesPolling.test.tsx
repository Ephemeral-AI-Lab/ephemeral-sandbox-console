import { act, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxResourcesResult } from "@/api/observability";
import { ResourcesView } from "@/pages/sandbox/observability/ResourcesView";

const mocks = vi.hoisted(() => ({
  fetchSandboxResources: vi.fn(),
  fetchCgroup: vi.fn(),
  fetchSandboxSnapshot: vi.fn(),
}));

vi.mock("@/api/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/observability")>()),
  fetchSandboxResources: mocks.fetchSandboxResources,
  fetchCgroup: mocks.fetchCgroup,
  fetchSandboxSnapshot: mocks.fetchSandboxSnapshot,
}));

vi.mock("@/pages/sandbox/SandboxContext", () => ({
  useSandbox: () => ({
    sandboxId: "sandbox-a",
    record: null,
    snapshot: { sandboxes: [{ workspaces: [] }] },
    recordError: null,
  }),
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={["/resources"]}>
        <MantineProvider>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </MantineProvider>
      </MemoryRouter>
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function response(ts: number, marker: string): SandboxResourcesResult {
  return {
    view: "resources",
    scope: "sandbox",
    sandbox_id: "sandbox-a",
    source: "daemon_disk",
    availability: "available",
    errors: [],
    series: [{
      ts,
      sample_delta_ms: null,
      metrics: { fixture_marker: marker },
      deltas: {},
    }],
  };
}

async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: hidden ? "hidden" : "visible",
  });
  window.dispatchEvent(new Event("visibilitychange"));
}

describe("daemon resource polling lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchSandboxResources.mockReset();
    mocks.fetchCgroup.mockReset();
    mocks.fetchSandboxSnapshot.mockReset();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it("allows one in-flight daemon request and aborts it on unmount", async () => {
    const pending = deferred<SandboxResourcesResult>();
    let signal: AbortSignal | undefined;
    mocks.fetchSandboxResources.mockImplementation(
      async (_sandboxId: string, _windowMs: number, requestSignal?: AbortSignal) => {
        signal = requestSignal;
        return await pending.promise;
      },
    );
    const view = render(<ResourcesView />, { wrapper: createWrapper() });
    await flush();

    expect(mocks.fetchSandboxResources).toHaveBeenCalledWith(
      "sandbox-a",
      60_000,
      expect.any(AbortSignal),
    );
    await flush(20_000);
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("replaces the prior response and recovers after a transient error", async () => {
    const first = deferred<SandboxResourcesResult>();
    const failed = deferred<SandboxResourcesResult>();
    const recovered = deferred<SandboxResourcesResult>();
    mocks.fetchSandboxResources
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => await failed.promise)
      .mockImplementationOnce(async () => await recovered.promise);
    render(<ResourcesView />, { wrapper: createWrapper() });
    await flush();
    const initial = response(1, "first");
    initial.series.push({
      ts: 2,
      sample_delta_ms: 1,
      metrics: { fixture_marker: "second" },
      deltas: {},
    });
    first.resolve(initial);
    await flush();
    expect(screen.getByText(/2 samples.*daemon disk/)).toBeTruthy();

    await flush(2_000);
    failed.reject(new Error("temporary daemon read failure"));
    await flush();
    await flush(2_000);
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(3);
    recovered.resolve(response(3, "recovered"));
    await flush();

    expect(screen.getByText(/1 samples.*daemon disk/)).toBeTruthy();
  });

  it("does not poll while hidden and catches up when visible", async () => {
    mocks.fetchSandboxResources.mockResolvedValue(response(1, "visible"));
    render(<ResourcesView />, { wrapper: createWrapper() });
    await flush();
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(1);

    setHidden(true);
    await flush(20_000);
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(1);

    setHidden(false);
    await flush();
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(2);
  });
});
