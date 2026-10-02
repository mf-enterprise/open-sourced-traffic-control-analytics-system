import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HttpError } from "./validation.mjs";
const CAMERA_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_NAME = /^segment-\d{9,15}\.ts$/;
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "rtsp:", "rtsps:"]);
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PROTOCOL_WHITELIST = "http,https,tcp,tls,udp,rtp,crypto";
const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
function text(value, label, maximum, optional = false) {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    CONTROL.test(value)
  )
    throw new HttpError(
      400,
      `${label} must be valid text of at most ${maximum} characters.`,
    );
  return value;
}
function credentials(config) {
  return {
    username: text(config.username, "Camera username", 256, true),
    password: text(config.password, "Camera password", 256, true),
  };
}
function networkUrl(value, auth, rtspOnly = false) {
  const source = text(value, "Camera URL", 4096);
  if (!source || /\s/u.test(source))
    throw new HttpError(
      400,
      "Enter a camera URL without spaces or line breaks.",
    );
  let parsed;
  try {
    parsed = new URL(source);
    if (CONTROL.test(decodeURIComponent(source))) throw new Error();
    credentials({
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  } catch {
    throw new HttpError(400, "Enter a valid network camera URL.");
  }
  if (
    !NETWORK_PROTOCOLS.has(parsed.protocol) ||
    (rtspOnly && !["rtsp:", "rtsps:"].includes(parsed.protocol))
  )
    throw new HttpError(
      400,
      rtspOnly
        ? "RTSP cameras require an rtsp:// or rtsps:// URL."
        : "Camera sources must use HTTP, HTTPS, RTSP, or RTSPS.",
    );
  if (!parsed.hostname || parsed.hash)
    throw new HttpError(
      400,
      "Camera URLs require a hostname and cannot contain a fragment.",
    );
  if (auth.username !== undefined || auth.password !== undefined) {
    parsed.username = encodeURIComponent(auth.username ?? "");
    parsed.password = encodeURIComponent(auth.password ?? "");
  }
  return parsed;
}
export function validateCameraConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "Camera configuration must be an object.");
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "type",
          "url",
          "host",
          "port",
          "username",
          "password",
          "name",
        ].includes(key),
    )
  )
    throw new HttpError(
      400,
      "Camera configuration contains an unsupported field.",
    );
  if (!["url", "rtsp", "onvif"].includes(input.type))
    throw new HttpError(400, "Choose a network URL, RTSP, or ONVIF camera.");
  const auth = credentials(input);
  const name =
    (text(input.name, "Camera name", 80, true) ?? "Network camera").trim() ||
    "Network camera";
  if (/(?:https?|rtsps?):\/\//i.test(name))
    throw new HttpError(
      400,
      "Use a camera name rather than its connection URL.",
    );
  if (input.type === "onvif") {
    let host = text(input.host, "ONVIF host", 253).trim();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (
      !isIP(host) &&
      !host
        .split(".")
        .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    )
      throw new HttpError(
        400,
        "Enter an ONVIF hostname or IP address without a URL path.",
      );
    const port = input.port ?? 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new HttpError(400, "ONVIF port must be between 1 and 65535.");
    if (input.url !== undefined)
      throw new HttpError(
        400,
        "ONVIF cameras use a host and port, not a stream URL.",
      );
    return { type: input.type, name, host, port, ...auth };
  }
  if (input.host !== undefined || input.port !== undefined)
    throw new HttpError(
      400,
      "Include the camera host and port in its stream URL.",
    );
  return {
    type: input.type,
    name,
    url: networkUrl(input.url, auth, input.type === "rtsp").href,
  };
}
export async function resolveCameraInput(input) {
  const config = validateCameraConfig(input);
  const url =
    config.type === "onvif"
      ? networkUrl(await resolveOnvif(config), credentials(config)).href
      : config.url;
  return { url, name: config.name, type: config.type };
}
function cameraError(
  stderr,
  fallback = "The camera stream stopped. Check the source and reconnect.",
) {
  const message = String(stderr).toLowerCase();
  if (/option.*not found|error setting option/.test(message))
    return "The video gateway could not initialize this camera format.";
  if (
    /401|403|unauthori[sz]ed|forbidden|authentication|not authorized/.test(
      message,
    )
  )
    return "Camera authentication failed. Check the username and password.";
  if (/certificate|tls handshake|ssl|tls.*failed/.test(message))
    return "The camera TLS connection could not be verified. Check its certificate and address.";
  if (
    /resolve|name or service not known|host not found|enotfound|nodename/.test(
      message,
    )
  )
    return "The camera hostname could not be resolved. Check its address.";
  if (
    /connection refused|no route|unreachable|econnrefused|ehostunreach/.test(
      message,
    )
  )
    return "The camera could not be reached. Check its address, port, and network connection.";
  if (/timed? ?out|timeout/.test(message))
    return "The camera timed out. Check that it is reachable and its video stream is enabled.";
  if (
    /protocol.*not on whitelist|not on whitelist|invalid data|does not contain any stream|stream map|decoder.*not found|unsupported/.test(
      message,
    )
  )
    return "The source did not provide a supported network video stream.";
  return fallback;
}
async function resolveOnvif(config) {
  const imported = await import("onvif");
  const Cam = imported.Cam ?? imported.default?.Cam;
  if (!Cam)
    throw new HttpError(503, "The ONVIF camera adapter is unavailable.");
  return new Promise((resolveUri, reject) => {
    let settled = false;
    const finish = (error, uri) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error)
        reject(
          new HttpError(
            502,
            cameraError(
              error.message,
              "ONVIF discovery failed. Check the device address, port, credentials, and ONVIF setting.",
            ),
          ),
        );
      else resolveUri(uri);
    };
    const timer = setTimeout(() => finish(new Error("ONVIF timeout")), 15000);
    try {
      new Cam(
        {
          hostname: config.host,
          port: config.port,
          username: config.username ?? "",
          password: config.password ?? "",
          timeout: 10000,
          preserveAddress: true,
        },
        function (error) {
          if (error) return finish(error);
          if (settled) return;
          try {
            this.getStreamUri({ protocol: "RTSP" }, (streamError, stream) => {
              if (streamError) return finish(streamError);
              if (!stream?.uri)
                return finish(new Error("Unsupported ONVIF stream"));
              finish(null, stream.uri);
            });
          } catch (streamError) {
            finish(streamError);
          }
        },
      );
    } catch (error) {
      finish(error);
    }
  });
}
function ffmpegArguments(input, directory) {
  const rtsp = ["rtsp:", "rtsps:"].includes(input.protocol);
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-y",
    "-protocol_whitelist",
    PROTOCOL_WHITELIST,
    ...(rtsp
      ? ["-rtsp_transport", "tcp", "-timeout", "10000000"]
      : [
          "-rw_timeout",
          "10000000",
          "-re",
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
          "-reconnect_delay_max",
          "2",
        ]),
    "-fflags",
    "+genpts+discardcorrupt",
    "-i",
    input.href,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-vf",
    "fps=15,scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-crf",
    "23",
    "-maxrate",
    "6M",
    "-bufsize",
    "12M",
    "-threads",
    "2",
    "-g",
    "15",
    "-keyint_min",
    "15",
    "-sc_threshold",
    "0",
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "6",
    "-hls_delete_threshold",
    "2",
    "-hls_flags",
    "delete_segments+program_date_time+independent_segments+temp_file",
    "-hls_segment_filename",
    join(directory, "segment-%09d.ts"),
    join(directory, "index.m3u8"),
  ];
}
async function playablePlaylist(directory) {
  try {
    const playlist = await readFile(join(directory, "index.m3u8"), "utf8");
    if (!playlist.startsWith("#EXTM3U") || !playlist.includes("#EXTINF:"))
      return false;
    const segment = playlist
      .split(/\r?\n/)
      .find((line) => SEGMENT_NAME.test(line));
    if (!segment) return false;
    const file = await open(join(directory, segment), "r");
    try {
      const buffer = Buffer.alloc(377);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return (
        bytesRead >= 377 &&
        buffer[0] === 0x47 &&
        buffer[188] === 0x47 &&
        buffer[376] === 0x47
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}
async function stopProcess(camera) {
  clearInterval(camera.monitor);
  if (!camera.process) return;
  if (camera.stopPromise) return camera.stopPromise;
  const child = camera.process;
  camera.stopPromise = (async () => {
    if (camera.exited) return;
    const waitForClose = (milliseconds) =>
      new Promise((resolveExit) => {
        if (camera.exited) {
          resolveExit();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          child.off("close", finish);
          resolveExit();
        };
        const timer = setTimeout(finish, milliseconds);
        child.once("close", finish);
      });
    try {
      child.kill("SIGTERM");
    } catch {}
    await waitForClose(1800);
    if (!camera.exited) {
      try {
        child.kill("SIGKILL");
      } catch {}
      await waitForClose(800);
    }
  })();
  return camera.stopPromise;
}
function json(response, status, body, head = false) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(head ? undefined : bytes);
}
export function createCameraGateway(options = {}) {
  const cameras = new Map();
  const cleanupTasks = new Set();
  const temporaryRoot = resolve(options.tmpRoot ?? tmpdir());
  const spawnProcess = options.spawn ?? spawn;
  const discoverOnvif = options.resolveOnvif ?? resolveOnvif;
  const startupTimeout = Math.min(30000, options.startupTimeoutMs ?? 30000);
  const pollInterval = options.pollIntervalMs ?? 150;
  const idleTimeout = Math.max(1, options.idleTimeoutMs ?? 120000);
  const idleCheckInterval = Math.max(
    1,
    options.idleCheckIntervalMs ?? Math.min(2000, idleTimeout / 2),
  );
  const now = options.now ?? Date.now;
  let closed = false;
  function cleanup(camera) {
    if (camera.cleanupPromise) return camera.cleanupPromise;
    camera.cancelled = true;
    clearInterval(camera.monitor);
    clearInterval(camera.idleMonitor);
    const operation = (async () => {
      await stopProcess(camera);
      const directory = camera.directory;
      camera.directory = null;
      if (!directory) return;
      const target = resolve(directory);
      if (
        dirname(target) !== temporaryRoot ||
        !basename(target).startsWith("velocity-camera-")
      )
        throw new Error("Camera temporary directory boundary check failed.");
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    })();
    camera.cleanupPromise = operation;
    cleanupTasks.add(operation);
    void operation
      .finally(() => {
        camera.cleanupPromise = null;
        cleanupTasks.delete(operation);
      })
      .catch(() => {});
    return operation;
  }
  async function disconnect(id) {
    const camera = cameras.get(id);
    if (!camera) return false;
    cameras.delete(id);
    await cleanup(camera);
    return true;
  }
  async function connect(config) {
    if (closed)
      throw new HttpError(503, "The camera gateway is shutting down.");
    const validated = validateCameraConfig(config);
    if (cameras.size >= 2)
      throw new HttpError(
        409,
        "Two network cameras are already connected. Disconnect one before adding another.",
      );
    const camera = {
      id: randomUUID(),
      name: validated.name,
      type: validated.type,
      status: "starting",
      error: "",
      directory: null,
      process: null,
      exited: false,
      cancelled: false,
      stderr: "",
      lastAccessAt: now(),
      healthCheckRunning: false,
      cleanupPromise: null,
    };
    cameras.set(camera.id, camera);
    camera.idleMonitor = setInterval(() => {
      if (!camera.cancelled && now() - camera.lastAccessAt >= idleTimeout) {
        void disconnect(camera.id).catch(() => {
          console.error(
            "An idle camera session could not be fully cleaned up.",
          );
        });
      }
    }, idleCheckInterval);
    camera.idleMonitor.unref?.();
    const checkActive = () => {
      if (closed || camera.cancelled || !cameras.has(camera.id))
        throw new HttpError(409, "The camera connection was cancelled.");
    };
    try {
      let input;
      if (validated.type === "onvif") {
        const discovered = await discoverOnvif(validated);
        input = networkUrl(discovered, credentials(validated));
      } else input = new URL(validated.url);
      checkActive();
      const executable =
        options.ffmpegPath ?? (await import("ffmpeg-static")).default;
      if (!executable)
        throw new HttpError(
          503,
          "FFmpeg is not available for this operating system.",
        );
      checkActive();
      camera.directory = await mkdtemp(join(temporaryRoot, "velocity-camera-"));
      checkActive();
      const child = spawnProcess(
        executable,
        ffmpegArguments(input, camera.directory),
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      camera.process = child;
      child.stderr?.on("data", (bytes) => {
        camera.stderr = (camera.stderr + bytes.toString()).slice(-8192);
      });
      child.once("error", () => {
        camera.exited = true;
        clearInterval(camera.monitor);
        if (!camera.cancelled) {
          camera.status = "error";
          camera.error =
            "The video gateway could not start. Check that FFmpeg is installed correctly.";
        }
      });
      child.once("close", (code) => {
        camera.exited = true;
        clearInterval(camera.monitor);
        if (!camera.cancelled) {
          camera.status =
            code === 0 && camera.status === "live" ? "ended" : "error";
          camera.error = cameraError(
            camera.stderr,
            code === 0 ? "The camera source has ended." : undefined,
          );
        }
        camera.stderr = "";
      });
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        checkActive();
        const playable = await playablePlaylist(camera.directory);
        checkActive();
        if (playable) {
          if (camera.exited && camera.status === "error")
            throw new HttpError(
              502,
              camera.error ||
                "The source stopped before live playback could begin.",
            );
          camera.status = "live";
          camera.lastAccessAt = now();
          camera.monitor = setInterval(async () => {
            if (
              camera.cancelled ||
              camera.status !== "live" ||
              !camera.directory ||
              camera.healthCheckRunning
            )
              return;
            camera.healthCheckRunning = true;
            try {
              const info = await stat(join(camera.directory, "index.m3u8"));
              if (
                camera.cancelled ||
                camera.exited ||
                camera.status !== "live" ||
                cameras.get(camera.id) !== camera
              )
                return;
              if (Date.now() - info.mtimeMs > 20000) {
                camera.status = "error";
                camera.error =
                  "The camera stopped sending video. Check the connection and reconnect.";
                await stopProcess(camera);
              }
            } catch {
            } finally {
              camera.healthCheckRunning = false;
            }
          }, 2000);
          camera.monitor.unref?.();
          return {
            id: camera.id,
            name: camera.name,
            type: camera.type,
            playbackUrl: `/api/cameras/${camera.id}/index.m3u8`,
            status: "live",
          };
        }
        if (camera.exited)
          throw new HttpError(502, camera.error || cameraError(camera.stderr));
        await delay(pollInterval);
      }
      throw new HttpError(
        504,
        "No playable video arrived within 30 seconds. Check the stream address, credentials, and camera video settings.",
      );
    } catch (error) {
      cameras.delete(camera.id);
      await cleanup(camera);
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        cameraError(
          error?.message,
          "The camera could not be connected. Check the network address and stream settings.",
        ),
      );
    }
  }
  async function handle(request, response, url) {
    const pathname =
      typeof url === "string"
        ? new URL(url, "http://localhost").pathname
        : url.pathname;
    const match = /^\/api\/cameras\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (!match) return false;
    const [, id, file] = match;
    if (
      !CAMERA_ID.test(id) ||
      (file !== "status" && file !== "index.m3u8" && !SEGMENT_NAME.test(file))
    ) {
      json(
        response,
        404,
        { error: "Camera resource not found." },
        request.method === "HEAD",
      );
      return true;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Allow", "GET, HEAD");
      json(response, 405, { error: "Method not allowed." });
      return true;
    }
    const camera = cameras.get(id);
    if (!camera || camera.cancelled) {
      json(
        response,
        404,
        { error: "Camera session not found." },
        request.method === "HEAD",
      );
      return true;
    }
    if (file === "status") {
      camera.lastAccessAt = now();
      json(
        response,
        200,
        {
          id,
          name: camera.name,
          type: camera.type,
          status: camera.status,
          ...(camera.error ? { error: camera.error } : {}),
        },
        request.method === "HEAD",
      );
      return true;
    }
    if (!camera.directory) {
      json(
        response,
        503,
        { error: "The camera is still connecting." },
        request.method === "HEAD",
      );
      return true;
    }
    try {
      const bytes = await readFile(join(camera.directory, file));
      if (camera.cancelled || cameras.get(id) !== camera) {
        json(
          response,
          404,
          { error: "Camera session not found." },
          request.method === "HEAD",
        );
        return true;
      }
      camera.lastAccessAt = now();
      response.writeHead(200, {
        "Content-Type":
          file === "index.m3u8"
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      json(
        response,
        404,
        { error: "This video segment is no longer available." },
        request.method === "HEAD",
      );
    }
    return true;
  }
  async function close() {
    closed = true;
    const stopping = [...cameras.keys()].map(disconnect);
    const results = await Promise.allSettled([...stopping, ...cleanupTasks]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  return { connect, handle, disconnect, close };
}
