import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { createApiServer } from "./index.mjs";
import { createMonitorJournal } from "./monitor-journal.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const shared = await loadVisionShared();
const camera = {
  type: "nest",
  url: "https://video.nest.com/live/testFixture",
  name: "History fixture",
};
const line = { a: { x: 0.1, y: 0.5 }, b: { x: 0.9, y: 0.5 } };
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve) => server.close(resolve));
  await server.monitorClosed;
}
async function request(port, path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const bytes = body ? JSON.stringify(body) : null;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Host: "127.0.0.1:5174",
          ...(bytes
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bytes),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
test("HTTP monitoring history keeps counted crossings and revisions after a real service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-monitor-api-"));
  let consume, resolveSourceEnd;
  const server = createApiServer({
    dataDirectory: directory,
    monitorOptions: {
      plateReadingEnabled: false,
      shared: {
        ...shared,
        createCameraReference: () => Object.freeze({ fixture: true }),
        assessCameraStability: () => ({
          state: "stable",
          reason: "Deterministic history fixture",
          matched: 20,
          displacementPixels: 0,
        }),
      },
      resolveSource: async () => ({ url: "https://fixture.invalid/private" }),
      createEngine: async () => ({
        info: { provider: "fixture" },
        processFrame: async ({ rgb }) => ({
          detections: rgb[0]
            ? [
                {
                  bbox: [70, rgb[0] - 30, 40, 30],
                  className: "car",
                  score: 0.95,
                },
              ]
            : [],
        }),
        resetContext() {},
        close: async () => {},
      }),
      createSource: async (_, options) => {
        consume = options.onFrame;
        return {
          completion: new Promise((resolve) => {
            resolveSourceEnd = resolve;
          }),
          stop: async () => resolveSourceEnd(),
        };
      },
    },
  });
  let activeServer = server;
  try {
    let port = await listen(server);
    const started = await request(port, "/api/monitor/start", "POST", {
      camera,
      speedLimitKmh: 50,
    });
    assert.equal(started.status, 202);
    const id = started.body.monitor.sessionId;
    for (let i = 0; !consume && i < 100; i++) await turn();
    assert.equal(typeof consume, "function");
    let index = 0;
    const emit = async (y) => {
      const sequence = index++;
      await consume({
        rgb: Buffer.alloc(200 * 200 * 3, y),
        width: 200,
        height: 200,
        index: sequence,
        mediaSeconds: sequence / 10,
        receivedAt: Date.now(),
      });
    };
    await emit(0);
    let monitor = (await request(port, "/api/monitor")).body.monitor;
    const frame = (await request(port, `/api/monitor/frame?sessionId=${id}`))
      .body.frame;
    const configured = await request(port, "/api/monitor/config", "PATCH", {
      sessionId: id,
      expectedRevision: monitor.config.revision,
      countingLine: line,
      referenceFrame: { frameId: frame.frameId, width: 200, height: 200 },
    });
    assert.equal(configured.status, 200);
    for (const y of [70, 80, 90, 110, 120, 130, 140, 150]) await emit(y);
    monitor = (await request(port, "/api/monitor")).body.monitor;
    assert.equal(monitor.stats.crossings.total, 1);
    const liveSaved = (await request(port, "/api/monitor/history")).body;
    assert.equal(liveSaved.sessions[0].stats.crossings.total, 1);
    assert.equal(liveSaved.total, 1);
    assert.equal(liveSaved.sessions[0].config.calibration, null);
    assert.equal(liveSaved.sessions[0].stats.casesCreated, 0);
    const contender = createApiServer({ dataDirectory: directory });
    const bindError = await new Promise((resolve) => {
      contender.once("error", resolve);
      contender.listen(port, "127.0.0.1");
    });
    assert.equal(bindError.code, "EADDRINUSE");
    await new Promise((resolve) => contender.close(resolve));
    await contender.monitorClosed;
    const afterFailedBind = (await request(port, `/api/monitor/history/${id}`))
      .body.session;
    assert.equal(afterFailedBind.interrupted, false);
    assert.equal(afterFailedBind.endedAt, null);
    const updated = await request(port, "/api/monitor/config", "PATCH", {
      sessionId: id,
      expectedRevision: monitor.config.revision,
      speedLimitKmh: 65,
    });
    assert.equal(updated.status, 200);
    await close(server);
    activeServer = null;
    const restarted = createApiServer({ dataDirectory: directory });
    activeServer = restarted;
    port = await listen(restarted);
    assert.equal(
      (await request(port, "/api/monitor")).body.monitor.state,
      "idle",
    );
    const saved = await request(port, `/api/monitor/history/${id}`);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.session.state, "stopped");
    assert.equal(saved.body.session.interrupted, false);
    assert.equal(saved.body.session.stats.crossings.total, 1);
    assert.equal(saved.body.session.config.speedLimitKmh, 65);
    assert.equal(saved.body.revisions.length, 4);
    assert.equal(saved.body.revisions[2].config.speedLimitKmh, 50);
    assert.equal(saved.body.revisions[2].stats.crossings.total, 1);
    assert.equal(saved.body.revisions[3].stats.crossings.total, 1);
    assert.doesNotMatch(
      JSON.stringify(saved.body),
      /fixture\.invalid|video\.nest\.com|"jpeg"|"tracks"/,
    );
    for (const query of [
      "?limit=101",
      "?limit=0",
      "?before=-1",
      "?before=9007199254740992",
    ])
      assert.equal(
        (await request(port, `/api/monitor/history${query}`)).status,
        400,
      );
    assert.equal(
      (
        await request(
          port,
          "/api/monitor/history/00000000-0000-4000-8000-000000000001",
        )
      ).status,
      404,
    );
  } finally {
    if (activeServer) await close(activeServer);
    rmSync(directory, { recursive: true, force: true });
  }
});
test("owning the server port recovers unclosed sessions without silently resuming the camera", async () => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-monitor-recovery-"));
  const journal = createMonitorJournal(directory);
  const time = new Date().toISOString();
  const id = "00000000-0000-4000-8000-000000000001";
  journal.checkpoint(
    {
      sessionId: id,
      state: "running",
      sourceName: "Unclosed fixture",
      sourceType: "nest",
      startedAt: time,
      lastFrameAt: time,
      engine: null,
      config: {
        revision: 1,
        speedLimitKmh: 50,
        calibration: null,
        countingLine: line,
        referenceFrame: { width: 200, height: 200 },
      },
      stats: {
        observed: 3,
        active: 1,
        framesProcessed: 40,
        framesDropped: 2,
        analysisFps: 10,
        crossings: {
          total: 2,
          forward: 1,
          reverse: 1,
          classes: { car: 2, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
        },
        casesCreated: 0,
        pendingCases: 0,
        elapsedSeconds: 4,
        gapCount: 0,
      },
    },
    { reason: "crossing" },
  );
  journal.close();
  const server = createApiServer({ dataDirectory: directory });
  try {
    const untouched = createMonitorJournal(directory);
    assert.equal(untouched.get(id).session.state, "running");
    untouched.close();
    const port = await listen(server);
    const result = (await request(port, `/api/monitor/history/${id}`)).body;
    assert.equal(result.session.interrupted, true);
    assert.equal(result.session.stats.crossings.total, 2);
    assert.equal(result.session.stats.active, 0);
    assert.equal(result.session.stats.analysisFps, 0);
    assert.equal(result.session.lastFrameAt, time);
    assert.equal(
      (await request(port, "/api/monitor")).body.monitor.state,
      "idle",
    );
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
