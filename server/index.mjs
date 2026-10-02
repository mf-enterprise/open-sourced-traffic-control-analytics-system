import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createStore } from "./store.mjs";
import { resolveNestCamera } from "./nest.mjs";
import { createCameraGateway } from "./cameras.mjs";
import { createLocalCameras } from "./local-cameras.mjs";
import { createFrameSource } from "./frame-source.mjs";
import { createTrafficCameras } from "./traffic-cameras.mjs";
import { createMonitor } from "./monitor.mjs";
import { createMonitorJournal } from "./monitor-journal.mjs";
import { createEvidenceOutbox } from "./evidence-outbox.mjs";
import { closeServiceResources } from "./shutdown.mjs";
import {
  CASE_ID,
  MAX_BODY_BYTES,
  HttpError,
  listLimit,
  validateCase,
  validateReview,
} from "./validation.mjs";
const LOCAL_HOSTS = new Set([
  "127.0.0.1:5173",
  "localhost:5173",
  "127.0.0.1:5174",
  "localhost:5174",
]);
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((host) => `http://${host}`));
const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".onnx", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);
const STATIC_CSP =
  "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; script-src 'self' https: blob: 'unsafe-eval'; connect-src 'self' https: blob:; worker-src 'self' https: blob:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; img-src 'self' data: blob:; media-src 'self' https: blob:";
