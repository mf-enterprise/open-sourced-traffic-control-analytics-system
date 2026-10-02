import { Worker } from "node:worker_threads";
export async function createMonitorEngine() {
  const worker = new Worker(new URL("./monitor-worker.mjs", import.meta.url));
  const pending = new Map();
  let sequence = 0,
    closed = false;
  function fail() {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error("The native detector stopped responding."));
    }
    pending.clear();
  }
  worker.on("error", fail);
  worker.on("exit", () => {
    closed = true;
    fail();
  });
  worker.on("message", ({ id, result, error }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  });
  function rpc(method, frame, timeout = 15000) {
    if (closed)
      return Promise.reject(new Error("The native detector is closed."));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        fail();
        void worker.terminate();
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, frame });
    });
  }
  try {
    const info = await rpc("init", undefined, 60000);
    return {
      info,
      processFrame: (frame) => rpc("frame", frame),
      resetContext: () => rpc("reset"),
      async close() {
        if (closed) return;
        try {
          await rpc("close", undefined, 5000);
        } catch {}
        closed = true;
        fail();
        await worker.terminate();
      },
    };
  } catch (error) {
    closed = true;
    await worker.terminate();
    throw error;
  }
}
