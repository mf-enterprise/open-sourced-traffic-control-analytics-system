import type { Calibration } from "../vision";
import type { SpeedMeasurement } from "../vision/types";
export type CapturePayload = {
  clientEventId: string;
  trackId: number;
  sourceName: string;
  sourceKind: "demo" | "video" | "camera";
  className: string;
  speedKmh: number;
  speedMeasurement?: SpeedMeasurement | null;
  speedLimit: number;
  confidence: number;
  captureTime: string;
  sourceTimestamp: number;
  calibration: Calibration | null;
  evidence: string;
  vehicleBox?: readonly [number, number, number, number] | null;
};
export type StoredCase = Omit<CapturePayload, "evidence"> & {
  id: string;
  evidenceUrl: string;
  evidenceSha256: string;
  evidenceBytes: number;
  simulation: boolean;
  state: "draft" | "approved" | "dismissed";
  plate: string;
  notes: string;
  reviewer: string;
  createdAt: string;
  updatedAt: string;
};
export type ReviewPayload = {
  state: "approved" | "dismissed";
  reviewer: string;
  plate: string;
  notes: string;
};
export type QueueJob = {
  clientEventId: string;
  createdAt: number;
  bytes: number;
  attempts: number;
  nextAttemptAt: number;
  state: "pending" | "failed";
  error: string;
};
export const MAX_PENDING_EVENTS = 200;
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const retryDelay = (attempt: number) =>
  Math.min(60000, 1000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
export const permanentFailure = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;
export function serializeCapturePayload(payload: CapturePayload): string {
  return JSON.stringify({
    ...payload,
    ...(payload.vehicleBox === undefined
      ? {}
      : {
          vehicleBox:
            payload.vehicleBox === null
              ? null
              : Object.freeze([...payload.vehicleBox]),
        }),
  });
}
export function mergeCases(
  current: StoredCase[],
  incoming: StoredCase[],
): StoredCase[] {
  const result = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const old = result.get(record.id);
    if (
      !old ||
      record.updatedAt > old.updatedAt ||
      (record.updatedAt === old.updatedAt &&
        (old.state === "draft" || record.state !== "draft"))
    )
      result.set(record.id, record);
  }
  return [...result.values()]
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )
    .slice(0, 2000);
}
const DB_NAME = "velocity-pending-evidence";
let databasePromise: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(
          new Error("Durable evidence queue is unavailable in this browser."),
        );
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("jobs", { keyPath: "clientEventId" });
        db.createObjectStore("payloads", { keyPath: "clientEventId" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () =>
        reject(
          request.error ||
            new Error("Could not open the durable evidence queue."),
        );
      request.onblocked = () =>
        reject(
          new Error(
            "Another browser tab is blocking the evidence queue. Close the older tab and retry.",
          ),
        );
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ||
          new Error("Evidence queue transaction was aborted."),
      );
    transaction.onerror = () => {};
  });
}
export const pendingQueue = {
  async list(): Promise<QueueJob[]> {
    const db = await database();
    return result(
      db.transaction("jobs", "readonly").objectStore("jobs").getAll(),
    );
  },
  async payload(clientEventId: string): Promise<string> {
    const db = await database();
    const stored = await result<
      | {
          clientEventId: string;
          json: string;
        }
      | undefined
    >(
      db
        .transaction("payloads", "readonly")
        .objectStore("payloads")
        .get(clientEventId),
    );
    if (!stored)
      throw new Error(
        "A pending capture is missing its durable image payload.",
      );
    return stored.json;
  },
  async add(clientEventId: string, json: string): Promise<void> {
    const db = await database();
    const transaction = db.transaction(["jobs", "payloads"], "readwrite");
    const completion = finished(transaction);
    const jobs = transaction.objectStore("jobs"),
      payloads = transaction.objectStore("payloads");
    let validationError: Error | null = null;
    const request = jobs.getAll();
    request.onsuccess = () => {
      const entries = request.result as QueueJob[];
      const existing = entries.find(
        (job) => job.clientEventId === clientEventId,
      );
      if (existing) {
        const stored = payloads.get(clientEventId);
        stored.onsuccess = () => {
          if (stored.result?.json !== json) {
            validationError = new Error(
              "This event ID already has different pending evidence. Capture snapshots must remain unchanged.",
            );
            transaction.abort();
          }
        };
        return;
      }
      const bytes = new TextEncoder().encode(json).byteLength;
      if (
        entries.length >= MAX_PENDING_EVENTS ||
        entries.reduce((sum, job) => sum + job.bytes, 0) + bytes >
          MAX_PENDING_BYTES
      ) {
        validationError = new Error(
          "The durable evidence queue is full (200 captures or 64 MiB). Restore the local service to save pending captures before continuing. This capture has not been queued.",
        );
        transaction.abort();
        return;
      }
      const job: QueueJob = {
        clientEventId,
        createdAt: Date.now(),
        bytes,
        attempts: 0,
        nextAttemptAt: Date.now(),
        state: "pending",
        error: "",
      };
      jobs.add(job);
      payloads.add({ clientEventId, json });
    };
    try {
      await completion;
    } catch (error) {
      if (validationError) throw validationError;
      if (error instanceof DOMException && error.name === "QuotaExceededError")
        throw new Error(
          "Browser storage is full. This capture has not been queued; free storage before continuing.",
        );
      throw error;
    }
  },
  async update(job: QueueJob): Promise<void> {
    const db = await database();
    const transaction = db.transaction("jobs", "readwrite");
    const completion = finished(transaction);
    const store = transaction.objectStore("jobs");
    const request = store.get(job.clientEventId);
    request.onsuccess = () => {
      if (request.result) store.put(job);
    };
    await completion;
  },
  async remove(clientEventId: string): Promise<void> {
    const db = await database();
    const transaction = db.transaction(["jobs", "payloads"], "readwrite");
    const completion = finished(transaction);
    transaction.objectStore("jobs").delete(clientEventId);
    transaction.objectStore("payloads").delete(clientEventId);
    await completion;
  },
};
