import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { createMonitor } from "./monitor.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const shared = await loadVisionShared();
const camera = {
  type: "nest",
  url: "https://video.nest.com/live/plateFixture",
  name: "Plate fixture",
};
const car = (bbox = [30, 40, 150, 70]) => ({
  className: "car",
  bbox,
  score: 0.95,
});
const goodRead = { state: "read", plate: "AB12CDE", confidence: 93 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await turn();
  await turn();
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await turn();
  }
  throw new Error("Expected monitor state did not arrive");
}
function fixture(t, options = {}) {
  let mono = 1000,
    clock = Date.parse("2026-10-02T18:00:00Z"),
    index = 0;
  let currentDetections = [],
    stability = "stable",
    detectorCalls = 0,
    resets = 0,
    factories = 0;
  const sources = [],
    plateCalls = [],
    pending = new Set(),
    saved = [],
    checkpoints = [];
  const monitor = createMonitor({
    shared: {
      ...shared,
      createCameraReference: () => Object.freeze({ fixture: true }),
      assessCameraStability: () => ({
        state: stability,
        reason: `${stability} test reference`,
        matched: 20,
        displacementPixels: stability === "moved" ? 20 : 0,
      }),
    },
    now: () => clock,
    monotonic: () => mono,
    journal: {
      checkpoint(status, metadata) {
        checkpoints.push({ status: structuredClone(status), ...metadata });
      },
    },
    store: {
      create(value) {
        saved.push(structuredClone(value));
        return { duplicate: false };
      },
    },
    resolveSource: async () => ({
      url: "https://fixture.invalid/stream",
      type: "nest",
      name: camera.name,
    }),
    createEngine: async () => ({
      info: { provider: "fixture" },
      async processFrame() {
        detectorCalls++;
        return { detections: currentDetections };
      },
      resetContext() {
        resets++;
      },
      close() {},
    }),
    createPlateEngine: async () => {
      factories++;
      return {
        read(crop) {
          plateCalls.push(crop);
          if (options.readFailure)
            return Promise.reject(new Error("private OCR failure"));
          if (!options.deferred) return Promise.resolve(goodRead);
          const job = deferred();
          pending.add(job);
          job.promise.then(
            () => pending.delete(job),
            () => pending.delete(job),
          );
          return job.promise;
        },
        async close() {
          for (const job of pending) job.reject(new Error("cancelled"));
          if (options.closeFailure) throw new Error("private cleanup failure");
        },
      };
    },
    createSource: async (_url, { onFrame }) => {
      const completion = deferred();
      const source = {
        completion: completion.promise,
        emit: onFrame,
        stop() {
          completion.resolve();
        },
      };
      sources.push(source);
      return source;
    },
  });
  t.after(async () => {
    try {
      await monitor.close();
    } catch (error) {
      if (!options.closeFailure) throw error;
    }
  });
  return {
    monitor,
    plateCalls,
    pending,
    saved,
    checkpoints,
    get detectorCalls() {
      return detectorCalls;
    },
    get resets() {
      return resets;
    },
    get factories() {
      return factories;
    },
    setStability(value) {
      stability = value;
    },
    async start(body = {}) {
      const status = await monitor.start({
        camera,
        speedLimitKmh: 20,
        ...body,
      });
      await until(() => sources.length > 0);
      return status;
    },
    async emit(
      mediaSeconds,
      { detections = [car()], width = 640, height = 240, advance = 1000 } = {},
    ) {
      mono += advance;
      clock += advance;
      currentDetections = detections;
      const frame = {
        rgb: Buffer.alloc(width * height * 3, ++index),
        width,
        height,
        mediaSeconds,
        receivedAt: clock,
        index,
      };
      await sources.at(-1).emit(frame);
      await settle();
      return frame;
    },
    preview() {
      return monitor.frame({ sessionId: monitor.status().sessionId });
    },
    configure(values) {
      const status = monitor.status(),
        frame = this.preview();
      return monitor.configure({
        sessionId: status.sessionId,
        expectedRevision: status.config.revision,
        ...(values.countingLine !== undefined
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
    async confirmed(start = 0) {
      await this.emit(start);
      await this.emit(start + 0.1);
      await this.emit(start + 0.2);
    },
  };
}
test("background monitoring defaults to automatic native plate enrichment with frozen read provenance", async (t) => {
  const h = fixture(t);
  assert.equal((await h.start()).automaticPlates.enabled, true);
  await h.confirmed();
  assert.equal(h.plateCalls.length, 1);
  assert.equal(h.plateCalls[0].width, 150);
  assert.equal(h.plateCalls[0].height, 70);
  const raw = await h.emit(1.2);
  const readTimestamp = h.preview().captureTime;
  raw.rgb.fill(255);
  await h.emit(1.3);
  const preview = h.preview(),
    candidate = preview.plateReadings[0];
  assert.equal(candidate.state, "candidate");
  assert.equal(candidate.plate, "AB12CDE");
  assert.equal(candidate.sourceTimestamp, 1.2);
  assert.equal(candidate.observedAt, readTimestamp);
  assert.equal(preview.sourceTimestamp, 1.3);
  assert.equal(candidate.trackId, preview.tracks[0].id);
  assert.equal(h.monitor.status().automaticPlates.reads, 2);
  assert.equal(h.saved.length, 0);
  assert.equal(h.monitor.status().stats.casesCreated, 0);
});
test("awaited OCR never stalls detector frames and disable retires pending results", async (t) => {
  const h = fixture(t, { deferred: true });
  await h.start();
  await h.confirmed();
  assert.equal(h.pending.size, 1);
  await h.emit(0.3);
  await h.emit(0.4);
  assert.equal(h.detectorCalls, 5);
  assert.equal(h.monitor.status().stats.framesProcessed, 5);
  const revision = h.monitor.status().config.revision;
  h.configure({ plateReadingEnabled: false });
  await settle();
  assert.equal(h.monitor.status().config.revision, revision + 1);
  assert.equal(h.monitor.status().automaticPlates.state, "disabled");
  assert.deepEqual(h.preview().plateReadings, []);
  await h.emit(0.5);
  assert.equal(h.monitor.status().state, "running");
  assert.equal(h.detectorCalls, 6);
  h.configure({ plateReadingEnabled: true });
  await h.emit(1.5);
  assert.equal(h.factories, 2);
  assert.equal(h.preview().plateReadings[0].samples, 0);
});
for (const interruption of ["rollback", "dimensions"]) {
  test(`${interruption} retires pending OCR and track ownership before a late read completes`, async (t) => {
    const h = fixture(t, { deferred: true });
    await h.start();
    await h.confirmed();
    const old = [...h.pending][0],
      oldId = h.preview().tracks[0].id;
    await h.emit(
      interruption === "rollback" ? 0.1 : 0.3,
      interruption === "dimensions" ? { width: 800 } : {},
    );
    old.resolve(goodRead);
    await settle();
    assert.deepEqual(h.preview().plateReadings, []);
    await h.emit(0.4, interruption === "dimensions" ? { width: 800 } : {});
    await h.emit(0.5, interruption === "dimensions" ? { width: 800 } : {});
    assert.notEqual(h.preview().tracks[0].id, oldId);
    assert.equal(h.preview().plateReadings[0].samples, 0);
  });
}
test("first known view movement retires vehicle and plate identities once, preserving counts and gap statistics", async (t) => {
  const h = fixture(t);
  await h.start();
  await h.emit(0);
  h.configure({
    countingLine: { a: { x: 0.1, y: 0.6 }, b: { x: 0.9, y: 0.6 } },
  });
  await h.confirmed(0.1);
  await h.emit(1.3);
  const oldId = h.preview().tracks[0].id;
  assert.equal(h.preview().plateReadings[0].state, "candidate");
  const before = h.monitor.status(),
    resets = h.resets;
  h.setStability("moved");
  await h.emit(1.4);
  assert.equal(h.monitor.status().countingStability.state, "moved");
  assert.deepEqual(h.preview().plateReadings, []);
  assert.deepEqual(h.monitor.status().stats.crossings, before.stats.crossings);
  assert.equal(h.monitor.status().stats.gapCount, before.stats.gapCount);
  assert.equal(h.resets, resets + 1);
  await h.emit(1.5);
  await h.emit(1.6);
  assert.notEqual(h.preview().tracks[0].id, oldId);
  assert.equal(h.resets, resets + 1);
  assert.notEqual(h.preview().plateReadings[0]?.state, "candidate");
});
test("an unconfirmed neighbouring detection clears an existing vehicle's plate candidate", async (t) => {
  const h = fixture(t);
  await h.start();
  await h.confirmed();
  await h.emit(1.2);
  assert.equal(h.preview().plateReadings[0].state, "candidate");
  await h.emit(1.3, { detections: [car(), car([140, 50, 150, 70])] });
  assert.equal(h.preview().plateReadings[0].state, "conflict");
  assert.equal(h.preview().plateReadings[0].plate, null);
  assert.equal(h.plateCalls.length, 2);
});
test("OCR failure leaves vehicle tracking and terminal history functional", async (t) => {
  const h = fixture(t, { readFailure: true });
  await h.start();
  await h.confirmed();
  await h.emit(0.3);
  const status = h.monitor.status();
  assert.equal(status.state, "running");
  assert.equal(status.stats.framesProcessed, 4);
  assert.equal(status.automaticPlates.state, "unavailable");
  assert.doesNotMatch(status.automaticPlates.reason, /private/);
  assert.deepEqual(h.preview().plateReadings, []);
  const stopped = await h.monitor.stop({ sessionId: status.sessionId });
  assert.equal(stopped.state, "stopped");
  assert.equal(h.checkpoints.at(-1).reason, "ended");
  assert.equal(h.saved.length, 0);
});
test("failed native cleanup blocks replacement and still commits terminal history", async (t) => {
  const h = fixture(t, { deferred: true, closeFailure: true });
  await h.start();
  await h.confirmed();
  h.configure({ plateReadingEnabled: false });
  await settle();
  h.configure({ plateReadingEnabled: true });
  await h.emit(1.2);
  assert.equal(h.factories, 1);
  assert.equal(h.monitor.status().state, "running");
  assert.equal(h.monitor.status().automaticPlates.state, "unavailable");
  const stopped = await h.monitor.stop({
    sessionId: h.monitor.status().sessionId,
  });
  assert.equal(stopped.state, "error");
  assert.equal(h.checkpoints.at(-1).reason, "ended");
  assert.equal(h.checkpoints.at(-1).status.stats.framesProcessed, 4);
  await assert.rejects(h.monitor.start({ camera, speedLimitKmh: 20 }), {
    status: 503,
  });
  await assert.rejects(h.monitor.close(), { status: 503 });
});
test("automatic reading enablement has strict booleans and explicit start opt-out", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    h.monitor.start({
      camera,
      speedLimitKmh: 20,
      plateReadingEnabled: "false",
    }),
    { status: 400 },
  );
  await h.start({ plateReadingEnabled: false });
  await h.confirmed();
  assert.equal(h.factories, 0);
  assert.equal(h.monitor.status().automaticPlates.enabled, false);
  assert.throws(() => h.configure({ plateReadingEnabled: 1 }), { status: 400 });
  h.configure({ plateReadingEnabled: true });
  await h.emit(1.2);
  assert.equal(h.factories, 1);
});
