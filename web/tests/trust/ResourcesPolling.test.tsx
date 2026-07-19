import { act, render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourcesView } from "@/pages/sandbox/observability/ResourcesView";

const mocks = vi.hoisted(() => ({
  fetchCgroup: vi.fn(),
  fetchSandboxResources: vi.fn(),
  fetchSandboxSnapshot: vi.fn(),
}));

vi.mock("@/api/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/observability")>()),
  fetchCgroup: mocks.fetchCgroup,
  fetchSandboxResources: mocks.fetchSandboxResources,
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
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
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

async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("resource route polling", () => {
  let requestSignal: AbortSignal | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    requestSignal = undefined;
    mocks.fetchCgroup.mockReset();
    mocks.fetchSandboxResources.mockReset();
    mocks.fetchSandboxSnapshot.mockReset();
    mocks.fetchSandboxResources.mockImplementation(
      async (
        _sandboxId: string,
        _windowMs: number,
        signal?: AbortSignal,
      ) => {
        requestSignal = signal;
        return await new Promise(() => {});
      },
    );
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("uses only the manager resource route and cancels it when leaving", async () => {
    const view = render(<ResourcesView />, { wrapper: createWrapper() });
    await flush();

    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSandboxResources).toHaveBeenCalledWith(
      "sandbox-a",
      60_000,
      expect.any(AbortSignal),
    );
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();
    expect(mocks.fetchSandboxSnapshot).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);

    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
    await flush(20_000);
    expect(mocks.fetchSandboxResources).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCgroup).not.toHaveBeenCalled();
    expect(mocks.fetchSandboxSnapshot).not.toHaveBeenCalled();
  });
});
