import { postJson } from "@/api/http";

export interface GatewayStartResult {
  status: "started" | "already_running";
  message: string;
}

export function startGateway(): Promise<GatewayStartResult> {
  return postJson<GatewayStartResult>("/api/gateway/start");
}
