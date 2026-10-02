import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createMonitor } from "./monitor.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
import { createMonitorJournal } from "./monitor-journal.mjs";
import { HttpError, validateCase } from "./validation.mjs";
import { createEvidenceOutbox } from "./evidence-outbox.mjs";
import { createStore } from "./store.mjs";
const shared = await loadVisionShared();
const camera = {
  type: "nest",
  url: "https://video.nest.com/live/testFixture",
  name: "Fixture camera",
};
const calibration = () => ({
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  widthMeters: 20,
  lengthMeters: 100,
});
const line = { a: { x: 0.1, y: 0.5 }, b: { x: 0.9, y: 0.5 } };
const detection = (contactY = 70, className = "car") => ({
  bbox: [70, contactY - 30, 40, 30],
  className,
  score: 0.91,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await turn();
  }
  throw new Error("Monitor did not reach the expected state.");
}
function harness(t, options = {}) {
  let clock = Date.parse("2026-10-02T18:00:00.000Z"),
    monotonicClock = 1000,
    index = 0;
  const saved = [],
    attempts = [],
    sources = [],
    engineCalls = [],
    detections = new Map();
  let diskFailure = false,
    resets = 0,
    releases = 0;
  const engine = {
    info: { provider: "fixture", initializationWarnings: [] },
    async processFrame(frame) {
      engineCalls.push(frame);
      const value = options.infer
        ? await options.infer(frame)
        : detections.get(frame.rgb[0]);
      return { detections: value ?? [] };
    },
    resetContext() {
      resets++;
    },
    async close() {
      releases++;
      if (options.engineCloseGate) await options.engineCloseGate.promise;
      if (options.engineCloseFailure)
        throw new Error("private detector cleanup credentials");
    },
  };
  const monitor = createMonitor({
    plateReadingEnabled: false,
    shared: {
      ...shared,
      createCameraReference: () => Object.freeze({ fixture: true }),
      assessCameraStability: () => ({
        state: "stable",
        reason: "Deterministic lifecycle fixture",
        matched: 20,
        displacementPixels: 0,
      }),
    },
    journal: options.journal,
    outbox: options.outbox,
    now: () => clock,
    monotonic: () => monotonicClock,
    store: options.store ?? {
      create(item) {
        options.onStoreCreate?.(item);
        attempts.push(item);
        if (diskFailure) throw new Error("disk full");
        const duplicate = saved.some(
          (s) => s.record.clientEventId === item.record.clientEventId,
        );
        if (!duplicate) saved.push(structuredClone(item));
        return { duplicate };
      },
    },
    resolveSource: async () => ({
      url: "https://fixture.invalid/stream",
      name: camera.name,
      type: "nest",
    }),
    createEngine: async () => {
      if (options.engineGate) await options.engineGate.promise;
      return engine;
    },
    createSource: async (_, config) => {
      const completion = deferred();
      completion.promise.catch(() => {});
      let stopping;
      const jobs = new Set();
      const source = {
        completion: completion.promise,
        stops: 0,
        fail() {
          completion.reject(new Error("private decoder failure"));
        },
        emit(frame) {
          const work = Promise.resolve().then(() => config.onFrame(frame));
          jobs.add(work);
          work.then(
            () => jobs.delete(work),
            (error) => {
              jobs.delete(work);
              completion.reject(error);
            },
          );
          return work;
        },
        stop() {
          if (!stopping) {
            source.stops++;
            if (options.sourceStopFailure === "sync")
              throw new Error("private decoder cleanup credentials");
            if (options.sourceStopFailure === "async") {
              stopping = Promise.reject(
                new Error("private decoder cleanup credentials"),
              );
              return stopping;
            }
            completion.resolve();
            stopping = Promise.allSettled([...jobs]).then(() => {});
          }
          return stopping;
        },
      };
      sources.push(source);
      return source;
    },
  });
  t.after(() => monitor.close());
  return {
    monitor,
    saved,
    attempts,
    sources,
    engineCalls,
    get resets() {
      return resets;
    },
    get releases() {
      return releases;
    },
    setDiskFailure(value) {
      diskFailure = value;
    },
    advance(ms) {
      clock += ms;
      monotonicClock += ms;
    },
    jumpWall(ms) {
      clock += ms;
    },
    async start(waitForSource = true) {
      const status = await monitor.start({
        camera,
        speedLimitKmh: options.limit ?? 20,
      });
      if (waitForSource) await until(() => sources.length > 0);
      return status;
    },
    async emit(
      mediaSeconds,
      values = [detection()],
      { width = 200, height = 200, advanceMs = 100 } = {},
    ) {
      clock += advanceMs;
      monotonicClock += advanceMs;
      const marker = index++;
      detections.set(marker, values);
      return sources.at(-1).emit({
        rgb: Buffer.alloc(width * height * 3, marker),
        width,
        height,
        index: marker,
        mediaSeconds,
        receivedAt: clock,
        receivedMonotonic: monotonicClock,
      });
    },
    preview() {
      return monitor.frame({ sessionId: monitor.status().sessionId });
    },
    configure(values) {
      const status = monitor.status(),
        frame = monitor.frame({ sessionId: status.sessionId });
      return monitor.configure({
        sessionId: status.sessionId,
        expectedRevision: status.config.revision,
        ...(Object.hasOwn(values, "calibration") ||
        Object.hasOwn(values, "countingLine")
          ? {
              referenceFrame: {
                frameId: frame.frameId,
                width: frame.width,
                height: frame.height,
              },
            }
          : {}),
        ...values,
      });
    },
  };
}
function memoryOutbox() {
  const rows = new Map(),
    events = [],
    payloads = [];
  return {
    rows,
    events,
    payloads,
    failEnqueue: false,
    failAck: false,
    failPeek: false,
    enqueue(sessionId, payload) {
      events.push("enqueue");
      payloads.push(structuredClone(payload));
      if (this.failEnqueue) throw new Error("private outbox enqueue failure");
      const value = validateCase(payload),
        eventId = value.record.clientEventId;
      const existing = rows.get(eventId);
      if (existing) assert.equal(existing.value.fingerprint, value.fingerprint);
      else rows.set(eventId, { sessionId, eventId, value });
      return value;
    },
    peek() {
      if (this.failPeek) throw new Error("private outbox read failure");
      return rows.values().next().value ?? null;
    },
    acknowledge(eventId, fingerprint) {
      events.push("ack");
      if (this.failAck)
        throw new Error("private outbox acknowledgement failure");
      const existing = rows.get(eventId);
      if (existing) assert.equal(existing.value.fingerprint, fingerprint);
      rows.delete(eventId);
    },
    summary() {
      return {
        pending: rows.size,
        bytes: [...rows.values()].reduce(
          (sum, row) => sum + row.value.evidence.length,
          0,
        ),
      };
    },
    close() {},
  };
}
const recoverySession = "7e7a3a73-6973-4f14-b4f3-86d9f1a8b1df";
function recoveryPayload() {
  return {
    clientEventId: `${recoverySession}:7`,
    trackId: 7,
    sourceName: "Previous frozen camera",
    sourceKind: "camera",
    className: "car",
    speedKmh: 72,
    speedLimit: 50,
    confidence: 0.9,
    captureTime: "2026-10-02T18:00:00.000Z",
    sourceTimestamp: 0.75,
    calibration: calibration(),
    speedMeasurement: {
      method: "ground-plane-median-v2",
      samples: [0, 1, 2, 3].map((i) => ({
        timeSeconds: i * 0.25,
        imagePoint: { x: 0.5, y: 0.2 + i * 0.05 },
      })),
      velocityMps: { x: 0, y: 20 },
      speedKmh: 72,
      pairCount: 6,
    },
    evidence: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString("base64")}`,
  };
}
async function triggerCapture(h) {
  await h.emit(0, []);
  h.configure({ calibration: calibration() });
  for (let i = 1; i <= 12; i++) {
    try {
      await h.emit(i / 10, [detection(40 + i * 2)]);
    } catch {
      return;
    }
    if (h.saved.length) return;
  }
}
test("monitor commits frozen evidence to the outbox before case creation and acknowledges last", async (t) => {
  const outbox = memoryOutbox();
  const h = harness(t, {
    outbox,
    onStoreCreate: () => outbox.events.push("create"),
  });
  await assert.rejects(h.start(false), (error) => error.status === 409);
  await h.monitor.recoverEvidence();
  await h.start();
  await triggerCapture(h);
  assert.deepEqual(outbox.events, ["enqueue", "create", "ack"]);
  assert.equal(h.saved.length, 1);
  assert.equal(h.monitor.status().stats.casesCreated, 1);
  assert.equal(h.monitor.status().stats.pendingCases, 0);
  assert.equal(h.monitor.status().evidenceRecovery.pending, 0);
  assert.equal(outbox.payloads[0].speedLimit, 20);
  assert.equal(outbox.payloads[0].calibration.lengthMeters, 100);
  assert.equal(
    outbox.payloads[0].evidence,
    `data:image/jpeg;base64,${Buffer.from(h.saved[0].evidence).toString("base64")}`,
  );
});
test("failed enqueue retains the same frozen payload in memory and never writes an unjournaled case", async (t) => {
  const outbox = memoryOutbox();
  const h = harness(t, { outbox });
  await h.monitor.recoverEvidence();
  await h.start();
  outbox.failEnqueue = true;
  await triggerCapture(h);
  await until(() => h.releases === 1);
  const original = structuredClone(outbox.payloads[0]);
  const state = h.monitor.status();
  assert.equal(h.attempts.length, 0);
  assert.equal(outbox.summary().pending, 0);
  assert.equal(state.stats.pendingCases, 1);
  assert.equal(state.state, "error");
  assert.doesNotMatch(state.error, /private/);
  await assert.rejects(
    h.monitor.start({ camera, speedLimitKmh: 80 }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    h.monitor.retry({ sessionId: state.sessionId }),
    (error) => error.status === 503,
  );
  outbox.failEnqueue = false;
  await h.monitor.retry({ sessionId: state.sessionId });
  assert.ok(
    outbox.payloads.every(
      (payload) => JSON.stringify(payload) === JSON.stringify(original),
    ),
  );
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].record.clientEventId, original.clientEventId);
  assert.equal(h.monitor.status().stats.pendingCases, 0);
});
test("create-success acknowledgement-failure preserves one case count and one pending event through retry", async (t) => {
  const outbox = memoryOutbox();
  const directory = mkdtempSync(join(tmpdir(), "velocity-outbox-history-"));
  const journal = createMonitorJournal(directory);
  const h = harness(t, { outbox, journal });
  t.after(async () => {
    await h.monitor.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.monitor.recoverEvidence();
  await h.start();
  outbox.failAck = true;
  await triggerCapture(h);
  await until(() => h.releases === 1);
  const state = h.monitor.status();
  assert.equal(h.saved.length, 1);
  assert.equal(state.stats.casesCreated, 1);
  assert.equal(state.stats.pendingCases, 1);
  assert.equal(state.evidenceRecovery.pending, 1);
  await assert.rejects(
    h.monitor.retry({ sessionId: state.sessionId }),
    (error) => error.status === 503,
  );
  assert.equal(h.monitor.status().stats.casesCreated, 1);
  assert.equal(h.saved.length, 1);
  outbox.failAck = false;
  await h.monitor.retry({ sessionId: state.sessionId });
  await h.monitor.retry({ sessionId: state.sessionId });
  assert.equal(h.monitor.status().stats.pendingCases, 0);
  assert.equal(h.monitor.status().stats.casesCreated, 1);
  assert.equal(h.monitor.status().evidenceRecovery.pending, 0);
  assert.equal(journal.get(state.sessionId).session.stats.casesCreated, 1);
  assert.equal(journal.get(state.sessionId).session.stats.pendingCases, 0);
});
test("a create that commits then throws is counted once only after duplicate evidence verifies", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-create-unknown-"));
  const store = createStore(directory),
    journal = createMonitorJournal(directory),
    outbox = memoryOutbox();
  let unknownCreateOutcome = true,
    unavailableEvidence = true;
  const h = harness(t, {
    outbox,
    journal,
    store: {
      create(value) {
        const result = store.create(value);
        if (unknownCreateOutcome) {
          unknownCreateOutcome = false;
          throw new Error("private post-commit lookup failure");
        }
        return result;
      },
      evidence(id) {
        if (unavailableEvidence)
          throw new HttpError(500, "The stored evidence file is unavailable.");
        return store.evidence(id);
      },
    },
  });
  t.after(async () => {
    await h.monitor.close();
    store.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.monitor.recoverEvidence();
  await h.start();
  await triggerCapture(h);
  await until(() => h.releases === 1);
  const sessionId = h.monitor.status().sessionId;
  assert.equal(store.list().total, 1);
  assert.equal(h.monitor.status().stats.casesCreated, 0);
  assert.equal(h.monitor.status().stats.pendingCases, 1);
  assert.equal(outbox.summary().pending, 1);
  await assert.rejects(
    h.monitor.retry({ sessionId }),
    (error) => error.status === 503,
  );
  assert.equal(h.monitor.status().stats.casesCreated, 0);
  assert.equal(outbox.summary().pending, 1);
  unavailableEvidence = false;
  await h.monitor.retry({ sessionId });
  await h.monitor.retry({ sessionId });
  assert.equal(store.list().total, 1);
  assert.equal(store.audit().length, 1);
  assert.equal(h.monitor.status().stats.casesCreated, 1);
  assert.equal(h.monitor.status().stats.pendingCases, 0);
  assert.equal(outbox.summary().pending, 0);
  assert.equal(journal.get(sessionId).session.stats.casesCreated, 1);
  assert.equal(journal.get(sessionId).session.stats.pendingCases, 0);
});
test("startup recovery drains frozen evidence without restoring any camera, calibration or historical counts", async (t) => {
  const outbox = memoryOutbox(),
    payload = recoveryPayload();
  const checked = outbox.enqueue(recoverySession, payload);
  payload.speedLimit = 99;
  payload.calibration.lengthMeters = 999;
  const h = harness(t, { outbox });
  assert.equal(h.monitor.status().evidenceRecovery.pending, 1);
  assert.equal(h.sources.length, 0);
  const recovered = await h.monitor.recoverEvidence();
  assert.deepEqual(recovered.evidenceRecovery, {
    pending: 0,
    recovered: 1,
    error: null,
  });
  assert.equal(recovered.state, "idle");
  assert.equal(recovered.sessionId, null);
  assert.equal(recovered.config.calibration, null);
  assert.equal(recovered.stats.casesCreated, 0);
  assert.equal(recovered.stats.pendingCases, 0);
  assert.equal(h.sources.length, 0);
  assert.equal(h.engineCalls.length, 0);
  assert.deepEqual(h.saved[0], structuredClone(checked));
  assert.equal(h.saved[0].record.speedLimit, 50);
  assert.equal(h.saved[0].record.calibration.lengthMeters, 100);
  await h.monitor.recoverEvidence();
  assert.equal(h.monitor.status().evidenceRecovery.recovered, 1);
});
test("recovery keeps failed acknowledgements and counts an already-created case only after acknowledgement", async (t) => {
  const outbox = memoryOutbox();
  outbox.enqueue(recoverySession, recoveryPayload());
  outbox.failAck = true;
  const h = harness(t, { outbox });
  const failed = await h.monitor.recoverEvidence();
  assert.equal(failed.evidenceRecovery.pending, 1);
  assert.equal(failed.evidenceRecovery.recovered, 0);
  assert.match(
    failed.evidenceRecovery.error,
    /Saved evidence could not be recovered/,
  );
  assert.doesNotMatch(failed.evidenceRecovery.error, /private/);
  assert.equal(h.saved.length, 1);
  await assert.rejects(
    h.monitor.retryRecovery(),
    (error) => error.status === 503,
  );
  await assert.rejects(
    h.monitor.start({ camera, speedLimitKmh: 50 }),
    (error) => error.status === 409,
  );
  outbox.failAck = false;
  const done = await h.monitor.retryRecovery({});
  assert.deepEqual(done.evidenceRecovery, {
    pending: 0,
    recovered: 1,
    error: null,
  });
  assert.equal(h.saved.length, 1);
  await assert.rejects(
    h.monitor.retryRecovery({ sessionId: recoverySession }),
    (error) => error.status === 400,
  );
  await h.start();
  await assert.rejects(
    h.monitor.retryRecovery(),
    (error) => error.status === 409,
  );
});
test("an unreadable recovery outbox stays visible and blocks capture until a successful retry", async (t) => {
  const outbox = memoryOutbox();
  outbox.failPeek = true;
  const h = harness(t, { outbox });
  const failed = await h.monitor.recoverEvidence();
  assert.equal(failed.evidenceRecovery.pending, 0);
  assert.ok(failed.evidenceRecovery.error);
  await assert.rejects(h.start(false), (error) => error.status === 409);
  outbox.failPeek = false;
  assert.equal((await h.monitor.retryRecovery()).evidenceRecovery.error, null);
  await h.start();
  assert.equal(h.sources.length, 1);
});
test("recovery and retry explain sanitized integrity failures without exposing unexpected errors", async (t) => {
  const outbox = memoryOutbox();
  outbox.enqueue(recoverySession, recoveryPayload());
  const detail = "The stored evidence failed its integrity check.";
  let failure = new HttpError(500, detail);
  const h = harness(t, {
    outbox,
    store: {
      create() {
        return { case: { id: "fixture" }, duplicate: true };
      },
      evidence() {
        if (failure) throw failure;
        return Buffer.from("verified fixture");
      },
    },
  });
  const status = await h.monitor.recoverEvidence();
  assert.ok(status.evidenceRecovery.error.endsWith(detail));
  assert.equal(status.evidenceRecovery.pending, 1);
  assert.equal(status.evidenceRecovery.recovered, 0);
  await assert.rejects(
    h.monitor.retryRecovery(),
    (error) =>
      error.status === 503 && error.message === status.evidenceRecovery.error,
  );
  failure = new Error("private path or credentials");
  const unexpected = await h.monitor.recoverEvidence();
  assert.doesNotMatch(
    unexpected.evidenceRecovery.error,
    /private|credentials|integrity check\./,
  );
  assert.equal(unexpected.evidenceRecovery.pending, 1);
  failure = null;
  const repaired = await h.monitor.retryRecovery();
  assert.deepEqual(repaired.evidenceRecovery, {
    pending: 0,
    recovered: 1,
    error: null,
  });
});
test("real outbox reopens a failed case write and recovers the identical frozen image and policy", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-outbox-reopen-"));
  let outbox = createEvidenceOutbox(directory),
    store,
    restarted;
  const h = harness(t, { outbox });
  t.after(async () => {
    await restarted?.close();
    outbox.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.monitor.recoverEvidence();
  await h.start();
  h.setDiskFailure(true);
  await triggerCapture(h);
  await until(() => h.releases === 1);
  const original = outbox.peek();
  assert.ok(original);
  assert.equal(h.monitor.status().stats.pendingCases, 1);
  assert.equal(h.saved.length, 0);
  await h.monitor.close();
  outbox.close();
  outbox = createEvidenceOutbox(directory);
  store = createStore(directory);
  let openedCamera = false;
  restarted = createMonitor({
    store,
    outbox,
    shared,
    createEngine: async () => {
      openedCamera = true;
      throw new Error("Must not open camera");
    },
  });
  const status = await restarted.recoverEvidence();
  assert.deepEqual(status.evidenceRecovery, {
    pending: 0,
    recovered: 1,
    error: null,
  });
  assert.equal(status.state, "idle");
  assert.equal(status.config.calibration, null);
  assert.equal(openedCamera, false);
  const saved = store.list().cases[0];
  assert.equal(saved.clientEventId, original.eventId);
  assert.equal(saved.speedLimit, original.value.record.speedLimit);
  assert.deepEqual(saved.calibration, original.value.record.calibration);
  assert.deepEqual(
    saved.speedMeasurement,
    original.value.record.speedMeasurement,
  );
  assert.deepEqual(store.evidence(saved.id), original.value.evidence);
});
test("real recovery acknowledges an already-created case without duplicating it or rewriting old history", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "velocity-outbox-after-create-"),
  );
  const store = createStore(directory),
    journal = createMonitorJournal(directory);
  let outbox = createEvidenceOutbox(directory),
    restarted;
  const blockedAck = {
    ...outbox,
    acknowledge() {
      throw new Error("private acknowledgement failure");
    },
  };
  const h = harness(t, { outbox: blockedAck, store, journal });
  t.after(async () => {
    await restarted?.close();
    outbox.close();
    store.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.monitor.recoverEvidence();
  await h.start();
  await triggerCapture(h);
  await until(() => h.releases === 1);
  const old = h.monitor.status();
  assert.equal(old.stats.casesCreated, 1);
  assert.equal(old.stats.pendingCases, 1);
  assert.equal(store.list().total, 1);
  const savedId = store.list().cases[0].id;
  const history = journal.get(old.sessionId);
  await h.monitor.close();
  outbox.close();
  outbox = createEvidenceOutbox(directory);
  restarted = createMonitor({ store, outbox, journal, shared });
  const status = await restarted.recoverEvidence();
  assert.deepEqual(status.evidenceRecovery, {
    pending: 0,
    recovered: 1,
    error: null,
  });
  assert.equal(store.list().total, 1);
  assert.equal(store.list().cases[0].id, savedId);
  assert.equal(store.audit().length, 1);
  assert.equal(status.stats.casesCreated, 0);
  assert.deepEqual(journal.get(old.sessionId), history);
});
test("uncalibrated monitored movement produces confirmed vehicles and crossings but no cases", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, []);
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit((i + 1) / 10, [detection(y)]);
  const status = h.monitor.status();
  assert.equal(status.state, "running");
  assert.equal(status.stats.observed, 1);
  assert.equal(status.stats.crossings.total, 1);
  assert.equal(status.stats.casesCreated, 0);
  assert.equal(h.saved.length, 0);
  assert.ok(h.preview().tracks.every((track) => track.speedKmh === null));
});
test("session checkpoints preserve every crossing and the old line totals before a reset", async (t) => {
  const checkpoints = [];
  const h = harness(t, {
    journal: {
      checkpoint(status, details) {
        checkpoints.push(structuredClone({ status, details }));
      },
    },
  });
  await h.start();
  assert.equal(checkpoints[0].details.reason, "started");
  await h.emit(0, []);
  h.configure({ countingLine: line });
  const countingRevision = h.monitor.status().config.revision;
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit((i + 1) / 10, [detection(y)]);
  assert.equal(
    checkpoints.find((c) => c.details.reason === "crossing").status.stats
      .crossings.total,
    1,
  );
  await h.emit(1.2, []);
  h.configure({
    countingLine: { a: { x: 0.1, y: 0.65 }, b: { x: 0.9, y: 0.65 } },
  });
  const prior = checkpoints
    .filter((c) => c.status.config.revision === countingRevision)
    .at(-1);
  assert.equal(prior.status.stats.crossings.total, 1);
  assert.equal(checkpoints.at(-1).status.stats.crossings.total, 0);
  await h.monitor.stop({ sessionId: h.monitor.status().sessionId });
  assert.equal(checkpoints.at(-1).status.state, "stopped");
  assert.ok(checkpoints.at(-1).details.endedAt);
  assert.ok(checkpoints.every((c) => !Object.hasOwn(c.status, "camera")));
});
test("history storage failure stops analysis, preserves its count and blocks restart until saved", async (t) => {
  let fail = false;
  const saved = [];
  const h = harness(t, {
    journal: {
      checkpoint(status, details) {
        if (fail) throw new Error("private storage path should not escape");
        saved.push(structuredClone({ status, details }));
      },
    },
  });
  await h.start();
  await h.emit(0, []);
  h.configure({ countingLine: line });
  fail = true;
  let failed = false;
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries()) {
    try {
      await h.emit((i + 1) / 10, [detection(y)]);
    } catch {
      failed = true;
      break;
    }
  }
  assert.equal(failed, true);
  await until(() => h.releases === 1);
  const status = h.monitor.status();
  assert.equal(status.state, "error");
  assert.equal(status.stats.crossings.total, 1);
  assert.equal(status.stats.pendingHistory, true);
  assert.doesNotMatch(status.error, /private storage path/);
  await assert.rejects(
    h.monitor.start({ camera, speedLimitKmh: 20 }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    h.monitor.retry({ sessionId: status.sessionId }),
    (e) => e.status === 503,
  );
  fail = false;
  await h.monitor.retry({ sessionId: status.sessionId });
  assert.equal(h.monitor.status().stats.pendingHistory, false);
  assert.equal(saved.at(-1).status.stats.crossings.total, 1);
  assert.equal(saved.at(-1).details.reason, "retry");
  assert.equal(saved.at(-1).status.state, "error");
});
test("failed configuration checkpoint stops the source without applying the new policy", async (t) => {
  let fail = false;
  const h = harness(t, {
    journal: {
      checkpoint() {
        if (fail) throw new Error("disk full");
      },
    },
  });
  await h.start();
  await h.emit(0, []);
  const prior = h.monitor.status().config;
  fail = true;
  assert.throws(
    () => h.configure({ speedLimitKmh: 80 }),
    (e) => e.status === 503,
  );
  await until(() => h.releases === 1);
  assert.deepEqual(h.monitor.status().config, prior);
  assert.equal(h.monitor.status().state, "error");
  assert.equal(h.monitor.status().stats.pendingHistory, true);
});
test("failed initial history save never starts a camera or detector", async (t) => {
  let fail = true;
  const saved = [];
  const h = harness(t, {
    journal: {
      checkpoint(status) {
        if (fail) throw new Error("disk full");
        saved.push(structuredClone(status));
      },
    },
  });
  await assert.rejects(h.start(), (e) => e.status === 503);
  assert.equal(h.sources.length, 0);
  assert.equal(h.engineCalls.length, 0);
  assert.equal(h.monitor.status().stats.pendingHistory, true);
  fail = false;
  await h.monitor.retry({ sessionId: h.monitor.status().sessionId });
  assert.equal(saved.at(-1).state, "error");
  assert.equal(h.monitor.status().stats.pendingHistory, false);
});
test("a history failure during pending inference retires its result before any count or case", async (t) => {
  const gate = deferred();
  let blocked = false,
    fail = false;
  const h = harness(t, {
    infer: async () => {
      if (blocked) await gate.promise;
      return [detection()];
    },
    journal: {
      checkpoint() {
        if (fail) throw new Error("disk full");
      },
    },
  });
  await h.start();
  await h.emit(0, []);
  const before = h.monitor.status();
  blocked = true;
  const pending = h.emit(0.1, [detection()]);
  await until(() => h.engineCalls.length === 2);
  fail = true;
  assert.throws(
    () => h.configure({ speedLimitKmh: 80 }),
    (e) => e.status === 503,
  );
  await assert.rejects(
    h.monitor.retry({ sessionId: before.sessionId }),
    (e) => e.status === 409,
  );
  gate.resolve();
  await pending;
  await until(() => h.releases === 1);
  assert.equal(
    h.monitor.status().stats.framesProcessed,
    before.stats.framesProcessed,
  );
  assert.equal(h.monitor.status().stats.observed, before.stats.observed);
  assert.equal(h.monitor.status().stats.casesCreated, 0);
  assert.equal(h.monitor.status().state, "error");
});
test("a failure after a count-line reset retains both revisions when the save is retried", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-config-history-"));
  const journal = createMonitorJournal(directory);
  let rejectRevision = null;
  const h = harness(t, {
    journal: {
      checkpoint(status, options) {
        if (status.config.revision === rejectRevision)
          throw new Error("disk full");
        return journal.checkpoint(status, options);
      },
    },
  });
  t.after(async () => {
    await h.monitor.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.start();
  await h.emit(0, []);
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit((i + 1) / 10, [detection(y)]);
  await h.emit(1.2, []);
  const before = h.monitor.status();
  rejectRevision = before.config.revision + 1;
  assert.throws(
    () =>
      h.configure({
        countingLine: { a: { x: 0.1, y: 0.7 }, b: { x: 0.9, y: 0.7 } },
      }),
    (e) => e.status === 503,
  );
  await until(() => h.releases === 1);
  assert.equal(h.monitor.status().stats.crossings.total, 0);
  assert.equal(journal.get(before.sessionId).session.stats.crossings.total, 1);
  assert.equal(h.monitor.status().stats.pendingHistory, true);
  rejectRevision = null;
  await h.monitor.retry({ sessionId: before.sessionId });
  const saved = journal.get(before.sessionId);
  assert.equal(saved.revisions.at(-2).stats.crossings.total, 1);
  assert.equal(saved.revisions.at(-1).stats.crossings.total, 0);
  assert.equal(saved.session.config.countingLine.a.y, 0.7);
  assert.equal(h.monitor.status().stats.pendingHistory, false);
  assert.equal(h.monitor.status().error, null);
});
test("observed counts confirmed vehicles, not tentative ID gaps or pedestrians", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, [detection(70)]);
  await h.emit(0.8, []);
  for (const time of [1, 1.1, 1.2, 1.3])
    await h.emit(time, [
      detection(130),
      { ...detection(50, "person"), bbox: [140, 20, 20, 30] },
    ]);
  assert.equal(h.monitor.status().stats.observed, 1);
  assert.equal(h.monitor.status().stats.active, 1);
});
test("geometry is tied to the exact session, revision, frame dimensions and expiring frozen reference", async (t) => {
  const h = harness(t);
  const initial = await h.start();
  await h.emit(0, []);
  const preview = h.preview();
  const request = {
    sessionId: initial.sessionId,
    expectedRevision: preview.configRevision,
    calibration: calibration(),
    referenceFrame: { frameId: preview.frameId, width: 200, height: 200 },
  };
  for (const invalid of [
    { ...request, sessionId: "old-session" },
    { ...request, expectedRevision: 0 },
    { ...request, referenceFrame: { ...request.referenceFrame, width: 201 } },
    {
      ...request,
      referenceFrame: {
        ...request.referenceFrame,
        frameId: preview.frameId + 999,
      },
    },
  ])
    assert.throws(
      () => h.monitor.configure(invalid),
      (error) => error.status === 409,
    );
  const response = h.monitor.configure(request);
  assert.equal(response.config.revision, preview.configRevision + 1);
  request.calibration.widthMeters = 999;
  request.calibration.points[0].x = 0.5;
  assert.equal(h.monitor.status().config.calibration.widthMeters, 20);
  assert.equal(h.monitor.status().config.calibration.points[0].x, 0);
  assert.throws(
    () =>
      h.monitor.configure({
        ...request,
        expectedRevision: response.config.revision,
      }),
    (error) => error.status === 409,
  );
  await h.emit(0.4, [], { advanceMs: 400 });
  const fresh = h.preview();
  h.advance(120001);
  assert.throws(
    () =>
      h.monitor.configure({
        ...request,
        expectedRevision: response.config.revision,
        calibration: calibration(),
        referenceFrame: { frameId: fresh.frameId, width: 200, height: 200 },
      }),
    (error) => error.status === 409,
  );
});
test("calibrated case stores the frozen policy, timestamp, box and JPEG once per identity", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, []);
  const road = calibration();
  h.configure({ calibration: road });
  road.lengthMeters = 999;
  for (let index = 1; index <= 15; index++)
    await h.emit(index / 10, [detection(40 + index * 2)]);
  assert.equal(h.saved.length, 1);
  const { record, evidence } = h.saved[0];
  assert.equal(record.sourceName, "Fixture camera");
  assert.equal(record.sourceKind, "camera");
  assert.equal(record.speedLimit, 20);
  assert.ok(Math.abs(record.speedKmh - 36) < 0.01);
  assert.equal(
    record.speedMeasurement.method,
    "ground-plane-geometric-median-v3",
  );
  assert.deepEqual(
    record.speedMeasurement,
    shared.calculateSpeedMeasurement(
      record.speedMeasurement.samples,
      record.calibration,
    ),
  );
  assert.equal(record.speedMeasurement.speedKmh, record.speedKmh);
  assert.ok(
    record.sourceTimestamp -
      record.speedMeasurement.samples.at(-1).timeSeconds >=
      0,
  );
  assert.ok(
    record.sourceTimestamp -
      record.speedMeasurement.samples.at(-1).timeSeconds <=
      1 / 30 + 1e-6,
  );
  assert.equal(record.calibration.lengthMeters, 100);
  assert.equal(record.confidence, 0.91);
  assert.ok(
    record.clientEventId.startsWith(h.monitor.status().sessionId + ":"),
  );
  assert.ok(record.sourceTimestamp >= 0.6);
  assert.equal(
    record.captureTime,
    new Date(
      Date.parse("2026-10-02T18:00:00.000Z") +
        100 +
        Math.round(record.sourceTimestamp * 1000),
    ).toISOString(),
  );
  const metadata = await sharp(evidence).metadata();
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 232);
  assert.ok(record.vehicleBox[1] + record.vehicleBox[3] <= 200);
  h.configure({ speedLimitKmh: 40 });
  assert.equal(h.saved[0].record.speedLimit, 20);
  assert.equal(h.monitor.status().stats.casesCreated, 1);
});
test("configuration revision changes discard in-flight predictions and preserve the prior frozen preview", async (t) => {
  const gate = deferred();
  let hold = false;
  const h = harness(t, { infer: async () => (hold ? gate.promise : []) });
  await h.start();
  await h.emit(0, []);
  const previous = h.preview();
  hold = true;
  const pending = h.emit(0.1, [detection()]);
  await until(() => h.engineCalls.length === 2);
  h.configure({ speedLimitKmh: 30 });
  gate.resolve([detection()]);
  await pending;
  assert.equal(h.monitor.status().stats.framesProcessed, 1);
  assert.equal(h.monitor.status().stats.observed, 0);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(h.preview(), previous);
});
test("stop waits for active processing, rejects its stale result and closes both resources", async (t) => {
  const gate = deferred();
  const h = harness(t, { infer: () => gate.promise });
  const started = await h.start();
  const work = h.emit(0, [detection()]);
  await until(() => h.engineCalls.length === 1);
  let stopped = false;
  const stopping = h.monitor.stop({ sessionId: started.sessionId }).then(() => {
    stopped = true;
  });
  await turn();
  assert.equal(stopped, false);
  gate.resolve([detection()]);
  await work;
  await stopping;
  assert.equal(h.monitor.status().state, "stopped");
  assert.equal(h.monitor.status().stats.framesProcessed, 0);
  assert.equal(h.saved.length, 0);
  assert.equal(h.sources[0].stops, 1);
  assert.equal(h.releases, 1);
});
test("stop during delayed detector initialization cleans up the late engine without opening a camera", async (t) => {
  const gate = deferred(),
    h = harness(t, { engineGate: gate });
  const started = await h.start(false);
  const stopping = h.monitor.stop({ sessionId: started.sessionId });
  gate.resolve();
  await stopping;
  assert.equal(h.sources.length, 0);
  assert.equal(h.releases, 1);
  assert.equal(h.monitor.status().state, "stopped");
});
for (const failure of ["sync", "async"]) {
  test(
    `a ${failure} source stop failure cannot skip detector cleanup or terminal history`,
    { timeout: 2000 },
    async (t) => {
      const directory = mkdtempSync(
        join(tmpdir(), "velocity-cleanup-history-"),
      );
      const journal = createMonitorJournal(directory);
      const gate = deferred();
      const h = harness(t, {
        journal,
        sourceStopFailure: failure,
        engineCloseGate: gate,
      });
      t.after(async () => {
        gate.resolve();
        await h.monitor.close();
        journal.close();
        rmSync(directory, { recursive: true, force: true });
      });
      const started = await h.start();
      await h.emit(0, []);
      const before = h.monitor.status();
      let resolved = false;
      const stopping = h.monitor
        .stop({ sessionId: started.sessionId })
        .then((result) => {
          resolved = true;
          return result;
        });
      await until(() => h.releases === 1);
      assert.equal(resolved, false);
      gate.resolve();
      const result = await stopping;
      assert.equal(result.state, "error");
      assert.match(result.error, /cleanup could not be confirmed/);
      assert.doesNotMatch(result.error, /private|credentials/);
      assert.equal(result.stats.active, 0);
      assert.equal(result.stats.analysisFps, 0);
      assert.equal(result.stats.pendingHistory, false);
      assert.equal(h.sources[0].stops, 1);
      assert.equal(h.releases, 1);
      const saved = journal.get(started.sessionId).session;
      assert.equal(saved.state, "error");
      assert.ok(saved.endedAt);
      assert.equal(saved.stats.framesProcessed, before.stats.framesProcessed);
      assert.equal(saved.interrupted, false);
      await h.monitor.retry({ sessionId: started.sessionId });
      assert.match(h.monitor.status().error, /cleanup could not be confirmed/);
      await assert.rejects(
        h.monitor.start({ camera, speedLimitKmh: 20 }),
        (error) =>
          error.status === 503 &&
          /cleanup could not be confirmed/.test(error.message),
      );
      assert.equal(h.sources.length, 1);
    },
  );
}
test(
  "both cleanup failures are observed independently and the final checkpoint still runs",
  { timeout: 2000 },
  async (t) => {
    const checkpoints = [];
    const h = harness(t, {
      sourceStopFailure: "async",
      engineCloseFailure: true,
      journal: {
        checkpoint(status, details) {
          checkpoints.push(structuredClone({ status, details }));
        },
      },
    });
    const started = await h.start();
    const result = await h.monitor.stop({ sessionId: started.sessionId });
    assert.equal(h.releases, 1);
    assert.equal(h.sources[0].stops, 1);
    assert.equal(result.state, "error");
    assert.match(result.error, /cleanup could not be confirmed/);
    assert.equal(checkpoints.at(-1).details.reason, "ended");
    assert.ok(checkpoints.at(-1).details.endedAt);
    assert.equal(checkpoints.at(-1).status.state, "error");
    assert.doesNotMatch(JSON.stringify(checkpoints), /private|credentials/);
  },
);
test(
  "failed source cleanup still drains a late frame consumer before saving terminal history",
  { timeout: 2000 },
  async (t) => {
    const gate = deferred();
    const checkpoints = [];
    const h = harness(t, {
      sourceStopFailure: "async",
      infer: () => gate.promise,
      journal: {
        checkpoint(status, details) {
          checkpoints.push(structuredClone({ status, details }));
        },
      },
    });
    const started = await h.start();
    const work = h.emit(0, [detection()]);
    await until(() => h.engineCalls.length === 1);
    let resolved = false;
    const stopping = h.monitor
      .stop({ sessionId: started.sessionId })
      .then((result) => {
        resolved = true;
        return result;
      });
    await until(() => h.releases === 1);
    assert.equal(resolved, false);
    assert.equal(
      checkpoints.some((row) => row.details.reason === "ended"),
      false,
    );
    gate.resolve([detection()]);
    await work;
    const result = await stopping;
    assert.equal(result.state, "error");
    assert.equal(result.stats.framesProcessed, 0);
    assert.equal(result.stats.observed, 0);
    assert.equal(checkpoints.at(-1).details.reason, "ended");
    assert.equal(checkpoints.at(-1).status.stats.framesProcessed, 0);
  },
);
test(
  "detector close rejection after a normal source stop is saved as an error",
  { timeout: 2000 },
  async (t) => {
    const checkpoints = [];
    const h = harness(t, {
      engineCloseFailure: true,
      journal: {
        checkpoint(status, details) {
          checkpoints.push(structuredClone({ status, details }));
        },
      },
    });
    const started = await h.start();
    const result = await h.monitor.stop({ sessionId: started.sessionId });
    assert.equal(result.state, "error");
    assert.match(result.error, /cleanup could not be confirmed/);
    assert.equal(h.sources[0].stops, 1);
    assert.equal(h.releases, 1);
    assert.equal(checkpoints.at(-1).status.state, "error");
    assert.equal(checkpoints.at(-1).details.reason, "ended");
  },
);
test(
  "failed cleanup after a decoder error prevents opening a replacement decoder",
  { timeout: 2000 },
  async (t) => {
    const checkpoints = [];
    const h = harness(t, {
      sourceStopFailure: "async",
      journal: {
        checkpoint(status, details) {
          checkpoints.push(structuredClone({ status, details }));
        },
      },
    });
    await h.start();
    h.sources[0].fail();
    await until(() => checkpoints.at(-1)?.details.reason === "ended");
    assert.equal(h.monitor.status().state, "error");
    assert.match(h.monitor.status().error, /cleanup could not be confirmed/);
    assert.equal(h.sources.length, 1);
    assert.equal(h.sources[0].stops, 1);
    assert.equal(h.releases, 1);
    assert.equal(
      checkpoints.some((row) => row.details.reason === "reconnecting"),
      false,
    );
  },
);
test(
  "save failure keeps its priority and retry cannot erase a concurrent cleanup failure",
  { timeout: 2000 },
  async (t) => {
    let fail = false;
    const checkpoints = [];
    const h = harness(t, {
      sourceStopFailure: "async",
      journal: {
        checkpoint(status, details) {
          if (fail) throw new Error("private history failure");
          checkpoints.push(structuredClone({ status, details }));
        },
      },
    });
    const started = await h.start();
    await h.emit(0, []);
    fail = true;
    assert.throws(
      () => h.configure({ speedLimitKmh: 80 }),
      (error) => error.status === 503,
    );
    await until(() => h.releases === 1);
    await h.monitor.stop({ sessionId: started.sessionId });
    assert.match(
      h.monitor.status().error,
      /Session history could not be saved/,
    );
    assert.equal(h.monitor.status().stats.pendingHistory, true);
    fail = false;
    const recovered = await h.monitor.retry({ sessionId: started.sessionId });
    assert.equal(recovered.stats.pendingHistory, false);
    assert.match(recovered.error, /cleanup could not be confirmed/);
    assert.equal(recovered.state, "error");
    assert.equal(checkpoints.at(-1).details.reason, "retry");
    assert.ok(checkpoints.at(-1).details.endedAt);
    await assert.rejects(
      h.monitor.start({ camera, speedLimitKmh: 20 }),
      (error) => error.status === 503,
    );
    assert.doesNotMatch(JSON.stringify(checkpoints), /private|credentials/);
  },
);
test("media rollback and long gaps preserve counts but cannot join unseen crossings or reuse IDs", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, []);
  h.configure({ countingLine: line });
  for (const [index, y] of [70, 80, 90, 110].entries())
    await h.emit((index + 1) / 10, [detection(y)]);
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  for (const time of [0, 0.1, 0.2, 0.3]) await h.emit(time, [detection(90)]);
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  assert.equal(h.monitor.status().stats.observed, 2);
  for (const time of [10, 10.1, 10.2, 10.3])
    await h.emit(time, [detection(110)]);
  const status = h.monitor.status();
  assert.equal(status.stats.crossings.total, 1);
  assert.equal(status.stats.observed, 3);
  assert.equal(status.stats.gapCount, 2);
  assert.equal(h.resets, 2);
  assert.ok(
    h.engineCalls.every(
      (call, index) =>
        index === 0 ||
        call.mediaSeconds > h.engineCalls[index - 1].mediaSeconds,
    ),
  );
  const gapIndex = h.engineCalls.length - 4;
  assert.ok(
    Math.abs(
      h.engineCalls[gapIndex].mediaSeconds -
        h.engineCalls[gapIndex - 1].mediaSeconds -
        9.7,
    ) < 1e-9,
    "forward media gaps retain their actual duration",
  );
});
test("resolution changes invalidate calibrated geometry and frozen references without erasing historical crossings", async (t) => {
  const h = harness(t, { limit: 500 });
  await h.start();
  await h.emit(0, []);
  h.configure({ calibration: calibration(), countingLine: line });
  for (const [index, y] of [70, 80, 90, 110].entries())
    await h.emit((index + 1) / 10, [detection(y)]);
  const old = h.preview();
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  await h.emit(0.5, [detection(110)], { width: 220, advanceMs: 400 });
  const status = h.monitor.status();
  assert.equal(status.config.calibration, null);
  assert.equal(status.config.countingLine, null);
  assert.equal(status.stats.crossings.total, 1);
  assert.match(status.message, /Frame size changed/);
  assert.throws(
    () =>
      h.monitor.configure({
        sessionId: status.sessionId,
        expectedRevision: status.config.revision,
        countingLine: line,
        referenceFrame: {
          frameId: old.frameId,
          width: old.width,
          height: old.height,
        },
      }),
    (error) => error.status === 409,
  );
  assert.equal(h.preview().width, 220);
});
test("failed evidence saves stop analysis, retain the exact pending event and retry without duplicate cases", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-evidence-history-"));
  const journal = createMonitorJournal(directory);
  const h = harness(t, { journal });
  t.after(async () => {
    await h.monitor.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.start();
  await h.emit(0, []);
  h.configure({ calibration: calibration() });
  h.setDiskFailure(true);
  let failed = false;
  for (let index = 1; index <= 12; index++) {
    try {
      await h.emit(index / 10, [detection(40 + index * 2)]);
    } catch {
      failed = true;
      break;
    }
  }
  assert.equal(failed, true);
  await until(() => h.monitor.status().state === "error");
  const status = h.monitor.status();
  assert.equal(status.stats.pendingCases, 1);
  assert.equal(status.stats.casesCreated, 0);
  const original = structuredClone(h.attempts[0]);
  await assert.rejects(
    h.monitor.start({ camera, speedLimitKmh: 20 }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    h.monitor.retry({ sessionId: status.sessionId }),
    (error) => error.status === 503,
  );
  h.setDiskFailure(false);
  await h.monitor.retry({ sessionId: status.sessionId });
  await h.monitor.retry({ sessionId: status.sessionId });
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0], original);
  assert.equal(h.monitor.status().stats.pendingCases, 0);
  assert.equal(h.monitor.status().stats.casesCreated, 1);
  const history = journal.get(status.sessionId).session;
  assert.equal(history.state, "error");
  assert.equal(history.stats.pendingCases, 0);
  assert.equal(history.stats.casesCreated, 1);
});
test("measured pedestrians and bicycles cannot create motor-vehicle speeding cases", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, []);
  h.configure({ calibration: calibration() });
  for (let index = 1; index <= 12; index++) {
    const y = 40 + index * 2;
    await h.emit(index / 10, [
      detection(y, "bicycle"),
      { ...detection(y, "person"), bbox: [135, y - 30, 20, 30] },
    ]);
  }
  assert.equal(h.saved.length, 0);
  assert.equal(h.monitor.status().stats.observed, 1);
  assert.ok(h.preview().tracks.every((track) => track.speedKmh > 20));
});
test("completed analysis health and geometry expiry use monotonic time despite system-clock adjustments", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, []);
  const elapsed = h.monitor.status().stats.elapsedSeconds;
  h.jumpWall(-60 * 60 * 1000);
  assert.equal(h.monitor.status().stats.elapsedSeconds, elapsed);
  assert.equal(h.monitor.status().state, "running");
  assert.doesNotThrow(() => h.configure({ countingLine: line }));
  h.jumpWall(2 * 60 * 60 * 1000);
  await h.emit(0.1, [detection()]);
  assert.equal(h.monitor.status().stats.gapCount, 0);
  assert.equal(h.monitor.status().stats.elapsedSeconds, elapsed + 0.1);
});
test("delivery stalls report stale health but continuous source PTS preserves observed trajectories", async (t) => {
  const h = harness(t);
  await h.start();
  for (const time of [0, 0.1, 0.2, 0.3]) await h.emit(time, [detection()]);
  assert.equal(h.monitor.status().stats.active, 1);
  const preview = h.preview();
  h.advance(3001);
  const stale = h.monitor.status();
  assert.equal(stale.state, "stalled");
  assert.equal(stale.stats.active, 0);
  assert.equal(stale.stats.analysisFps, 0);
  assert.deepEqual(h.preview(), preview);
  await h.emit(0.4, [detection()]);
  assert.equal(h.monitor.status().state, "running");
  assert.equal(h.monitor.status().stats.active, 1);
  assert.equal(h.monitor.status().stats.observed, 1);
  assert.equal(h.monitor.status().stats.gapCount, 0);
  assert.equal(h.preview().tracks[0].id, preview.tracks[0].id);
});
