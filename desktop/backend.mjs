import { createApiServer } from "../server/index.mjs";
import { resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
let server,
  closing = null;
const send = (message) => {
  if (process.connected) process.send(message);
};

async function stop() {
  if (closing) return closing;
  closing = (async () => {
    if (server) {
      const closed = new Promise((done) => server.close(done));
      server.closeAllConnections();
      await closed;
      await server.monitorClosed;
    }
  })();
  try {
    await closing;
    send({ type: "closed" });
    process.exitCode = 0;
  } catch {
    send({ type: "shutdown-error" });
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}

async function selfTest(ffmpegPath, directory) {
  const { createMonitorEngine } = await import("../server/monitor-engine.mjs");
  const { createPlateEngine } = await import("../server/plate-engine.mjs");
  const { createFrameSource } = await import("../server/frame-source.mjs");
  const fixture = join(directory, "desktop-self-test.mp4");
  let engine, plates, capture;
  const frames = [];
  try {
    await promisify(execFile)(
      ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=160x96:r=10:d=0.5",
        "-an",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        fixture,
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    capture = await createFrameSource(fixture, {
      ffmpegPath,
      localFile: true,
      onFrame: (frame) => {
        frames.push({
          index: frame.index,
          mediaSeconds: frame.mediaSeconds,
          width: frame.width,
          height: frame.height,
        });
      },
    });
    await capture.completion;
    engine = await createMonitorEngine();
    const detection = await engine.processFrame({
      rgb: new Uint8Array(160 * 96 * 3),
      width: 160,
      height: 96,
      mediaSeconds: 1,
    });
    plates = await createPlateEngine();
    const plate = await plates.read({
      rgb: new Uint8Array(160 * 96 * 3),
      width: 160,
      height: 96,
    });
    return {
      node: process.versions.node,
      electron: process.versions.electron,
      sqlite: process.versions.sqlite,
      engine: engine.info,
      decodedFrames: frames,
      detectionCount: detection.detections.length,
      plateState: plate.state,
      fixture: "synthetic black video; no camera capture or accuracy claim",
    };
  } finally {
    await Promise.allSettled([
      capture?.stop(),
      engine?.close(),
      plates?.close(),
    ]);
    await rm(fixture, { force: true });
  }
}

process.on("message", async (message) => {
  if (message?.type === "close") return void stop();
  if (message?.type === "start" && !server && !closing) {
    try {
      if (!isAbsolute(message.dataDirectory) || !isAbsolute(message.ffmpegPath))
        throw new Error();
      const hosts = new Set(),
        origins = new Set();
      server = createApiServer({
        dataDirectory: resolve(message.dataDirectory),
        staticDirectory: join(root, "dist"),
        ffmpegPath: message.ffmpegPath,
        allowedHosts: hosts,
        allowedOrigins: origins,
      });
      server.on("error", () => {
        send({
          type: "error",
          message: "The local analysis service could not start.",
        });
        void stop();
      });
      server.listen(0, "127.0.0.1", () => {
        const host = `127.0.0.1:${server.address().port}`;
        hosts.add(host);
        origins.add(`http://${host}`);
        send({ type: "ready", origin: `http://${host}` });
      });
    } catch {
      send({
        type: "error",
        message:
          "The local analysis service could not open its storage or native components.",
      });
      void stop();
    }
  }
  if (message?.type === "self-test" && server && !closing) {
    try {
      send({
        type: "self-test-result",
        result: await selfTest(message.ffmpegPath, message.directory),
      });
    } catch (error) {
      send({ type: "self-test-result", error: error.message });
    }
  }
});
process.on("disconnect", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
