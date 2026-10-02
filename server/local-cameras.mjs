import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HttpError } from "./validation.mjs";
const MAX_LIST_BYTES = 256 * 1024;
const MAX_DEVICES = 64;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const sources = new WeakMap();
const unavailable = () =>
  new HttpError(
    503,
    "Local camera discovery is unavailable. Check the camera driver and restart the service.",
  );
const cancelled = () =>
  new HttpError(409, "Local camera discovery was cancelled.");
const cleanupError = () =>
  Object.assign(
    new HttpError(
      503,
      "Local camera discovery could not stop. Restart the service before trying again.",
    ),
    { code: "LOCAL_CAMERA_CLEANUP" },
  );
function option(value, fallback, label, maximum) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > maximum)
    throw new RangeError(`${label} is outside its supported range.`);
  return result;
}
function publicName(raw) {
  if (
    !raw.trim() ||
    CONTROL.test(raw) ||
    /[a-z][a-z\d+.-]*:\/\/|(?:data|blob):|\S+:\S+@|@device_/iu.test(raw)
  )
    return "USB camera";
  let name = "";
  for (const character of raw.trim()) {
    if (name.length + character.length > 80) break;
    name += character;
  }
  return name;
}
export function parseLocalCameraListing(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_LIST_BYTES)
    throw unavailable();
  const devices = new Map();
  let pending = null,
    recognized = false;
  for (const raw of value.split(/\r?\n/)) {
    if (raw.length > 8192) throw unavailable();
    const match = /^\[dshow @ [^\]\r\n]+\]\s+(.*)$/u.exec(raw);
    if (!match) continue;
    const line = match[1];
    const record =
      /^"(.*)" \((video|audio|audio, video|video, audio|none)\)$/u.exec(line);
    if (record) {
      if (pending?.video) throw unavailable();
      recognized = true;
      pending = {
        name: publicName(record[1]),
        video: record[2].split(", ").includes("video"),
      };
      continue;
    }
    const alternative = /^Alternative name "([^"\r\n]+)"$/u.exec(line);
    if (alternative) {
      if (!pending) throw unavailable();
      if (pending.video) {
        const name = alternative[1];
        if (
          !/^@device_/u.test(name) ||
          name.length > 4096 ||
          CONTROL.test(name) ||
          /[:"]/u.test(name)
        )
          throw unavailable();
        const previous = devices.get(name);
        if (previous && previous.name !== pending.name) throw unavailable();
        devices.set(name, { name: pending.name, alternativeName: name });
        if (devices.size > MAX_DEVICES) throw unavailable();
      }
      pending = null;
      continue;
    }
    if (/^Could not enumerate video devices \(or none found\)\.$/u.test(line)) {
      if (pending?.video) throw unavailable();
      recognized = true;
      pending = null;
      continue;
    }
    if (
      line.startsWith('"') ||
      line.startsWith("Alternative name") ||
      pending?.video
    )
      throw unavailable();
    pending = null;
  }
  if (!recognized || pending?.video) throw unavailable();
  return [...devices.values()];
}
export function readLocalCameraSource(source) {
  if (!source || typeof source !== "object") return null;
  const record = sources.get(source);
  if (!record) return null;
  if (!record.valid())
    throw new TypeError(
      "The selected local camera is no longer available. Refresh the camera list.",
    );
  return { protocol: "dshow:", value: `video=${record.alternativeName}` };
}
async function enumerate(options, signal, onCleanupFailure) {
  if (signal.aborted) throw cancelled();
  let executable;
  try {
    executable = options.ffmpegPath ?? (await import("ffmpeg-static")).default;
  } catch {
    throw unavailable();
  }
  if (signal.aborted) throw cancelled();
  if (typeof executable !== "string" || !executable) throw unavailable();
  let child;
  try {
    child = (options.spawn ?? spawnChild)(
      executable,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-list_devices",
        "true",
        "-f",
        "dshow",
        "-i",
        "dummy",
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch {
    throw unavailable();
  }
  return new Promise((resolve, reject) => {
    let closed = false,
      settled = false,
      failure = null,
      bytes = Buffer.allocUnsafe(MAX_LIST_BYTES),
      length = 0;
    let deadline, killTimer, closeTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      signal.removeEventListener("abort", abort);
      bytes = null;
      if (error) reject(error);
      else resolve(result);
    };
    const kill = (kind) => {
      try {
        child.kill(kind);
      } catch {}
    };
    const stop = (error) => {
      if (settled || failure) return;
      failure = error;
      bytes = null;
      clearTimeout(deadline);
      if (closed) return finish(failure);
      kill("SIGTERM");
      if (closed) return;
      killTimer = setTimeout(() => {
        if (closed) return;
        kill("SIGKILL");
        if (closed) return;
        closeTimer = setTimeout(() => {
          if (closed) return;
          const error = cleanupError();
          onCleanupFailure(error);
          finish(error);
        }, options.killTimeoutMs);
      }, options.killTimeoutMs);
    };
    const abort = () => stop(cancelled());
    child.stderr?.on("data", (chunk) => {
      if (settled || failure) return;
      if (
        !(chunk instanceof Uint8Array) ||
        length + chunk.length > MAX_LIST_BYTES
      )
        return stop(unavailable());
      bytes.set(chunk, length);
      length += chunk.length;
    });
    child.stderr?.on("error", () => stop(unavailable()));
    child.on("error", () => {
      if (!child.pid) closed = true;
      stop(unavailable());
    });
    child.once("close", (code, closeSignal) => {
      closed = true;
      if (settled) return;
      if (failure) return finish(failure);
      try {
        const stderr = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        );
        if (
          closeSignal ||
          ![0, 1].includes(code) ||
          !/Immediate exit requested/u.test(stderr)
        )
          throw unavailable();
        finish(null, parseLocalCameraListing(stderr));
      } catch {
        finish(unavailable());
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    deadline = setTimeout(
      () =>
        stop(
          new HttpError(
            504,
            "Local camera discovery timed out. Check the camera driver and try again.",
          ),
        ),
      options.timeoutMs,
    );
    if (signal.aborted) abort();
  });
}
export function createLocalCameras(options = {}) {
  const settings = {
    ...options,
    timeoutMs: option(options.timeoutMs, 10000, "Discovery timeout", 60000),
    killTimeoutMs: option(
      options.killTimeoutMs,
      1000,
      "Discovery stop timeout",
      10000,
    ),
  };
  const supported = (options.platform ?? process.platform) === "win32";
  let closed = false,
    pending = null,
    cleanupFailure = null,
    closePromise = null;
  let byId = new Map(),
    byAlternative = new Map();
  const check = (signal) => {
    if (cleanupFailure) throw cleanupFailure;
    if (closed)
      throw new HttpError(503, "Local camera discovery is shutting down.");
    if (signal?.aborted) throw cancelled();
  };
  function scan(signal) {
    check(signal);
    if (!pending) {
      const operation = {
        controller: new AbortController(),
        clients: new Set(),
        promise: null,
      };
      pending = operation;
      operation.promise = enumerate(
        settings,
        operation.controller.signal,
        (error) => {
          cleanupFailure = error;
        },
      )
        .then((devices) => {
          check(operation.controller.signal);
          const nextIds = new Map(),
            nextAlternatives = new Map();
          for (const device of devices) {
            const previous = byAlternative.get(device.alternativeName);
            const record = { ...device, id: previous?.id ?? randomUUID() };
            nextIds.set(record.id, record);
            nextAlternatives.set(record.alternativeName, record);
          }
          byId = nextIds;
          byAlternative = nextAlternatives;
        })
        .finally(() => {
          if (pending === operation) pending = null;
        });
      void operation.promise.catch(() => {});
    }
    const operation = pending;
    return new Promise((resolve, reject) => {
      const client = {};
      let settled = false;
      operation.clients.add(client);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        operation.clients.delete(client);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        if (settled) return;
        if (operation.clients.size === 1) {
          operation.controller.abort();
        } else finish(cancelled());
      };
      operation.promise.then(
        () => finish(signal?.aborted ? cancelled() : null),
        (error) => finish(error),
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async function list({ signal } = {}) {
    check(signal);
    if (!supported)
      return {
        supported: false,
        devices: [],
        reason:
          "Background USB capture is currently available on Windows. Use browser USB capture on this operating system.",
      };
    await scan(signal);
    check(signal);
    return {
      supported: true,
      devices: [...byId.values()].map(({ id, name }) => ({ id, name })),
      reason: null,
    };
  }
  async function resolve(id, { signal } = {}) {
    check(signal);
    if (!supported)
      throw new HttpError(
        400,
        "Background USB capture is currently available on Windows.",
      );
    if (typeof id !== "string" || !UUID.test(id) || !byId.has(id))
      throw new HttpError(
        400,
        "Choose a local camera from the refreshed camera list.",
      );
    await scan(signal);
    check(signal);
    const record = byId.get(id);
    if (!record)
      throw new HttpError(
        409,
        "The selected local camera was disconnected. Refresh the camera list.",
      );
    const source = Object.freeze({});
    sources.set(source, {
      alternativeName: record.alternativeName,
      valid: () =>
        !closed &&
        !cleanupFailure &&
        byId.get(id)?.alternativeName === record.alternativeName,
    });
    return { source, name: record.name, type: "usb" };
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    byId.clear();
    byAlternative.clear();
    const operation = pending;
    operation?.controller.abort();
    closePromise = (async () => {
      await operation?.promise.catch(() => {});
      if (cleanupFailure) throw cleanupFailure;
    })();
    return closePromise;
  }
  return { list, resolve, close };
}
