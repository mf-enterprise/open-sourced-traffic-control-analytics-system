import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { fork } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, isAbsolute, basename } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ensureVideoEngine } from "./runtime.mjs";
import { allowedDownload, trustedUrl } from "./policies.mjs";

const directory = fileURLToPath(new URL("./", import.meta.url));
const catalog = JSON.parse(
  await readFile(
    new URL("../server/traffic-camera-catalog.json", import.meta.url),
    "utf8",
  ),
);
const externalSources = new Set(
  catalog
    .map(({ sourcePage }) => sourcePage)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" && !parsed.username && !parsed.password
        );
      } catch {
        return false;
      }
    }),
);
const smokeIndex = process.argv.indexOf("--smoke-test-dir");
const smokeDirectory = smokeIndex >= 0 ? process.argv[smokeIndex + 1] : null;
if (smokeDirectory && !isAbsolute(smokeDirectory))
  throw new Error("Smoke-test directory must be absolute.");
app.setName("Traffic Control");
if (smokeDirectory) app.setPath("userData", resolve(smokeDirectory));
const setupUrl = pathToFileURL(join(directory, "setup.html")).href;
const controller = new AbortController();
let window,
  backend,
  origin = null,
  booting = false,
  quitting = false,
  quitAllowed = false,
  backendClosed = false;
let backendReady,
  backendStopped,
  selfTestResult,
  backendDiagnostic = "";

