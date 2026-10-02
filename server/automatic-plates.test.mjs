import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { createAutomaticPlates } from "./automatic-plates.mjs";
const car = (id = 1, bbox = [10, 20, 140, 60]) => ({
  id,
  bbox,
  className: "car",
});
const read = (plate = "AB12 CDE", confidence = 91) => ({
  state: "read",
  plate,
  confidence,
});
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
function fixture(t, options = {}) {
  let clock = 0,
    factories = 0,
    closes = 0,
    marker = 0,
    timerId = 0;
  const calls = [],
    timers = new Map(),
    pending = new Set();
  const coordinator = createAutomaticPlates({
    enabled: options.enabled ?? true,
    monotonic: () => clock,
    schedule(callback, ms) {
      const id = ++timerId;
      timers.set(id, { callback, at: clock + ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    createEngine: async () => {
      factories++;
      return {
        read(crop) {
          calls.push(crop);
          if (!options.deferred)
            return Promise.resolve(options.result?.(calls.length) ?? read());
          const job = deferred();
          pending.add(job);
          job.promise.then(
            () => pending.delete(job),
            () => pending.delete(job),
          );
          return job.promise;
        },
        async close() {
          closes++;
          for (const job of pending) job.reject(new Error("cancelled"));
          if (options.closeFailure)
            throw new Error("unconfirmed native termination");
        },
      };
    },
  });
  t.after(async () => {
    try {
      await coordinator.close();
    } catch (error) {
      if (!options.closeFailure) throw error;
    }
  });
  function advance(value) {
    clock = value;
    for (const [id, timer] of [...timers])
      if (timer.at <= clock) {
        timers.delete(id);
        timer.callback();
      }
  }
  function observe(
    time,
    {
      tracks = [car()],
      detections = [],
      epoch = "one",
      rgb,
      width = 640,
      height = 240,
      mono = time * 1000,
    } = {},
  ) {
    advance(mono);
    const frame = {
      width,
      height,
      rgb: rgb ?? new Uint8Array(width * height * 3).fill(++marker),
    };
    coordinator.observe({
      epoch,
      frame,
      tracks,
      detections,
      sourceTimestamp: time,
      observedAt: new Date(1700000000000 + time * 1000).toISOString(),
    });
    return frame;
  }
  return {
    coordinator,
    calls,
    pending,
    observe,
    advance,
    get factories() {
      return factories;
    },
    get closes() {
      return closes;
    },
  };
}
test("lazy native crops, two distinct frames and exact provenance produce only an unverified candidate", async (t) => {
  const f = fixture(t);
  f.observe(0, { tracks: [car(1, [0, 0, 119, 40])] });
  await settle();
  assert.equal(f.factories, 0);
  f.observe(1, { tracks: [car(1, [10.2, 20.3, 140.7, 60.8])] });
  await settle();
  assert.equal(f.calls[0].width, 139);
  assert.equal(f.calls[0].height, 60);
  assert.equal(f.coordinator.readings()[0].samples, 1);
  assert.equal(f.coordinator.readings()[0].plate, null);
  f.observe(2);
  await settle();
  const value = f.coordinator.readings()[0];
  assert.equal(value.state, "candidate");
  assert.equal(value.plate, "AB12CDE");
  assert.equal(value.samples, 2);
  assert.equal(value.sourceTimestamp, 2);
  assert.equal(value.observedAt, new Date(1700000002000).toISOString());
  assert.match(value.reason, /Unverified/);
  value.plate = "MUTATED";
  assert.equal(f.coordinator.readings()[0].plate, "AB12CDE");
});
test("same full-frame pixels with changed PTS and box jitter never form consensus", async (t) => {
  const f = fixture(t),
    rgb = new Uint8Array(640 * 240 * 3).fill(100);
  f.observe(0, { rgb });
  await settle();
  f.observe(1, { rgb: rgb.slice(), tracks: [car(1, [11, 20, 140, 60])] });
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.coordinator.readings()[0].samples, 1);
  assert.equal(f.coordinator.readings()[0].plate, null);
});
test("media separation and global job rate are both enforced", async (t) => {
  const f = fixture(t);
  f.observe(0);
  await settle();
  f.observe(0.1, { mono: 1000 });
  await settle();
  assert.equal(f.calls.length, 1);
  f.observe(0.2, { mono: 1001 });
  await settle();
  assert.equal(f.calls.length, 2);
  f.observe(0.4, { mono: 1100 });
  await settle();
  assert.equal(f.calls.length, 2);
  f.advance(2001);
  await settle();
  assert.equal(f.calls.length, 3);
});
test("native crop copies survive decoder buffer reuse; only active and newest waiting work remain", async (t) => {
  const f = fixture(t, { deferred: true });
  const first = f.observe(0);
  await settle();
  const saved = f.calls[0].rgb[0];
  first.rgb.fill(230);
  assert.equal(f.calls[0].rgb[0], saved);
  const second = car(2, [300, 20, 140, 60]);
  f.observe(1, { tracks: [car(), second] });
  const newest = f.observe(2, { tracks: [car(), second] });
  const expected = newest.rgb[0];
  newest.rgb.fill(240);
  assert.equal(f.coordinator.status().pending, 2);
  [...f.pending][0].resolve(read());
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].rgb[0], expected);
  [...f.pending][0].resolve(read());
  await settle();
  assert.equal(f.coordinator.readings([2])[0].sourceTimestamp, 2);
  assert.equal(f.coordinator.readings([2])[0].samples, 1);
});
test("same track ID after epoch reset cannot inherit an awaited result", async (t) => {
  const f = fixture(t, { deferred: true });
  f.observe(0);
  await settle();
  const old = [...f.pending][0];
  f.observe(1, { epoch: "two" });
  old.resolve(read("OLD123"));
  await settle();
  assert.equal(f.coordinator.readings()[0].samples, 0);
  [...f.pending][0].resolve(read("NEW123"));
  await settle();
  assert.equal(f.coordinator.readings()[0].samples, 1);
  assert.equal(f.coordinator.readings()[0].plate, null);
});
test("absolute five-second capture age rejects delayed reads even with slowly advancing PTS", async (t) => {
  const f = fixture(t, { deferred: true });
  f.observe(0);
  await settle();
  const job = [...f.pending][0];
  f.observe(0.05, { mono: 4000 });
  f.observe(0.1, { mono: 6000 });
  job.resolve(read());
  await settle();
  assert.equal(f.coordinator.readings()[0].samples, 0);
  assert.equal(f.coordinator.readings()[0].state, "unreadable");
  assert.match(f.coordinator.readings()[0].reason, /expired/);
  assert.equal(f.coordinator.status().pending, 0);
});
test("waiting crops expire instead of entering OCR after a long active read", async (t) => {
  const f = fixture(t, { deferred: true });
  f.observe(0);
  await settle();
  const tracks = [car(), car(2, [300, 20, 140, 60])];
  const queued = f.observe(0.3, { tracks, mono: 1000 });
  f.observe(0.35, { tracks, rgb: queued.rgb, mono: 4000 });
  f.observe(0.4, { tracks, rgb: queued.rgb, mono: 6500 });
  [...f.pending][0].resolve(read());
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.coordinator.readings([2])[0].state, "unreadable");
});
test("unseen identities and disabled readers discard late work", async (t) => {
  const f = fixture(t, { deferred: true });
  f.observe(0);
  await settle();
  const old = [...f.pending][0];
  f.advance(5001);
  old.resolve(read());
  await settle();
  assert.deepEqual(f.coordinator.readings(), []);
  f.observe(6);
  await settle();
  f.coordinator.setEnabled(false);
  await settle();
  assert.deepEqual(f.coordinator.readings(), []);
  assert.equal(f.coordinator.status().state, "disabled");
  assert.equal(f.closes, 1);
});
test("disagreement clears a candidate and one later matching historical read cannot resurrect it", async (t) => {
  const f = fixture(t, {
    result: (n) => read(n === 3 ? "ZZ99ZZZ" : "AB12CDE"),
  });
  f.observe(0);
  await settle();
  f.observe(1);
  await settle();
  assert.equal(f.coordinator.readings()[0].state, "candidate");
  f.observe(2);
  await settle();
  assert.equal(f.coordinator.readings()[0].state, "conflict");
  f.observe(3, { tracks: [car(1, [10, 20, 210, 90])] });
  await settle();
  assert.equal(f.calls.length, 4);
  assert.equal(f.coordinator.readings()[0].plate, null);
  assert.equal(f.coordinator.readings()[0].samples, 1);
});
test("unreadable frames preserve a retained candidate's OCR timestamp and confidence", async (t) => {
  const f = fixture(t, {
    result: (n) =>
      n === 3 ? { state: "unreadable", plate: null, confidence: null } : read(),
  });
  f.observe(0);
  await settle();
  f.observe(1);
  await settle();
  const candidate = f.coordinator.readings()[0];
  f.observe(2);
  await settle();
  assert.deepEqual(f.coordinator.readings()[0], candidate);
});
test("attempt budget is three until a materially larger native crop becomes available", async (t) => {
  const f = fixture(t);
  for (let time = 0; time < 6; time++) {
    f.observe(time);
    await settle();
  }
  assert.equal(f.calls.length, 3);
  f.observe(6, { tracks: [car(1, [10, 20, 210, 90])] });
  await settle();
  assert.equal(f.calls.length, 4);
});
test("overlapping confirmed or unconfirmed vehicles abstain before native OCR", async (t) => {
  const f = fixture(t);
  f.observe(0, { tracks: [car(), car(2, [100, 30, 140, 60])] });
  await settle();
  assert.equal(f.factories, 0);
  f.observe(1, {
    detections: [
      { ...car(), score: 0.9 },
      { ...car(2, [100, 30, 140, 60]), score: 0.6 },
    ],
  });
  await settle();
  assert.equal(f.factories, 0);
  assert.equal(f.coordinator.readings([1])[0].state, "conflict");
  f.observe(2, { detections: [{ ...car(), score: 0.9 }] });
  await settle();
  assert.equal(f.calls.length, 1);
});
test("ownership ambiguity clears old candidates even below the new-crop size threshold", async (t) => {
  const f = fixture(t);
  f.observe(0);
  await settle();
  f.observe(1);
  await settle();
  assert.equal(f.coordinator.readings()[0].state, "candidate");
  f.observe(2, {
    tracks: [car(1, [10, 20, 100, 60]), car(2, [80, 20, 140, 60])],
  });
  await settle();
  assert.equal(f.coordinator.readings([1])[0].state, "conflict");
  assert.equal(f.coordinator.readings([1])[0].plate, null);
  assert.equal(f.calls.length, 2);
});
test("an awaited old crop cannot reintroduce a plate after overlap invalidates its ownership", async (t) => {
  const f = fixture(t, { deferred: true });
  f.observe(0);
  await settle();
  const job = [...f.pending][0];
  f.observe(1, {
    tracks: [car(1, [10, 20, 100, 60]), car(2, [80, 20, 140, 60])],
  });
  job.resolve(read());
  await settle();
  assert.equal(f.coordinator.readings([1])[0].state, "conflict");
  assert.equal(f.coordinator.readings([1])[0].samples, 0);
});
test("normal OCR failure is isolated and a successful cleanup permits explicit re-enable", async (t) => {
  const f = fixture(t, { deferred: true });
  f.observe(0);
  await settle();
  [...f.pending][0].reject(new Error("private native failure"));
  await settle();
  assert.equal(f.coordinator.status().state, "unavailable");
  assert.doesNotMatch(f.coordinator.status().reason, /private/);
  f.observe(1);
  await settle();
  assert.equal(f.factories, 1);
  f.coordinator.setEnabled(false);
  f.coordinator.setEnabled(true);
  f.observe(2);
  await settle();
  assert.equal(f.factories, 2);
});
test("unconfirmed native cleanup permanently prevents replacement, and close reports it", async (t) => {
  const f = fixture(t, { deferred: true, closeFailure: true });
  f.observe(0);
  await settle();
  f.coordinator.setEnabled(false);
  f.coordinator.setEnabled(true);
  await settle();
  f.observe(1);
  await settle();
  assert.equal(f.factories, 1);
  assert.equal(f.coordinator.status().state, "unavailable");
  assert.match(f.coordinator.status().reason, /Restart the local service/);
  await assert.rejects(f.coordinator.close(), /Restart the local service/);
});
test("identity memory is capped and returned readings never merge separate vehicles", async (t) => {
  const f = fixture(t, { deferred: true });
  for (let id = 1; id <= 130; id++)
    f.observe(id / 100, { tracks: [car(id)], mono: id });
  await settle();
  assert.ok(f.coordinator.readings().length <= 100);
  assert.ok(f.coordinator.status().pending <= 2);
  assert.ok(
    f.coordinator
      .readings()
      .every((value) => value.plate === null && value.samples === 0),
  );
});
test("unsupported text, weak confidence and ambiguous proposals never create registration candidates", async (t) => {
  const f = fixture(t, {
    result: (n) =>
      n === 1
        ? read("AБ12345")
        : n === 2
          ? read("AB12345", 74.99)
          : { state: "ambiguous", plate: "AB12345", confidence: 99 },
  });
  for (let time = 0; time < 3; time++) {
    f.observe(time);
    await settle();
  }
  assert.equal(f.coordinator.readings()[0].plate, null);
  assert.equal(f.coordinator.readings()[0].samples, 0);
  assert.equal(f.coordinator.readings()[0].state, "conflict");
});
test("pedestrians and bicycles never enter automatic motor-vehicle plate reading", async (t) => {
  const f = fixture(t);
  f.observe(0, {
    tracks: [
      { ...car(), className: "person" },
      { ...car(2), className: "bicycle" },
    ],
  });
  await settle();
  assert.equal(f.factories, 0);
  assert.deepEqual(f.coordinator.readings(), []);
});
