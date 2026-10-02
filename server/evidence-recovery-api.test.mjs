import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { request as httpRequest } from "node:http";
import sharp from "sharp";
import { createApiServer } from "./index.mjs";
import { createEvidenceOutbox } from "./evidence-outbox.mjs";
import { createStore } from "./store.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const { calculateSpeedMeasurement } = await loadVisionShared();
const sessionId = "10000000-0000-4000-8000-000000000001";
const jpeg = await sharp({
  create: { width: 200, height: 232, channels: 3, background: "#243039" },
})
  .jpeg()
  .toBuffer();
function payload(trackId = 1) {
  const calibration = {
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    widthMeters: 20,
    lengthMeters: 100,
  };
  const samples = [0, 1, 2, 3].map((i) => ({
    timeSeconds: 10 + i * 0.25,
    imagePoint: { x: 0.5, y: 0.2 + i * 0.05 },
  }));
  const speedMeasurement = calculateSpeedMeasurement(samples, calibration);
  return {
    clientEventId: `${sessionId}:${trackId}`,
    trackId,
    sourceName: "SYNTHETIC RECOVERY TEST",
    sourceKind: "camera",
    className: "car",
    speedKmh: speedMeasurement.speedKmh,
    speedLimit: 50,
    confidence: 0.95,
    captureTime: "2026-10-02T12:00:00.000Z",
    sourceTimestamp: 10.75,
    calibration,
    speedMeasurement,
    vehicleBox: [70, 30, 50, 40],
    evidence: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
  };
}
function request(port, path, method = "GET", body) {
  return new Promise((done, reject) => {
    const bytes = body === undefined ? null : JSON.stringify(body);
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
          done({
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
async function listen(server, port = 0) {
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return server.address().port;
}
async function close(server) {
  await new Promise((done) => server.close(done));
  await server.monitorClosed;
}
function temporary() {
  return mkdtempSync(join(tmpdir(), "velocity-evidence-api-"));
}
function remove(directory) {
  const absolute = resolve(directory),
    base = resolve(tmpdir()) + sep;
  assert.ok(
    absolute.startsWith(base) && absolute.includes("velocity-evidence-api-"),
  );
  rmSync(absolute, { recursive: true, force: true });
}
test("HTTP startup replays a committed capture only after binding and never resumes its camera", async () => {
  const directory = temporary();
  let server;
  try {
    const source = payload();
    const outbox = createEvidenceOutbox(directory);
    const staged = outbox.enqueue(sessionId, source);
    outbox.close();
    server = createApiServer({ dataDirectory: directory });
    const before = createStore(directory);
    assert.equal(before.list().total, 0);
    before.close();
    const port = await listen(server);
    const status = await request(port, "/api/monitor");
    assert.equal(status.status, 200);
    assert.equal(status.body.monitor.state, "idle");
    assert.equal(status.body.monitor.sessionId, null);
    assert.equal(status.body.monitor.config.calibration, null);
    assert.equal(status.body.monitor.evidenceRecovery.pending, 0);
    assert.equal(status.body.monitor.evidenceRecovery.recovered, 1);
    const cases = (await request(port, "/api/cases")).body.cases;
    assert.equal(cases.length, 1);
    assert.equal(cases[0].clientEventId, source.clientEventId);
    assert.equal(cases[0].captureTime, source.captureTime);
    assert.equal(cases[0].sourceTimestamp, source.sourceTimestamp);
    assert.deepEqual(cases[0].speedMeasurement, staged.record.speedMeasurement);
    assert.deepEqual(cases[0].calibration, source.calibration);
    const stored = createStore(directory);
    assert.deepEqual(stored.evidence(cases[0].id), jpeg);
    assert.equal(stored.audit().length, 1);
    stored.close();
    assert.equal(
      (await request(port, "/api/monitor/history")).body.sessions.length,
      0,
    );
    await close(server);
    server = createApiServer({ dataDirectory: directory });
    const restarted = await listen(server);
    assert.equal(
      (await request(restarted, "/api/monitor")).body.monitor.evidenceRecovery
        .recovered,
      0,
    );
    assert.equal((await request(restarted, "/api/cases")).body.cases.length, 1);
  } finally {
    if (server) await close(server);
    remove(directory);
  }
});
test("create-before-ack recovery preserves reviewed cases and refuses to discard a damaged image's queued original", async () => {
  const directory = temporary();
  let server;
  try {
    const outbox = createEvidenceOutbox(directory);
    const queued = outbox.enqueue(sessionId, payload());
    outbox.close();
    const store = createStore(directory);
    const saved = store.create(queued).case;
    store.review(saved.id, {
      state: "approved",
      plate: "TEST123",
      reviewer: "Fixture reviewer",
      notes: "Synthetic case only",
    });
    store.close();
    const imagePath = join(directory, "evidence", `${saved.id}.jpg`);
    writeFileSync(imagePath, Buffer.from("damaged test fixture"));
    server = createApiServer({ dataDirectory: directory });
    const port = await listen(server);
    const failed = (await request(port, "/api/monitor")).body.monitor
      .evidenceRecovery;
    assert.equal(failed.pending, 1);
    assert.equal(failed.recovered, 0);
    assert.ok(failed.error);
    const blocked = await request(port, "/api/monitor/start", "POST", {
      camera: {
        type: "nest",
        url: "https://video.nest.com/live/testFixture",
        name: "Test",
      },
      speedLimitKmh: 50,
    });
    assert.ok([409, 503].includes(blocked.status));
    assert.equal(
      (await request(port, "/api/monitor/recovery/retry", "POST", {})).status,
      503,
    );
    assert.equal(
      (
        await request(port, "/api/monitor/recovery/retry", "POST", {
          unexpected: true,
        })
      ).status,
      400,
    );
    const retained = createEvidenceOutbox(directory);
    assert.deepEqual(retained.peek().value.evidence, jpeg);
    assert.equal(retained.summary().pending, 1);
    retained.close();
    writeFileSync(imagePath, jpeg);
    const retried = await request(
      port,
      "/api/monitor/recovery/retry",
      "POST",
      {},
    );
    assert.equal(retried.status, 200);
    assert.equal(retried.body.monitor.evidenceRecovery.pending, 0);
    assert.equal(retried.body.monitor.evidenceRecovery.recovered, 1);
    const cases = (await request(port, "/api/cases")).body.cases;
    assert.equal(cases.length, 1);
    assert.equal(cases[0].id, saved.id);
    assert.equal(cases[0].state, "approved");
    assert.equal(cases[0].plate, "TEST123");
    const audit = (await request(port, `/api/audit?caseId=${saved.id}`)).body
      .events;
    assert.equal(audit.length, 2);
    assert.equal(audit.filter((event) => event.action === "created").length, 1);
  } finally {
    if (server) await close(server);
    remove(directory);
  }
});
test("a service that fails to bind cannot replay or acknowledge another service's queued captures", async () => {
  const directory = temporary();
  let server, contender;
  try {
    server = createApiServer({ dataDirectory: directory });
    const port = await listen(server);
    await request(port, "/api/monitor");
    const outbox = createEvidenceOutbox(directory);
    outbox.enqueue(sessionId, payload());
    outbox.close();
    contender = createApiServer({ dataDirectory: directory });
    const error = await new Promise((done) => {
      contender.once("error", done);
      contender.listen(port, "127.0.0.1");
    });
    assert.equal(error.code, "EADDRINUSE");
    await close(contender);
    contender = null;
    const retained = createEvidenceOutbox(directory);
    assert.equal(retained.summary().pending, 1);
    retained.close();
    const stored = createStore(directory);
    assert.equal(stored.list().total, 0);
    stored.close();
  } finally {
    if (contender) await close(contender);
    if (server) await close(server);
    remove(directory);
  }
});