function status(value) {
  if (window && !window.isDestroyed())
    window.webContents.send("setup-status", value);
}
function trusted(url) {
  return trustedUrl(url, origin);
}
async function stopBackend() {
  if (!backend || backendClosed) return;
  if (backend.connected) backend.send({ type: "close" });
  const timer = setTimeout(() => {
    if (!backendClosed) backend.kill("SIGTERM");
  }, 30000);
  try {
    await backendStopped;
  } finally {
    clearTimeout(timer);
  }
}
async function runSmoke(ffmpegPath) {
  const get = async (path) => {
    const response = await fetch(`${origin}${path}`);
    if (!response.ok)
      throw new Error(`Smoke endpoint ${path}: ${response.status}`);
    return response.json();
  };
  const health = await get("/api/health");
  const before = await get("/api/monitor");
  const cases = await get("/api/cases");
  const publicCameras = await get("/api/traffic-cameras");
  const statusWithHeaders = (headers) =>
    new Promise((resolveStatus, reject) => {
      const query = request(`${origin}/api/health`, { headers }, (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      });
      query.on("error", reject);
      query.end();
    });
  const invalidHost = await statusWithHeaders({ Host: "invalid.example" });
  const invalidOrigin = await statusWithHeaders({
    Origin: "https://invalid.example",
  });
  const native = new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(
      () => rejectResult(new Error("Native desktop self-test timed out.")),
      90000,
    );
    selfTestResult = (message) => {
      clearTimeout(timeout);
      message.error
        ? rejectResult(new Error(message.error))
        : resolveResult(message.result);
    };
  });
  backend.send({ type: "self-test", ffmpegPath, directory: smokeDirectory });
  const nativeResult = await native;
  const exportDirectory = join(smokeDirectory, "exports");
  await mkdir(exportDirectory, { recursive: true });
  const exportResults = [];
  for (const fixture of [
    {
      name: "traffic-control-smoke.csv",
      type: "text/csv",
      text: "track,count\n1,1\n",
    },
    {
      name: "traffic-control-smoke.html",
      type: "text/html",
      text: "<!doctype html><title>Evidence draft</title><p>Native export check</p>",
    },
    {
      name: "traffic-control-smoke.png",
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    },
  ]) {
    const downloaded = new Promise((resolveDownload, rejectDownload) => {
      const timeout = setTimeout(
        () => rejectDownload(new Error(`Export timed out: ${fixture.name}`)),
        10000,
      );
      window.webContents.session.once("will-download", (_event, item) => {
        item.once("done", (_doneEvent, state) => {
          clearTimeout(timeout);
          state === "completed"
            ? resolveDownload()
            : rejectDownload(
                new Error(`Export failed: ${fixture.name} (${state})`),
              );
        });
      });
    });
    await window.webContents.executeJavaScript(`(() => {
      const fixture = ${JSON.stringify(fixture)};
      const url = fixture.data || URL.createObjectURL(new Blob([fixture.text], {type:fixture.type}));
      const link = document.createElement('a');
      link.href = url;
      link.download = fixture.name;
      document.body.append(link);
      link.click();
      link.remove();
      if (!fixture.data) setTimeout(() => URL.revokeObjectURL(url), 1000);
    })()`);
    await downloaded;
    const saved = await readFile(join(exportDirectory, fixture.name));
    const expected = fixture.data
      ? Buffer.from(fixture.data.split(",")[1], "base64")
      : Buffer.from(fixture.text);
    if (!saved.equals(expected))
      throw new Error(`Export content changed: ${fixture.name}`);
    exportResults.push({
      name: fixture.name,
      bytes: saved.length,
      verified: true,
    });
  }
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    const images = [...document.querySelectorAll('.traffic-camera-card img')];
    for (const image of images) image.loading = 'eager';
    const timeout = setTimeout(resolve, 25000);
    Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise(done => {
      image.addEventListener('load', done, {once:true});
      image.addEventListener('error', done, {once:true});
    }))).then(() => {clearTimeout(timeout);resolve();});
  })`);
  const isolatedRenderer = await window.webContents.executeJavaScript(
    "({title:document.title,body:document.body.innerText.slice(0,6000),nodeExposed:typeof process!=='undefined'||typeof require!=='undefined',location:location.origin,cameraCards:document.querySelectorAll('.traffic-camera-card').length,loadedSnapshots:[...document.querySelectorAll('.traffic-camera-card img')].filter(image=>image.complete&&image.naturalWidth>0).length})",
  );
  await writeFile(
    join(smokeDirectory, "desktop.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  const report = {
    checkedAt: new Date().toISOString(),
    packaged: app.isPackaged,
    executable: process.execPath,
    versions: process.versions,
    origin,
    health,
    before,
    cases,
    publicCameras,
    hostRejected: invalidHost === 403,
    originRejected: invalidOrigin === 403,
    renderer: isolatedRenderer,
    native: nativeResult,
    exports: exportResults,
    backendPid: backend.pid,
  };
  await writeFile(
    join(smokeDirectory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (
    !report.hostRejected ||
    !report.originRejected ||
    isolatedRenderer.nodeExposed ||
    !isolatedRenderer.title.includes("Traffic Control") ||
    isolatedRenderer.cameraCards !== 9 ||
    nativeResult.decodedFrames.length !== 5
  )
    throw new Error("Desktop self-test checks failed.");
  await stopBackend();
  report.backendClosed = backendClosed;
  await writeFile(
    join(smokeDirectory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  quitAllowed = true;
  app.quit();
}

async function boot() {
  if (booting || quitting) return;
  booting = true;
  try {
    status({
      title: "Preparing video analysis",
      detail: "Checking the local video engine…",
    });
    const ffmpegPath = await ensureVideoEngine(
      join(app.getPath("userData"), "runtime"),
      {
        signal: controller.signal,
        onProgress: ({ phase, received, total }) =>
          status({
            title:
              phase === "verified"
                ? "Video engine verified"
                : "Downloading the video engine",
            detail:
              phase === "verified"
                ? "Starting your local workspace…"
                : `${(received / 1000000).toFixed(1)} / ${(total / 1000000).toFixed(1)} MB · first launch only`,
            percent: (received / total) * 100,
          }),
      },
    );
    if (quitting) return;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_OPTIONS;
    backendClosed = false;
    backend = fork(join(directory, "backend.mjs"), [], {
      execPath: process.execPath,
      env,
      execArgv: [],
      serialization: "advanced",
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    backend.stderr.on("data", (bytes) => {
      if (smokeDirectory)
        backendDiagnostic = (backendDiagnostic + bytes.toString()).slice(
          -16000,
        );
    });
    backendStopped = new Promise((resolveStopped) =>
      backend.once("close", () => {
        backendClosed = true;
        resolveStopped();
      }),
    );
    backendReady = new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () =>
          rejectReady(
            new Error("The local analysis service took too long to start."),
          ),
        30000,
      );
      backend.on("message", (message) => {
        if (
          message?.type === "ready" &&
          /^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)
        ) {
          clearTimeout(timeout);
          resolveReady(message.origin);
        }
        if (message?.type === "error") {
          clearTimeout(timeout);
          rejectReady(new Error(message.message));
        }
        if (message?.type === "self-test-result") selfTestResult?.(message);
        if (message?.type === "shutdown-error")
          status({
            title: "Storage needs attention",
            detail:
              "The analysis service could not confirm a clean shutdown. Restart the app to recover saved evidence.",
            error: true,
          });
      });
      backend.once("error", () => {
        clearTimeout(timeout);
        rejectReady(new Error("The local analysis service could not launch."));
      });
      backend.once("close", () => {
        clearTimeout(timeout);
        rejectReady(new Error("The local analysis service stopped."));
      });
    });
    backend.send({
      type: "start",
      dataDirectory: join(app.getPath("userData"), "evidence"),
      ffmpegPath,
    });
    origin = await backendReady;
    backend.once("close", () => {
      if (quitting || quitAllowed || smokeDirectory) return;
      origin = null;
      void window.loadFile(join(directory, "setup.html")).then(() =>
        status({
          title: "Analysis service stopped",
          detail:
            "Your saved evidence is retained. Restart the workspace to reconnect.",
          error: true,
        }),
      );
    });
    await window.loadURL(`${origin}/#live-traffic`);
    if (smokeDirectory) await runSmoke(ffmpegPath);
  } catch (error) {
    if (quitting) return;
    await stopBackend();
    status({
      title: "Setup needs attention",
      detail:
        error.message ||
        "The workspace could not start. Check your network and available storage.",
      error: true,
    });
    if (smokeDirectory) {
      await writeFile(
        join(smokeDirectory, "failure.json"),
        JSON.stringify(
          { message: error.message, stack: error.stack, backendDiagnostic },
          null,
          2,
        ),
      );
      quitAllowed = true;
      app.exit(1);
    }
  } finally {
    booting = false;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on("before-quit", (event) => {
    if (quitAllowed) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    controller.abort();
    void stopBackend().finally(() => {
      quitAllowed = true;
      app.quit();
    });
  });
  app.on("window-all-closed", () => app.quit());
  void app
    .whenReady()
    .then(async () => {
      await mkdir(app.getPath("userData"), { recursive: true });
      app.setAppUserModelId("com.trafficcontrol.desktop");
      Menu.setApplicationMenu(null);
      window = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1040,
        minHeight: 720,
        show: !smokeDirectory,
        title: "Traffic Control",
        backgroundColor: "#0b1019",
        icon: join(directory, "icon.ico"),
        webPreferences: {
          preload: join(directory, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      const session = window.webContents.session;
      session.setPermissionCheckHandler(
        (_contents, permission, requestingOrigin, details) =>
          permission === "media" &&
          trusted(requestingOrigin) &&
          details.mediaType === "video",
      );
      session.setPermissionRequestHandler(
        (contents, permission, callback, details) =>
          callback(
            contents === window.webContents &&
              permission === "media" &&
              trusted(contents.getURL()) &&
              Array.isArray(details.mediaTypes) &&
              details.mediaTypes.length > 0 &&
              details.mediaTypes.every((type) => type === "video"),
          ),
      );
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (trusted(window.webContents.getURL()) && externalSources.has(url))
          void shell.openExternal(url).catch(() => {});
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (!trusted(url) && url !== setupUrl) event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      session.on("will-download", (event, item, contents) => {
        const url = item.getURL();
        if (
          contents !== window.webContents ||
          !trusted(contents.getURL()) ||
          !allowedDownload(url, origin)
        )
          return event.preventDefault();
        if (smokeDirectory) {
          item.setSavePath(
            join(smokeDirectory, "exports", basename(item.getFilename())),
          );
          return;
        }
        item.setSaveDialogOptions({
          title: "Export Traffic Control evidence",
          defaultPath: join(
            app.getPath("downloads"),
            basename(item.getFilename()),
          ),
        });
      });
      ipcMain.handle("setup-retry", (event) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame.url !== setupUrl
        )
          return;
        return boot();
      });
      await window.loadFile(join(directory, "setup.html"));
      await boot();
    })
    .catch(async (error) => {
      if (smokeDirectory)
        await writeFile(
          join(smokeDirectory, "failure.json"),
          JSON.stringify(
            { message: error.message, stack: error.stack },
            null,
            2,
          ),
        );
      quitAllowed = true;
      app.exit(1);
    });
}
