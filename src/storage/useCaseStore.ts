import { useEffect, useSyncExternalStore } from "react";
import {
  mergeCases,
  pendingQueue,
  permanentFailure,
  retryDelay,
  serializeCapturePayload,
  type CapturePayload,
  type QueueJob,
  type ReviewPayload,
  type StoredCase,
} from "./queue";
export type { CapturePayload, StoredCase, ReviewPayload } from "./queue";
type Snapshot = {
  cases: StoredCase[];
  serverState: "connecting" | "online" | "offline";
  pendingCount: number;
  error: string;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The evidence operation failed.";
async function fetchJson(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The local evidence service returned an unreadable response.",
    );
  }
  return { response, data };
}
class CaseStoreService {
  private snapshot: Snapshot = {
    cases: [],
    serverState: "connecting",
    pendingCount: 0,
    error: "",
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listTimer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private refreshing: Promise<void> | null = null;
  private enqueueing: Promise<void> = Promise.resolve();
  private accepted = new Set<string>();
  private storageError = "";
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }
  start = () => {
    if (this.timer) return;
    void this.refresh();
    void this.readQueue();
    this.timer = setInterval(() => void this.pump(), 1000);
    this.listTimer = setInterval(() => void this.refresh(), 8000);
  };
  stop = () => {
    if (this.timer) clearInterval(this.timer);
    if (this.listTimer) clearInterval(this.listTimer);
    this.timer = null;
    this.listTimer = null;
  };
  private async readQueue(): Promise<QueueJob[]> {
    try {
      const jobs = await pendingQueue.list();
      const failed = jobs.filter((job) => job.state === "failed");
      this.update({
        pendingCount: jobs.length,
        error:
          this.storageError ||
          (failed.length
            ? `${failed.length} capture${failed.length === 1 ? "" : "s"} need attention: ${failed[0].error}`
            : ""),
      });
      return jobs;
    } catch (error) {
      this.storageError = message(error);
      this.update({ error: this.storageError });
      return [];
    }
  }
  private merge(records: StoredCase[]) {
    records.forEach((record) => this.accepted.add(record.clientEventId));
    this.update({ cases: mergeCases(this.snapshot.cases, records) });
  }
  refresh = (): Promise<void> => {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const { response, data } = await fetchJson("/api/cases?limit=2000");
        if (!response.ok || !Array.isArray(data.cases))
          throw new Error("The local evidence service is unavailable.");
        this.merge(data.cases);
        this.update({ serverState: "online" });
        void this.pump();
      } catch {
        this.update({ serverState: "offline" });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  };
  queueEvent = (payload: CapturePayload): Promise<void> => {
    if (payload.sourceKind === "demo") return Promise.resolve();
    const json = serializeCapturePayload(payload),
      clientEventId = payload.clientEventId;
    const operation = this.enqueueing.then(async () => {
      if (this.accepted.has(clientEventId)) return;
      try {
        await pendingQueue.add(clientEventId, json);
        this.storageError = "";
        await this.readQueue();
        void this.pump();
      } catch (error) {
        this.storageError = message(error);
        this.update({ error: this.storageError });
        throw error;
      }
    });
    this.enqueueing = operation.catch(() => {});
    return operation;
  };
  private async pump() {
    if (this.processing) return;
    this.processing = true;
    try {
      const jobs = await this.readQueue();
      const job = jobs
        .filter(
          (entry) =>
            entry.state === "pending" && entry.nextAttemptAt <= Date.now(),
        )
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!job) return;
      let status = 0;
      try {
        const json = await pendingQueue.payload(job.clientEventId);
        const { response, data } = await fetchJson("/api/cases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: json,
        });
        status = response.status;
        if (!response.ok)
          throw new Error(
            data.error || `Case storage returned HTTP ${status}.`,
          );
        if (!data.case?.id || data.case.clientEventId !== job.clientEventId)
          throw new Error(
            "The service acknowledgement did not match this capture.",
          );
        this.merge([data.case]);
        this.update({ serverState: "online" });
        await pendingQueue.remove(job.clientEventId);
      } catch (error) {
        const attempts = job.attempts + 1;
        const failed = permanentFailure(status);
        if (!status || status >= 500) this.update({ serverState: "offline" });
        await pendingQueue.update({
          ...job,
          attempts,
          state: failed ? "failed" : "pending",
          nextAttemptAt: Date.now() + retryDelay(attempts),
          error: message(error),
        });
      }
      await this.readQueue();
    } catch (error) {
      this.storageError = message(error);
      this.update({ error: this.storageError });
    } finally {
      this.processing = false;
    }
  }
  retryFailed = () => {
    void (async () => {
      try {
        this.storageError = "";
        const jobs = await pendingQueue.list();
        for (const job of jobs)
          if (job.state === "failed")
            await pendingQueue.update({
              ...job,
              state: "pending",
              attempts: 0,
              nextAttemptAt: Date.now(),
              error: "",
            });
        await this.readQueue();
        void this.pump();
      } catch (error) {
        this.storageError = message(error);
        this.update({ error: this.storageError });
      }
    })();
  };
  reviewCase = async (
    id: string,
    review: ReviewPayload,
  ): Promise<StoredCase> => {
    const { response, data } = await fetchJson(
      `/api/cases/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(review),
      },
    );
    if (!response.ok) {
      void this.refresh();
      throw new Error(data.error || "Review could not be saved.");
    }
    if (!data.case?.id)
      throw new Error(
        "The service returned an invalid review acknowledgement.",
      );
    this.merge([data.case]);
    this.update({ serverState: "online" });
    return data.case;
  };
}
const service = new CaseStoreService();
let consumers = 0;
export function useCaseStore() {
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  useEffect(() => {
    consumers++;
    service.start();
    return () => {
      consumers--;
      if (!consumers) service.stop();
    };
  }, []);
  return {
    ...snapshot,
    queueEvent: service.queueEvent,
    retryFailed: service.retryFailed,
    refresh: service.refresh,
    reviewCase: service.reviewCase,
  };
}
