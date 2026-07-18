import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonProcessMetrics } from "@/api/observability";
import {
  appendDaemonCapture,
  clearDaemonCapture,
  readDaemonCapture,
} from "@/core/daemonCaptureStore";
import {
  appendDaemonMetric,
  DAEMON_HISTORY_LIMIT,
  type DaemonMetricPoint,
} from "@/core/daemonMetrics";

export const DAEMON_VISIBLE_HISTORY_LIMIT = 300;

interface DaemonCapture {
  history: DaemonMetricPoint[];
  storedCount: number;
  ready: boolean;
  error: Error | null;
  recordSample: (sample: DaemonProcessMetrics) => void;
  clearCapture: () => Promise<void>;
  readFullCapture: () => Promise<DaemonMetricPoint[]>;
}

export function useDaemonCapture(sandboxId: string): DaemonCapture {
  const [history, setHistory] = useState<DaemonMetricPoint[]>([]);
  const [storedCount, setStoredCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const historyRef = useRef<DaemonMetricPoint[]>([]);
  const storedCountRef = useRef(0);
  const generationRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const reportFailure = useCallback((generation: number, failure: unknown) => {
    if (generation !== generationRef.current) return;
    setReady(false);
    setError(failure instanceof Error ? failure : new Error(String(failure)));
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    historyRef.current = [];
    storedCountRef.current = 0;
    setHistory([]);
    setStoredCount(0);
    setReady(false);
    setError(null);

    const load = readDaemonCapture(sandboxId, DAEMON_HISTORY_LIMIT)
      .then((stored) => {
        if (generation !== generationRef.current) return;
        const visible = stored.slice(-DAEMON_VISIBLE_HISTORY_LIMIT);
        historyRef.current = visible;
        storedCountRef.current = stored.length;
        setHistory(visible);
        setStoredCount(stored.length);
        setReady(true);
      })
      .catch((failure: unknown) => reportFailure(generation, failure));
    queueRef.current = load;

    return () => {
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [reportFailure, sandboxId]);

  const recordSample = useCallback((sample: DaemonProcessMetrics) => {
    if (!ready || !sample.available) return;
    const generation = generationRef.current;
    const write = queueRef.current.then(async () => {
      if (generation !== generationRef.current) return;
      const before = historyRef.current;
      const next = appendDaemonMetric(before, sample, DAEMON_VISIBLE_HISTORY_LIMIT);
      if (next === before) return;
      const restarted = before.length > 0 && next.length === 1;
      if (restarted) await clearDaemonCapture(sandboxId);
      await appendDaemonCapture(sandboxId, next.at(-1)!, DAEMON_HISTORY_LIMIT);
      if (generation !== generationRef.current) return;
      const count = restarted ? 1 : Math.min(storedCountRef.current + 1, DAEMON_HISTORY_LIMIT);
      historyRef.current = next;
      storedCountRef.current = count;
      setHistory(next);
      setStoredCount(count);
    });
    queueRef.current = write.catch((failure: unknown) => reportFailure(generation, failure));
  }, [ready, reportFailure, sandboxId]);

  const clearCapture = useCallback(async () => {
    const generation = generationRef.current;
    const clear = queueRef.current.then(async () => {
      await clearDaemonCapture(sandboxId);
      if (generation !== generationRef.current) return;
      historyRef.current = [];
      storedCountRef.current = 0;
      setHistory([]);
      setStoredCount(0);
    });
    queueRef.current = clear.catch((failure: unknown) => reportFailure(generation, failure));
    await clear;
  }, [reportFailure, sandboxId]);

  const readFullCapture = useCallback(async () => {
    const generation = generationRef.current;
    try {
      await queueRef.current;
      return await readDaemonCapture(sandboxId, DAEMON_HISTORY_LIMIT);
    } catch (failure) {
      reportFailure(generation, failure);
      throw failure;
    }
  }, [reportFailure, sandboxId]);

  return { history, storedCount, ready, error, recordSample, clearCapture, readFullCapture };
}
