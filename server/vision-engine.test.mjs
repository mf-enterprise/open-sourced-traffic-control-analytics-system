import test from "node:test";
import assert from "node:assert/strict";
import { createFrameProcessor } from "./vision-engine.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const shared = await loadVisionShared();
const car = { bbox: [10, 10, 20, 20], className: "car", score: 0.8 };
const bus = { bbox: [30, 30, 40, 40], className: "bus", score: 0.7 };
const frame = (mediaSeconds = 0) => ({
  rgb: new Uint8Array(100 * 100 * 3),
  width: 100,
  height: 100,
  mediaSeconds,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
test("native processor retains default decode floors and genuinely confirms large vehicles on distinct frames", async () => {
  const calls = [];
  const engine = createFrameProcessor({
    info: {},
    verifier: new shared.LargeVehicleVerifier(),
    infer: async (_, options) => {
      calls.push(options);
      return options.minConfidence === 0.35
        ? [bus, car]
        : [{ ...bus, score: 0.85, bbox: [8, 8, 40, 40] }];
    },
  });
  assert.deepEqual((await engine.processFrame(frame())).detections, [car]);
  const result = await engine.processFrame(frame(0.12));
  assert.deepEqual(
    result.detections.map((d) => d.className),
    ["bus", "car"],
  );
  assert.equal(result.timings.cropRuns, 1);
  assert.equal(calls.filter((c) => c.minConfidence === 0.35).length, 2);
  assert.equal(calls.filter((c) => c.minConfidence === 0.6).length, 2);
  await engine.close();
});
test("processor rejects accumulated work and invalidates a pending frame after reset", async () => {
  const pending = deferred();
  const engine = createFrameProcessor({
    info: {},
    verifier: new shared.LargeVehicleVerifier(),
    infer: () => pending.promise,
  });
  const first = engine.processFrame(frame());
  await assert.rejects(
    engine.processFrame(frame(0.1)),
    (error) => error.code === "VISION_BUSY",
  );
  engine.resetContext();
  pending.resolve([car]);
  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.equal(
    (await engine.processFrame(frame(0))).detections[0].className,
    "car",
  );
  await engine.close();
});
test("crop verification reads the frozen RGB frame even when ingestion recycles the input buffer", async () => {
  const pending = deferred();
  let cropValue;
  const engine = createFrameProcessor({
    info: {},
    verifier: new shared.LargeVehicleVerifier(),
    infer: (data, options) => {
      if (options.minConfidence === 0.35) return pending.promise;
      cropValue = data[0];
      return Promise.resolve([{ ...bus, score: 0.85, bbox: [8, 8, 40, 40] }]);
    },
  });
  const input = frame(),
    work = engine.processFrame(input);
  input.rgb.fill(255);
  pending.resolve([bus]);
  await work;
  assert.equal(cropValue, 0);
  await engine.close();
});
test("processor requires monotonic media time and explicit resets after source changes", async () => {
  const engine = createFrameProcessor({
    info: {},
    verifier: new shared.LargeVehicleVerifier(),
    infer: async () => [car],
  });
  await engine.processFrame(frame(2));
  await assert.rejects(engine.processFrame(frame(2)), /increase strictly/);
  await assert.rejects(engine.processFrame(frame(1)), /increase strictly/);
  await assert.rejects(engine.processFrame(frame(NaN)), /increase strictly/);
  engine.resetContext();
  await engine.processFrame(frame(0));
  await engine.close();
});
test("shutdown waits for active inference, invalidates its result and releases exactly once", async () => {
  const pending = deferred();
  let released = 0;
  const engine = createFrameProcessor({
    info: {},
    verifier: new shared.LargeVehicleVerifier(),
    infer: () => pending.promise,
    release: async () => {
      released++;
    },
  });
  const work = engine.processFrame(frame());
  const rejected = assert.rejects(work, (error) => error.name === "AbortError");
  const closing = engine.close();
  assert.equal(engine.close(), closing);
  assert.equal(released, 0);
  await assert.rejects(engine.processFrame(frame(0.1)), /closed/);
  pending.resolve([car]);
  await rejected;
  await closing;
  assert.equal(released, 1);
});
test("failed inference does not leave the processor permanently busy", async () => {
  let fail = true;
  const engine = createFrameProcessor({
    info: {},
    verifier: new shared.LargeVehicleVerifier(),
    infer: async () => {
      if (fail) throw new Error("device lost");
      return [car];
    },
  });
  await assert.rejects(engine.processFrame(frame()), /device lost/);
  fail = false;
  assert.equal((await engine.processFrame(frame(0.1))).detections.length, 1);
  await engine.close();
});
