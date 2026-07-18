import type { DaemonMetricPoint } from "@/core/daemonMetrics";

const DATABASE_NAME = "ephemeral-sandbox-console";
const DATABASE_VERSION = 1;
const STORE_NAME = "daemon-metric-captures";
const SANDBOX_TIME_INDEX = "sandbox-time";

interface StoredDaemonMetric {
  sandbox_id: string;
  sampled_at_unix_ms: number;
  point: DaemonMetricPoint;
}

export async function readDaemonCapture(
  sandboxId: string,
  limit: number,
): Promise<DaemonMetricPoint[]> {
  if (limit < 1) return [];
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = transactionComplete(transaction);
    const index = transaction.objectStore(STORE_NAME).index(SANDBOX_TIME_INDEX);
    const points = await cursorPoints(index, sandboxRange(sandboxId), limit);
    await completed;
    return points.reverse();
  } finally {
    database.close();
  }
}

export async function appendDaemonCapture(
  sandboxId: string,
  point: DaemonMetricPoint,
  limit: number,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(STORE_NAME);
    store.put({
      sandbox_id: sandboxId,
      sampled_at_unix_ms: point.sampled_at_unix_ms,
      point,
    } satisfies StoredDaemonMetric);
    const index = store.index(SANDBOX_TIME_INDEX);
    const count = await requestResult(index.count(sandboxRange(sandboxId)));
    const excess = Math.max(count - limit, 0);
    if (excess > 0) await deleteOldest(index, sandboxRange(sandboxId), excess);
    await completed;
  } finally {
    database.close();
  }
}

export async function clearDaemonCapture(sandboxId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    const index = transaction.objectStore(STORE_NAME).index(SANDBOX_TIME_INDEX);
    await deleteOldest(index, sandboxRange(sandboxId), Number.POSITIVE_INFINITY);
    await completed;
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("disk-backed browser storage is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME, {
        keyPath: ["sandbox_id", "sampled_at_unix_ms"],
      });
      store.createIndex(SANDBOX_TIME_INDEX, ["sandbox_id", "sampled_at_unix_ms"], { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("daemon capture database failed to open"));
  });
}

function sandboxRange(sandboxId: string) {
  return IDBKeyRange.bound(
    [sandboxId, 0],
    [sandboxId, Number.MAX_SAFE_INTEGER],
  );
}

function cursorPoints(
  index: IDBIndex,
  range: IDBKeyRange,
  limit: number,
): Promise<DaemonMetricPoint[]> {
  return new Promise((resolve, reject) => {
    const points: DaemonMetricPoint[] = [];
    const request = index.openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || points.length === limit) {
        resolve(points);
        return;
      }
      points.push((cursor.value as StoredDaemonMetric).point);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("daemon capture cursor failed"));
  });
}

function deleteOldest(
  index: IDBIndex,
  range: IDBKeyRange,
  limit: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const request = index.openCursor(range, "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || deleted === limit) {
        resolve();
        return;
      }
      cursor.delete();
      deleted += 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("daemon capture deletion failed"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("daemon capture request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("daemon capture transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("daemon capture transaction aborted"));
  });
}
