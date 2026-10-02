import { readFileSync } from "node:fs";
import sharp from "sharp";
import { resolveNestCamera } from "./nest.mjs";
import { createFrameSource } from "./frame-source.mjs";
import { HttpError } from "./validation.mjs";
const catalog = JSON.parse(
  readFileSync(
    new URL("./traffic-camera-catalog.json", import.meta.url),
    "utf8",
  ),
);
export const trafficCameraId = (config) =>
  catalog.find(
    (camera) =>
      camera.config.type === config.type && camera.config.url === config.url,
  )?.id ?? null;
export function createTrafficCameras({
  ffmpegPath,
  resolveNest = resolveNestCamera,
  createSource = createFrameSource,
  now = Date.now,
  fetchImpl = fetch,
} = {}) {
  const entries = new Map(catalog.map((camera) => [camera.id, camera]));
  const playbackCache = new Map();
  const snapshots = new Map();
  const jobs = new Set();
  const waiting = [];
  const sources = new Set();
  const abort = new AbortController();
  const cleanupErrors = [];
  let active = 0;
  let closed = false;
  function camera(id) {
    if (closed) throw new HttpError(503, "The camera directory is stopping.");
    const item = entries.get(id);
    if (!item) throw new HttpError(404, "Camera not found in the directory.");
    return item;
  }
  async function playback(id) {
    const item = camera(id);
    const cached = playbackCache.get(id);
    if (cached && now() - cached.created < 20000) return cached.promise;
    const promise = Promise.resolve().then(async () => {
      const resolved =
        item.config.type === "nest"
          ? await resolveNest(item.config.url, { signal: abort.signal })
          : { playbackUrl: item.config.url };
      return {
        playbackUrl: resolved.playbackUrl,
        ...(resolved.snapshotUrl ? { snapshotUrl: resolved.snapshotUrl } : {}),
        checkedAt: new Date(now()).toISOString(),
      };
    });
    playbackCache.set(id, { created: now(), promise });
    promise.catch(() => {
      if (playbackCache.get(id)?.promise === promise) playbackCache.delete(id);
    });
    return promise;
  }
  async function acquire() {
    if (active < 2) {
      active++;
      return;
    }
    await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  }
  function release() {
    const next = waiting.shift();
    if (next) next.resolve();
    else active--;
  }
  async function providerSnapshot(url) {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    if (
      !response.ok ||
      !/^image\/(jpeg|png)(?:;|$)/i.test(
        response.headers.get("content-type") || "",
      )
    ) {
      await response.body?.cancel();
      throw new Error("Camera snapshot unavailable.");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576)
          throw new Error("Camera snapshot exceeds the size limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return sharp(Buffer.concat(chunks), { limitInputPixels: 2097152 })
      .resize({ width: 480 })
      .jpeg({ quality: 75 })
      .toBuffer();
  }
  async function capture(id) {
    await acquire();
    let source, timer, cancel;
    try {
      camera(id);
      let accept, reject;
      const frame = new Promise((resolve, fail) => {
        accept = resolve;
        reject = fail;
      });
      cancel = () =>
        reject(new HttpError(503, "The camera directory is stopping."));
      abort.signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(
        () => reject(new HttpError(504, "Camera snapshot timed out.")),
        15000,
      );
      frame.catch(() => {});
      const result = await Promise.race([playback(id), frame]);
      camera(id);
      if (result.snapshotUrl) {
        try {
          return await providerSnapshot(result.snapshotUrl);
        } catch {
          camera(id);
        }
      }
      source = await createSource(result.playbackUrl, {
        ffmpegPath,
        fps: 1,
        onFrame: accept,
        onError: reject,
      });
      sources.add(source);
      if (closed) throw new HttpError(503, "The camera directory is stopping.");
      const image = await frame;
      return await sharp(image.rgb, {
        raw: { width: image.width, height: image.height, channels: 3 },
      })
        .resize({ width: 480 })
        .jpeg({ quality: 75 })
        .toBuffer();
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancel);
      try {
        if (source) {
          await source.stop();
          sources.delete(source);
        }
      } catch (error) {
        cleanupErrors.push(error);
        closed = true;
        abort.abort();
        for (const job of waiting.splice(0)) job.reject(error);
        throw error;
      } finally {
        release();
      }
    }
  }
  function snapshot(id) {
    camera(id);
    const cached = snapshots.get(id);
    if (cached && now() - cached.created < cached.ttl) return cached.promise;
    const value = { created: now(), ttl: Infinity, promise: null };
    const job = capture(id);
    value.promise = job;
    snapshots.set(id, value);
    jobs.add(job);
    job
      .then(
        () => {
          value.created = now();
          value.ttl = 60000;
        },
        () => {
          value.created = now();
          value.ttl = 15000;
        },
      )
      .finally(() => jobs.delete(job));
    return job;
  }
  return {
    list: () =>
      catalog.map((item) => ({
        ...item,
        config: { ...item.config },
        previewUrl: `/api/traffic-cameras/${item.id}/snapshot`,
      })),
    playback,
    snapshot,
    async close() {
      closed = true;
      abort.abort();
      for (const job of waiting.splice(0))
        job.reject(new HttpError(503, "The camera directory is stopping."));
      await Promise.allSettled([...jobs]);
      snapshots.clear();
      playbackCache.clear();
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Camera preview cleanup could not be confirmed.",
        );
    },
  };
}