function within(root, path) {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
function staticRoot(directory) {
  if (!directory) return null;
  try {
    const root = realpathSync(resolve(directory));
    const index = realpathSync(resolve(root, "index.html"));
    if (
      !statSync(root).isDirectory() ||
      !within(root, index) ||
      !statSync(index).isFile()
    )
      throw new Error();
    return root;
  } catch {
    throw new Error(
      `Production build is missing or invalid at ${resolve(directory)}. Run "npm run build" before "npm start".`,
    );
  }
}
function serveStatic(request, response, root) {
  if (!root || !["GET", "HEAD"].includes(request.method)) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(request.url.split("?")[0]);
  } catch {
    throw new HttpError(400, "Invalid URL encoding.");
  }
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    /[\\\u0000:*?"<>|]/u.test(pathname)
  )
    throw new HttpError(404, "File not found.");
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.some((part) => part.startsWith(".")) ||
    ["api", "src", "server", "data", "node_modules"].includes(segments[0])
  )
    return false;
  const requested = resolve(
    root,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  if (!within(root, requested)) throw new HttpError(404, "File not found.");
  const mime = STATIC_TYPES.get(extname(requested).toLowerCase());
  if (!mime) return false;
  let path, info;
  try {
    path = realpathSync(requested);
    if (!within(root, path)) return false;
    info = statSync(path);
    if (!info.isFile()) return false;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return false;
    throw error;
  }
  const bytes = request.method === "HEAD" ? null : readFileSync(path);
  response.setHeader("Content-Security-Policy", STATIC_CSP);
  response.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": info.size,
  });
  response.end(bytes);
  return true;
}
function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}
function closeStorage(...resources) {
  const errors = [];
  for (const resource of resources) {
    try {
      resource?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Local storage could not be fully closed.",
    );
}
async function readJson(request) {
  if (
    request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new HttpError(415, "Requests must use application/json.");
  if (request.headers["content-encoding"])
    throw new HttpError(415, "Compressed request bodies are not supported.");
  const declared = request.headers["content-length"];
  if (declared && Number(declared) > MAX_BODY_BYTES)
    throw new HttpError(413, "Request exceeds the 5 MiB limit.");
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES)
      throw new HttpError(413, "Request exceeds the 5 MiB limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body must contain valid JSON.");
  }
}
export function createApiServer({
  dataDirectory = fileURLToPath(new URL("../data/", import.meta.url)),
  staticDirectory,
  monitorOptions,
  localCameras: suppliedLocalCameras,
  ffmpegPath,
  allowedHosts = LOCAL_HOSTS,
  allowedOrigins = LOCAL_ORIGINS,
} = {}) {
  const root = staticRoot(staticDirectory);
  const store = createStore(dataDirectory);
  let journal, outbox;
  try {
    journal = createMonitorJournal(dataDirectory);
    outbox = createEvidenceOutbox(dataDirectory);
  } catch (error) {
    try {
      closeStorage(outbox, journal, store);
    } catch {}
    throw error;
  }
  const cameras = createCameraGateway({ ffmpegPath });
  const trafficCameras = createTrafficCameras({ ffmpegPath });
  const localCameras =
    suppliedLocalCameras ?? createLocalCameras({ ffmpegPath });
  const monitor = createMonitor({
    createSource: (input, options) =>
      createFrameSource(input, { ...options, ffmpegPath }),
    ...monitorOptions,
    localCameras,
    store,
    journal,
    outbox,
  });
  let initialRecovery = Promise.resolve();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (
        !["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(
          request.socket.remoteAddress,
        )
      )
        throw new HttpError(
          403,
          "This service accepts local connections only.",
        );
      if (!allowedHosts.has(request.headers.host))
        throw new HttpError(403, "Untrusted Host header.");
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin))
        throw new HttpError(403, "Untrusted request origin.");
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new HttpError(403, "Cross-site requests are not allowed.");
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader(
          "Access-Control-Allow-Methods",
          "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
        );
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.writeHead(204);
        response.end();
        return;
      }
      if (!request.url?.startsWith("/") || request.url.startsWith("//"))
        throw new HttpError(400, "Invalid request target.");
      await initialRecovery;
      const url = new URL(request.url, "http://127.0.0.1:5174");
      if (url.pathname === "/api/traffic-cameras" && request.method === "GET") {
        json(response, 200, { cameras: trafficCameras.list() });
        return;
      }
      const trafficMatch =
        /^\/api\/traffic-cameras\/([a-z0-9-]+)\/(playback|snapshot)$/.exec(
          url.pathname,
        );
      if (trafficMatch && request.method === "GET") {
        if (trafficMatch[2] === "playback")
          json(response, 200, await trafficCameras.playback(trafficMatch[1]));
        else {
          const jpeg = await trafficCameras.snapshot(trafficMatch[1]);
          if (!response.destroyed) {
            response.setHeader("Content-Type", "image/jpeg");
            response.setHeader("Cache-Control", "private, max-age=60");
            response.end(jpeg);
          }
        }
        return;
      }
      if (url.pathname === "/api/monitor/history" && request.method === "GET") {
        const rawLimit = url.searchParams.get("limit") ?? "20";
        const rawBefore = url.searchParams.get("before");
        if (
          !/^[1-9]\d*$/.test(rawLimit) ||
          Number(rawLimit) > 100 ||
          (rawBefore !== null &&
            (!/^[1-9]\d*$/.test(rawBefore) ||
              !Number.isSafeInteger(Number(rawBefore))))
        )
          throw new HttpError(
            400,
            "Use a history limit from 1 to 100 and a valid earlier-session cursor.",
          );
        json(
          response,
          200,
          journal.history({
            limit: Number(rawLimit),
            before: rawBefore === null ? null : Number(rawBefore),
          }),
        );
        return;
      }
      const historyMatch =
        /^\/api\/monitor\/history\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
          url.pathname,
        );
      if (historyMatch && request.method === "GET") {
        const saved = journal.get(historyMatch[1]);
        if (!saved)
          throw new HttpError(404, "Saved monitor session not found.");
        json(response, 200, saved);
        return;
      }
      if (url.pathname === "/api/local-cameras" && request.method === "GET") {
        const abort = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) abort.abort();
        };
        response.once("close", cancel);
        try {
          const inventory = await localCameras.list({ signal: abort.signal });
          if (!response.destroyed) json(response, 200, inventory);
        } finally {
          response.removeListener("close", cancel);
        }
        return;
      }
      if (url.pathname === "/api/monitor" && request.method === "GET") {
        json(response, 200, { monitor: monitor.status() });
        return;
      }
      if (url.pathname === "/api/monitor/start" && request.method === "POST") {
        json(response, 202, {
          monitor: await monitor.start(await readJson(request)),
        });
        return;
      }
      if (
        url.pathname === "/api/monitor/config" &&
        request.method === "PATCH"
      ) {
        json(response, 200, {
          monitor: monitor.configure(await readJson(request)),
        });
        return;
      }
      if (url.pathname === "/api/monitor/stop" && request.method === "POST") {
        json(response, 200, {
          monitor: await monitor.stop(await readJson(request)),
        });
        return;
      }
      if (url.pathname === "/api/monitor/retry" && request.method === "POST") {
        json(response, 200, {
          monitor: await monitor.retry(await readJson(request)),
        });
        return;
      }
      if (
        url.pathname === "/api/monitor/recovery/retry" &&
        request.method === "POST"
      ) {
        json(response, 200, {
          monitor: await monitor.retryRecovery(await readJson(request)),
        });
        return;
      }
      if (url.pathname === "/api/monitor/frame" && request.method === "GET") {
        json(response, 200, {
          frame: monitor.frame({
            sessionId: url.searchParams.get("sessionId"),
            after: Number(url.searchParams.get("after") ?? 0),
          }),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, {
          status: "ok",
          service: "velocity-local",
          storage: "sqlite",
          localOnly: true,
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/cameras/connect"
      ) {
        const config = await readJson(request);
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new HttpError(400, "Enter a camera connection configuration.");
        if (config.type === "nest") {
          if (
            Object.keys(config).some(
              (key) => !["type", "url", "name"].includes(key),
            )
          )
            throw new HttpError(
              400,
              "Public Nest connections accept a sharing URL and optional name only.",
            );
          if (
            config.name !== undefined &&
            (typeof config.name !== "string" ||
              config.name.length > 80 ||
              /[\u0000-\u001f\u007f]/u.test(config.name) ||
              /(?:https?|rtsps?):\/\//i.test(config.name))
          )
            throw new HttpError(
              400,
              "Use a camera name of at most 80 characters, without a connection URL.",
            );
        }
        let camera = null,
          abandoned = false;
        response.once("close", () => {
          if (!response.writableEnded) {
            abandoned = true;
            if (camera && !camera.id.startsWith("nest-"))
              void cameras.disconnect(camera.id);
          }
        });
        camera =
          config.type === "nest"
            ? await resolveNestCamera(config.url)
            : await cameras.connect(config);
        if (abandoned || response.destroyed) {
          if (!camera.id.startsWith("nest-"))
            await cameras.disconnect(camera.id);
          return;
        }
        if (
          config.type === "nest" &&
          typeof config.name === "string" &&
          config.name.trim()
        )
          camera.name = config.name.trim();
        json(response, 200, { camera });
        return;
      }
      const cameraRoute = /^\/api\/cameras\/([A-Za-z0-9-]+)$/.exec(
        url.pathname,
      );
      if (request.method === "DELETE" && cameraRoute) {
        if (!cameraRoute[1].startsWith("nest-"))
          await cameras.disconnect(cameraRoute[1]);
        json(response, 200, { stopped: true });
        return;
      }
      if (await cameras.handle(request, response, url)) return;
      if (url.pathname === "/api/cases") {
        if (request.method === "GET") {
          json(
            response,
            200,
            store.list(listLimit(url.searchParams.get("limit"))),
          );
          return;
        }
        if (request.method === "POST") {
          const result = store.create(validateCase(await readJson(request)));
          json(response, result.duplicate ? 200 : 201, result);
          return;
        }
      }
      const match = /^\/api\/cases\/(VEL-\d{4}-\d{6,})(\/evidence)?$/.exec(
        url.pathname,
      );
      if (match) {
        const [, id, evidenceRoute] = match;
        if (evidenceRoute && request.method === "GET") {
          const bytes = store.evidence(id);
          response.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": bytes.length,
            "Content-Disposition": `inline; filename="${id}.jpg"`,
          });
          response.end(bytes);
          return;
        }
        if (!evidenceRoute && request.method === "GET") {
          const record = store.get(id);
          if (!record) throw new HttpError(404, "Case not found.");
          json(response, 200, { case: record });
          return;
        }
        if (!evidenceRoute && request.method === "PATCH") {
          json(response, 200, {
            case: store.review(id, validateReview(await readJson(request))),
          });
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/audit") {
        const caseId = url.searchParams.get("caseId");
        if (caseId && !CASE_ID.test(caseId))
          throw new HttpError(400, "Invalid caseId.");
        json(response, 200, {
          events: store.audit(listLimit(url.searchParams.get("limit")), caseId),
        });
        return;
      }
      if (serveStatic(request, response, root)) return;
      throw new HttpError(404, "Endpoint not found.");
    } catch (error) {
      if (!response.headersSent)
        json(response, error instanceof HttpError ? error.status : 500, {
          error:
            error instanceof HttpError
              ? error.message
              : "The local service could not complete this request.",
        });
      else response.end();
      if (!(error instanceof HttpError))
        console.error("Velocity API error:", error.message);
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.once("listening", () => {
    initialRecovery = (async () => {
      try {
        journal.recoverInterruptedSessions();
      } catch {
        server.close();
        server.emit(
          "error",
          new Error("Saved monitor sessions could not be recovered."),
        );
        return;
      }
      await monitor.recoverEvidence();
    })();
  });
  server.on("close", () => {
    server.monitorClosed = closeServiceResources({
      initialRecovery,
      monitor,
      cameras,
      localCameras,
      trafficCameras,
      storage: [outbox, journal, store],
    });
    void server.monitorClosed.catch(() => {});
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const production = process.argv.includes("--static");
    const server = createApiServer({
      staticDirectory: production
        ? fileURLToPath(new URL("../dist/", import.meta.url))
        : undefined,
    });
    server.on("error", (error) => {
      console.error(`Unable to start Velocity: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(5174, "127.0.0.1", () =>
      console.log(
        `Velocity local ${production ? "workspace" : "evidence service"}: http://127.0.0.1:5174`,
      ),
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(async () => {
        try {
          await server.monitorClosed;
        } catch {
          console.error(
            "Velocity stopped with unconfirmed resource cleanup. Check the local service before restarting.",
          );
          process.exitCode = 1;
        }
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(`Unable to start Velocity: ${error.message}`);
    process.exitCode = 1;
  }
}
