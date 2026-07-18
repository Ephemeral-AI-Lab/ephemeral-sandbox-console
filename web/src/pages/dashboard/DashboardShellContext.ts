import { createContext, useContext, type Dispatch, type SetStateAction } from "react";

export type DashboardConnectionState =
  | "connecting"
  | "connected"
  | "stale"
  | "disconnected";

export interface DashboardShellState {
  connection: DashboardConnectionState;
  createLogs: string[] | null;
  setConnection: Dispatch<SetStateAction<DashboardConnectionState>>;
  setCreateLogs: Dispatch<SetStateAction<string[] | null>>;
}

export const DashboardShellContext = createContext<DashboardShellState | null>(null);

export function useDashboardShell(): DashboardShellState | null {
  return useContext(DashboardShellContext);
}
