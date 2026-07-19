import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDaemonSelf,
  fetchFleetResources,
  fetchSandboxResources,
  fetchTopology,
} from "@/api/observability";

describe("observability resource request routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps manager resources, daemon self-metrics, and topology on explicit operations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await fetchSandboxResources("sandbox-a", 60_000, signal);
    await fetchFleetResources(signal);
    await fetchDaemonSelf("sandbox-a", signal);
    await fetchTopology("sandbox-a", signal);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestBody(fetchMock, 0)).toEqual({
      op: "resources",
      scope: { kind: "sandbox", sandbox_id: "sandbox-a" },
      args: { window_ms: 60_000 },
    });
    expect(requestBody(fetchMock, 1)).toEqual({
      op: "resources",
      scope: { kind: "system" },
      args: {},
    });
    expect(requestBody(fetchMock, 2)).toEqual({
      op: "daemon",
      scope: { kind: "sandbox", sandbox_id: "sandbox-a" },
      args: {},
    });
    expect(requestBody(fetchMock, 3)).toEqual({
      op: "topology",
      scope: { kind: "sandbox", sandbox_id: "sandbox-a" },
      args: {},
    });
    expect(fetchMock.mock.calls.map((call) => requestBodyValue(call[1]).op))
      .toEqual(["resources", "resources", "daemon", "topology"]);
  });
});

function requestBody(mock: ReturnType<typeof vi.fn>, index: number) {
  return requestBodyValue(mock.mock.calls[index]?.[1]);
}

function requestBodyValue(init: unknown): Record<string, unknown> {
  const body = (init as RequestInit | undefined)?.body;
  if (typeof body !== "string") throw new Error("RPC request did not contain a JSON body");
  return JSON.parse(body) as Record<string, unknown>;
}
