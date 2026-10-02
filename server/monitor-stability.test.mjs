import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createMonitor } from "./monitor.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const shared = await loadVisionShared();
const camera = {
  type: "nest",
  url: "https://video.nest.com/live/stabilityFixture",
  name: "Stability fixture",
};
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
const line = { a: { x: 0.1, y: 0.5 }, b: { x: 0.9, y: 0.5 } };
const car = (bottom = 60) => ({
  bbox: [70, bottom - 30, 40, 30],
  className: "car",
  score: 0.95,
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
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Monitor did not reach expected state");
    await delay(5);
  }
}
function controlledStability() {
  const created = [],
    assessed = [];
  return {
    created,
    assessed,
    createCameraReference(frame, detections) {
      if (frame.data[0] === 0) return null;
      const reference = Object.freeze({
        marker: frame.data[0],
        detections: structuredClone(detections),
      });
      created.push(reference);
      return reference;
    },
    assessCameraStability(reference, frame, detections) {
      assessed.push({
        reference,
        marker: frame.data[0],
        detections: structuredClone(detections),
      });
      const state =
        frame.data[0] === 3
          ? "unverifiable"
          : frame.data[0] !== reference.marker
            ? "moved"
            : "stable";
      return {
        state,
        reason: `${state} controlled fixture`,
        matched: state === "unverifiable" ? 0 : 20,
        displacementPixels:
          state === "unverifiable" ? null : state === "moved" ? 8 : 0,
      };
    },
  };
}
function harness(t, { stability = controlledStability(), infer } = {}) {
  let clock = Date.parse("2026-10-02T20:00:00.000Z"),
    mono = 1000,
    index = 0;
  const sources = [],
    saved = [];
  const frames = new Map();
  const monitor = createMonitor({
    shared: { ...shared, ...stability },
    now: () => clock,
    monotonic: () => mono,
    store: {
      create(value) {
        saved.push(structuredClone(value));
        return { duplicate: false };
      },
    },
    resolveSource: async () => ({
      url: "https://fixture.invalid/camera",
      type: "nest",
      name: camera.name,
    }),
    createEngine: async () => ({
      info: { provider: "fixture" },
      async processFrame(frame) {
        return {
          detections: infer
            ? await infer(frame, frames.get(frame.mediaSeconds))
            : (frames.get(frame.mediaSeconds) ?? []),
        };
      },
      resetContext() {},
      close() {},
    }),
    createSource: async (_url, { onFrame }) => {
      const completion = deferred();
      const source = {
        completion: completion.promise,
        emit: onFrame,
        fail() {
          completion.reject(new Error("fixture interruption"));
        },
        stop() {
          completion.resolve();
        },
      };
      sources.push(source);
      return source;
    },
  });
  t.after(() => monitor.close());
  return {
    monitor,
    sources,
    saved,
    stability,
    async start() {
      await monitor.start({ camera, speedLimitKmh: 20 });
      await until(() => sources.length === 1);
    },
    async emit(
      time,
      {
        marker = 1,
        detections = [],
        width = 200,
        height = 200,
        rgb,
        advance = 250,
      } = {},
    ) {
      clock += advance;
      mono += advance;
      frames.set(time, structuredClone(detections));
      const frame = {
        rgb: rgb ?? Buffer.alloc(width * height * 3, marker),
        width,
        height,
        mediaSeconds: time,
        index: index++,
        receivedAt: clock,
        receivedMonotonic: mono,
      };
      await sources.at(-1).emit(frame);
      return frame;
    },
    preview() {
      return monitor.frame({ sessionId: monitor.status().sessionId });
    },
    configure(values, preview) {
      const status = monitor.status(),
        frame = preview ?? this.preview();
      return monitor.configure({
        sessionId: status.sessionId,
        expectedRevision: status.config.revision,
        referenceFrame: {
          frameId: frame.frameId,
          width: frame.width,
          height: frame.height,
        },
        ...values,
      });
    },
  };
}
test("calibration binds the selected older exact analyzed reference and count-line edits cannot re-anchor it", async (t) => {
  const h = harness(t);
  await h.start();
  const raw = await h.emit(0, { marker: 1, detections: [car()] });
  const selected = h.preview();
  await h.emit(0.1, { marker: 9 });
  raw.rgb.fill(9);
  h.configure({ calibration }, selected);
  assert.equal(h.monitor.status().cameraStability.state, "unverifiable");
  await h.emit(0.2, { marker: 1 });
  assert.equal(h.monitor.status().cameraStability.state, "stable");
  assert.equal(h.stability.assessed[0].reference.marker, 1);
  assert.deepEqual(h.stability.assessed[0].reference.detections, [car()]);
  const beforeLine = h.stability.assessed.length;
  h.configure({ countingLine: line });
  await h.emit(0.3, { marker: 1 });
  assert.equal(
    h.stability.assessed[beforeLine].reference,
    h.stability.assessed[0].reference,
  );
  assert.notEqual(
    h.stability.assessed.at(-1).reference,
    h.stability.assessed[0].reference,
  );
  assert.deepEqual(
    h.preview().cameraStability,
    h.monitor.status().cameraStability,
  );
});
test("an unusable reference rejects calibration but still permits count-line edits and calibration clearing", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, { marker: 0 });
  const before = h.monitor.status().config;
  assert.throws(() => h.configure({ calibration }), { status: 409 });
  assert.deepEqual(h.monitor.status().config, before);
  h.configure({ countingLine: line });
  assert.deepEqual(h.monitor.status().config.countingLine, line);
  await h.emit(0.1, { marker: 0 });
  h.configure({ calibration: null });
  assert.equal(h.monitor.status().cameraStability.state, "uncalibrated");
});
test("first camera movement suppresses the would-be speed case and latches through count-line edits until recalibration", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ calibration });
  for (let i = 1; i <= 5; i++)
    await h.emit(i / 10, { detections: [car(40 + i * 2)] });
  await h.emit(0.6, { marker: 2, detections: [car(52)] });
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(h.saved.length, 0);
  assert.ok(
    h
      .preview()
      .tracks.every(
        (track) => track.speedKmh === null && track.speedMeasurement === null,
      ),
  );
  const anchor = h.stability.assessed[0].reference;
  const assessments = h.stability.assessed.filter(
    (item) => item.reference === anchor,
  ).length;
  h.configure({ countingLine: line });
  for (let i = 7; i <= 14; i++)
    await h.emit(i / 10, { detections: [car(40 + i * 2)] });
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(
    h.stability.assessed.filter((item) => item.reference === anchor).length,
    assessments,
  );
  assert.equal(h.saved.length, 0);
  h.configure({ calibration });
  for (let i = 15; i <= 22; i++)
    await h.emit(i / 10, { detections: [car(40 + i * 2)] });
  assert.equal(h.monitor.status().cameraStability.state, "stable");
  assert.equal(h.saved.length, 1);
  assert.ok(h.saved[0].record.speedMeasurement.samples[0].timeSeconds >= 1.5);
});
test("unverifiable frames clear speed history while stable recovery preserves vehicle identity and requires a fresh window", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ calibration });
  for (let i = 1; i <= 5; i++)
    await h.emit(i / 10, { detections: [car(40 + i * 2)] });
  const trackId = h.preview().tracks[0].id;
  await h.emit(0.6, { marker: 3, detections: [car(52)] });
  assert.equal(h.monitor.status().cameraStability.state, "unverifiable");
  assert.equal(h.preview().tracks[0].id, trackId);
  assert.equal(h.preview().tracks[0].speedKmh, null);
  for (let i = 7; i <= 11; i++)
    await h.emit(i / 10, { detections: [car(40 + i * 2)] });
  assert.equal(h.saved.length, 0);
  assert.equal(h.preview().tracks[0].id, trackId);
  assert.equal(h.preview().tracks[0].speedKmh, null);
  await h.emit(1.2, { detections: [car(64)] });
  assert.equal(h.saved.length, 1);
  assert.ok(h.saved[0].record.speedMeasurement.samples[0].timeSeconds >= 0.7);
});
test("a camera assessment exception fails closed without exposing private errors or ending object analysis", async (t) => {
  const stability = controlledStability();
  const assess = stability.assessCameraStability.bind(stability);
  stability.assessCameraStability = (reference, frame, detections) => {
    if (frame.data[0] === 4)
      throw new Error("private camera credentials and processing details");
    return assess(reference, frame, detections);
  };
  const h = harness(t, { stability });
  await h.start();
  await h.emit(0);
  h.configure({ calibration });
  for (let i = 1; i <= 5; i++)
    await h.emit(i / 10, { detections: [car(40 + i * 2)] });
  await h.emit(0.6, { marker: 4, detections: [car(52)] });
  const status = h.monitor.status();
  assert.equal(status.state, "running");
  assert.equal(status.cameraStability.state, "unverifiable");
  assert.doesNotMatch(status.cameraStability.reason, /private|credentials/);
  assert.equal(h.saved.length, 0);
  assert.equal(h.preview().tracks[0].speedKmh, null);
  await h.emit(0.7, { detections: [car(54)] });
  assert.equal(h.monitor.status().cameraStability.state, "stable");
  assert.equal(h.preview().tracks[0].speedKmh, null);
});
test("configuration changes retire pending detections before assessment or publication", async (t) => {
  const gate = deferred();
  let pending = false;
  const h = harness(t, {
    infer: async (frame, detections) => {
      if (frame.rgb[0] === 2) {
        pending = true;
        await gate.promise;
      }
      return detections ?? [];
    },
  });
  await h.start();
  await h.emit(0);
  h.configure({ calibration });
  await h.emit(0.1);
  const prior = h.preview(),
    before = h.stability.assessed.length;
  const late = h.emit(0.2, { marker: 2, detections: [car()] });
  await until(() => pending);
  h.configure({ countingLine: line });
  gate.resolve();
  await late;
  assert.equal(h.stability.assessed.length, before);
  assert.equal(h.preview().frameId, prior.frameId);
  assert.equal(h.monitor.status().cameraStability.state, "stable");
  assert.equal(h.saved.length, 0);
});
test("resolution changes clear the calibration anchor and invalidate old frozen references", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ calibration });
  await h.emit(0.1);
  const original = h.preview(),
    before = h.stability.assessed.length;
  await h.emit(0.2, { marker: 2, width: 400, height: 200 });
  assert.equal(h.monitor.status().config.calibration, null);
  assert.equal(h.monitor.status().cameraStability.state, "uncalibrated");
  assert.equal(h.stability.assessed.length, before);
  assert.throws(() => h.configure({ calibration }, original), { status: 409 });
});
test("reconnecting preserves the original anchor instead of adopting a shifted replacement camera", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ calibration });
  await h.emit(0.1);
  const anchor = h.stability.assessed[0].reference;
  h.sources[0].fail();
  await until(() => h.monitor.status().state === "reconnecting");
  assert.equal(h.monitor.status().cameraStability.state, "unverifiable");
  await until(() => h.sources.length === 2);
  await h.emit(0, { marker: 2 });
  assert.equal(h.stability.assessed.at(-1).reference, anchor);
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(h.saved.length, 0);
});
test("preview reference retention is capped even when every frame remains inside its age limit", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, { width: 32, height: 32 });
  const first = h.preview();
  await h.emit(0.1, { width: 32, height: 32 });
  const second = h.preview();
  for (let i = 2; i <= 400; i++)
    await h.emit(i / 10, { width: 32, height: 32 });
  assert.throws(() => h.configure({ calibration }, first), { status: 409 });
  assert.doesNotThrow(() => h.configure({ calibration }, second));
});
test("uncalibrated counting latches camera movement, preserves totals and resumes only after an explicit redraw", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit((i + 1) / 10, { detections: [car(y)] });
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  await h.emit(2.5);
  for (const [i, y] of [70, 80, 90].entries())
    await h.emit(2.6 + i / 10, { detections: [car(y)] });
  for (const [i, y] of [110, 120, 130, 140, 150].entries())
    await h.emit(2.9 + i / 10, { marker: 2, detections: [car(y)] });
  assert.equal(h.monitor.status().countingStability.state, "moved");
  assert.equal(h.monitor.status().cameraStability.state, "uncalibrated");
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  await h.emit(3.5);
  assert.equal(h.monitor.status().countingStability.state, "moved");
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit(3.6 + i / 10, { detections: [car(y)] });
  assert.equal(h.monitor.status().countingStability.state, "stable");
  assert.equal(h.monitor.status().stats.crossings.total, 2);
  assert.equal(h.saved.length, 0);
});
test("unverifiable counting breaks crossing continuity and cannot invent a crossing on recovery", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90].entries())
    await h.emit((i + 1) / 10, { detections: [car(y)] });
  await h.emit(0.4, { marker: 3, detections: [car(110)] });
  assert.equal(h.monitor.status().countingStability.state, "unverifiable");
  await h.emit(0.5, { detections: [car(120)] });
  assert.equal(h.monitor.status().countingStability.state, "stable");
  assert.equal(h.monitor.status().stats.crossings.total, 0);
  for (const [i, y] of [110, 90, 80].entries())
    await h.emit(0.6 + i / 10, { detections: [car(y)] });
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  assert.equal(h.monitor.status().stats.crossings.reverse, 1);
});
test("a count line without a usable reference stays suspended until redrawn on a usable frame", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0, { marker: 0 });
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit((i + 1) / 10, { detections: [car(y)] });
  assert.deepEqual(h.monitor.status().config.countingLine, line);
  assert.equal(h.monitor.status().countingStability.state, "unverifiable");
  assert.equal(h.monitor.status().stats.crossings.total, 0);
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit(0.9 + i / 10, { detections: [car(y)] });
  assert.equal(h.monitor.status().countingStability.state, "stable");
  assert.equal(h.monitor.status().stats.crossings.total, 1);
});
test("geometry guards share matching work only for identical anchors and clearing one leaves the other latch intact", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit(0);
  h.configure({ calibration, countingLine: line });
  await h.emit(0.1, { marker: 2 });
  assert.equal(h.stability.assessed.length, 1);
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(h.monitor.status().countingStability.state, "moved");
  h.configure({ countingLine: null });
  await h.emit(0.2, { marker: 2 });
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(h.monitor.status().countingStability.state, "uncalibrated");
  h.configure({ countingLine: line });
  await h.emit(0.3, { marker: 2 });
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(h.monitor.status().countingStability.state, "stable");
  const countAnchor = h.stability.assessed.at(-1).reference;
  h.configure({ calibration: null });
  await h.emit(0.4, { marker: 2 });
  assert.equal(h.monitor.status().cameraStability.state, "uncalibrated");
  assert.equal(h.monitor.status().countingStability.state, "stable");
  assert.equal(h.stability.assessed.at(-1).reference, countAnchor);
  assert.deepEqual(
    h.preview().countingStability,
    h.monitor.status().countingStability,
  );
});
function texture(width, height, shift = 0) {
  const result = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = x - shift;
      let value =
        (Math.imul(sx + 51, 374761393) + Math.imul(y + 73, 668265263)) | 0;
      value = Math.imul(value ^ (value >>> 13), 1274126177);
      const gray = 30 + (((value ^ (value >>> 16)) >>> 0) % 196);
      result.fill(gray, (y * width + x) * 3, (y * width + x + 1) * 3);
    }
  return result;
}
test("real static features bind exact pixels, accept an unchanged scene and block a translated camera", async (t) => {
  assert.equal(
    typeof shared.createCameraReference,
    "function",
    "Rebuild the shared server vision bundle after adding cameraStability.ts.",
  );
  const h = harness(t, { stability: {} });
  await h.start();
  await h.emit(0, { width: 320, height: 240, rgb: texture(320, 240) });
  h.configure({ calibration });
  await h.emit(0.1, { width: 320, height: 240, rgb: texture(320, 240) });
  assert.equal(h.monitor.status().cameraStability.state, "stable");
  assert.ok(h.monitor.status().cameraStability.matched > 0);
  await h.emit(0.2, { width: 320, height: 240, rgb: texture(320, 240, 8) });
  assert.equal(h.monitor.status().cameraStability.state, "moved");
  assert.equal(h.saved.length, 0);
});
test("real textureless video cannot acquire a speed calibration reference", async (t) => {
  assert.equal(typeof shared.createCameraReference, "function");
  const h = harness(t, { stability: {} });
  await h.start();
  await h.emit(0, { width: 320, height: 240, marker: 80 });
  assert.throws(() => h.configure({ calibration }), { status: 409 });
  assert.doesNotThrow(() => h.configure({ countingLine: line }));
  assert.equal(h.monitor.status().config.calibration, null);
  assert.equal(h.saved.length, 0);
});
test("real background registration protects an uncalibrated count line from a translated view", async (t) => {
  assert.equal(typeof shared.createCameraReference, "function");
  const h = harness(t, { stability: {} });
  await h.start();
  await h.emit(0, { rgb: texture(200, 200) });
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit((i + 1) / 10, {
      rgb: texture(200, 200),
      detections: [car(y)],
    });
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  assert.equal(h.monitor.status().cameraStability.state, "uncalibrated");
  await h.emit(0.9, { rgb: texture(200, 200, 8) });
  assert.equal(h.monitor.status().countingStability.state, "moved");
  assert.equal(h.monitor.status().stats.crossings.total, 1);
  await h.emit(1, { rgb: texture(200, 200) });
  assert.equal(h.monitor.status().countingStability.state, "moved");
  h.configure({ countingLine: line });
  for (const [i, y] of [70, 80, 90, 110, 120, 130, 140, 150].entries())
    await h.emit(1.1 + i / 10, {
      rgb: texture(200, 200),
      detections: [car(y)],
    });
  assert.equal(h.monitor.status().countingStability.state, "stable");
  assert.equal(h.monitor.status().stats.crossings.total, 2);
  assert.equal(h.saved.length, 0);
});
