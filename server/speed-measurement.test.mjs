import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateCase, validateReview } from "./validation.mjs";
import { createStore } from "./store.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const { calculateSpeedMeasurement } = await loadVisionShared();
const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const fixture = () => ({
  clientEventId: "trace-session:42",
  trackId: 42,
  sourceName: "Trace fixture",
  sourceKind: "camera",
  className: "car",
  speedKmh: 72,
  speedLimit: 50,
  confidence: 0.92,
  captureTime: "2026-10-02T15:00:00.000Z",
  sourceTimestamp: 10.75,
  calibration: {
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    widthMeters: 20,
    lengthMeters: 100,
  },
  speedMeasurement: {
    method: "ground-plane-median-v2",
    samples: [0, 1, 2, 3].map((i) => ({
      timeSeconds: 10 + i * 0.25,
      imagePoint: { x: 0.5, y: 0.2 + i * 0.05 },
    })),
    velocityMps: { x: 0, y: 20 },
    speedKmh: 72,
    pairCount: 6,
  },
  evidence: `data:image/jpeg;base64,${image.toString("base64")}`,
});
test("trace validation independently recomputes and detaches canonical numerical evidence", () => {
  const payload = fixture();
  const expected = calculateSpeedMeasurement(
    payload.speedMeasurement.samples,
    payload.calibration,
    payload.speedMeasurement.method,
  );
  assert.ok(expected);
  const checked = validateCase(payload);
  assert.deepEqual(checked.record.speedMeasurement, expected);
  assert.ok(Math.abs(checked.record.speedMeasurement.speedKmh - 72) < 1e-10);
  assert.equal(checked.record.speedMeasurement.pairCount, 6);
  payload.speedMeasurement.samples[0].imagePoint.y = 0.8;
  payload.speedMeasurement.velocityMps.y = 999;
  payload.calibration.lengthMeters = 999;
  assert.deepEqual(checked.record.speedMeasurement, expected);
  assert.equal(checked.record.calibration.lengthMeters, 100);
  assert.equal(
    checked.fingerprint,
    createHash("sha256").update(JSON.stringify(checked.record)).digest("hex"),
  );
});
test("trace numerical reports must reproduce points, times, calibration and case speed", () => {
  for (const mutate of [
    (p) => {
      p.speedMeasurement.samples[3].imagePoint.y += 0.1;
    },
    (p) => {
      p.speedMeasurement.samples[0].timeSeconds += 0.1;
    },
    (p) => {
      p.calibration.lengthMeters = 200;
    },
    (p) => {
      p.speedMeasurement.speedKmh += 0.01;
    },
    (p) => {
      p.speedKmh += 0.01;
    },
    (p) => {
      p.speedMeasurement.velocityMps.x = 0.01;
    },
    (p) => {
      p.speedMeasurement.velocityMps.y += 0.01;
    },
    (p) => {
      p.speedMeasurement.pairCount++;
    },
  ]) {
    const payload = fixture();
    mutate(payload);
    assert.throws(
      () => validateCase(payload),
      (error) => error.status === 400 && /speedMeasurement/.test(error.message),
    );
  }
});
test("trace ends on the evidence frame without future or stale samples", () => {
  for (const sourceTimestamp of [10.75 - 1e-12, 10.75 + 1 / 30 + 2e-6]) {
    const payload = fixture();
    payload.sourceTimestamp = sourceTimestamp;
    assert.throws(() => validateCase(payload), /future or stale/);
  }
  const payload = fixture();
  payload.sourceTimestamp = 10.75 + 1 / 30;
  assert.doesNotThrow(() => validateCase(payload));
});
test("trace schema rejects unknown keys, sparse arrays, invalid numbers and unsupported methods", () => {
  for (const mutate of [
    (p) => {
      p.speedMeasurement = [];
    },
    (p) => {
      p.speedMeasurement.method = "ground-plane-median-v1";
    },
    (p) => {
      p.speedMeasurement.extra = 1;
    },
    (p) => {
      p.speedMeasurement.samples[0].extra = 1;
    },
    (p) => {
      p.speedMeasurement.samples[0].imagePoint.z = 1;
    },
    (p) => {
      p.speedMeasurement.velocityMps.z = 1;
    },
    (p) => {
      p.speedMeasurement.samples = Array(4);
    },
    (p) => {
      p.speedMeasurement.samples.length = 3;
    },
    (p) => {
      p.speedMeasurement.samples = Array(49).fill(
        p.speedMeasurement.samples[0],
      );
    },
    (p) => {
      p.speedMeasurement.samples[0].timeSeconds = NaN;
    },
    (p) => {
      p.speedMeasurement.samples[0].timeSeconds = -1;
    },
    (p) => {
      p.speedMeasurement.samples[0].imagePoint.x = 1.1;
    },
    (p) => {
      p.speedMeasurement.samples[0].imagePoint.y = -0.1;
    },
    (p) => {
      p.speedMeasurement.samples[0].imagePoint.x = "0.5";
    },
    (p) => {
      p.speedMeasurement.velocityMps.y = Infinity;
    },
    (p) => {
      p.speedMeasurement.speedKmh = NaN;
    },
    (p) => {
      p.speedMeasurement.pairCount = 6.1;
    },
    (p) => {
      p.speedMeasurement.pairCount = 0;
    },
  ]) {
    const payload = fixture();
    mutate(payload);
    assert.throws(() => validateCase(payload), { status: 400 });
  }
});
test("trace rejects invalid observation order, excessive frequency and unsupported time spans", () => {
  for (const times of [
    [10, 10.5, 10.25, 10.75],
    [10, 10.25, 10.25, 10.75],
    [10, 10.02, 10.5, 10.75],
    [10, 10.6, 10.7, 10.75],
    [10.4, 10.5, 10.6, 10.75],
    [9, 9.5, 10, 10.75],
  ]) {
    const payload = fixture();
    payload.speedMeasurement.samples.forEach((sample, i) => {
      sample.timeSeconds = times[i];
    });
    assert.throws(
      () => validateCase(payload),
      /valid calibrated speed measurement/,
    );
  }
  const outside = fixture();
  outside.calibration.points = [
    { x: 0.4, y: 0.1 },
    { x: 0.6, y: 0.1 },
    { x: 0.6, y: 0.9 },
    { x: 0.4, y: 0.9 },
  ];
  outside.speedMeasurement.samples[0].imagePoint.x = 0.2;
  assert.throws(
    () => validateCase(outside),
    /valid calibrated speed measurement/,
  );
});
test("simulation and missing calibration cannot carry a real measurement trace", () => {
  for (const override of [
    { sourceKind: "demo" },
    { calibration: null },
    { sourceKind: "demo", calibration: null },
  ])
    assert.throws(() => validateCase({ ...fixture(), ...override }), {
      status: 400,
    });
  const payload = fixture();
  payload.sourceKind = "video";
  assert.doesNotThrow(() => validateCase(payload));
});
test("stored traces survive reopen and review and participate in immutable event identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-speed-trace-"));
  let store = createStore(directory);
  const payload = fixture();
  try {
    const checked = validateCase(payload);
    const saved = store.create(checked).case;
    assert.deepEqual(saved.speedMeasurement, checked.record.speedMeasurement);
    assert.equal(store.create(validateCase(payload)).duplicate, true);
    const translated = structuredClone(payload);
    translated.speedMeasurement.samples.forEach((sample) => {
      sample.imagePoint.x += 0.1;
    });
    assert.throws(() => store.create(validateCase(translated)), /already used/);
    assert.throws(
      () => store.create(validateCase({ ...payload, speedMeasurement: null })),
      /already used/,
    );
    assert.throws(
      () =>
        validateReview({
          state: "dismissed",
          reviewer: "Alex",
          speedMeasurement: null,
        }),
      /Unexpected field/,
    );
    store.close();
    store = createStore(directory);
    assert.deepEqual(
      store.get(saved.id).speedMeasurement,
      checked.record.speedMeasurement,
    );
    const reviewed = store.review(
      saved.id,
      validateReview({ state: "dismissed", reviewer: "Alex" }),
    );
    assert.deepEqual(
      reviewed.speedMeasurement,
      checked.record.speedMeasurement,
    );
    const database = new DatabaseSync(join(directory, "velocity.sqlite"));
    try {
      assert.throws(
        () =>
          database.exec(
            "UPDATE cases SET record_json = json_remove(record_json, '$.speedMeasurement')",
          ),
        /immutable|review is final/,
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("legacy absent and explicit-null traces preserve byte-identical immutable JSON and fingerprints", () => {
  const directory = mkdtempSync(join(tmpdir(), "velocity-legacy-speed-"));
  let store = createStore(directory);
  const payload = fixture();
  delete payload.speedMeasurement;
  try {
    const legacy = validateCase(payload),
      explicitNull = validateCase({ ...payload, speedMeasurement: null });
    assert.equal(Object.hasOwn(legacy.record, "speedMeasurement"), false);
    assert.deepEqual(explicitNull.record, legacy.record);
    assert.equal(explicitNull.fingerprint, legacy.fingerprint);
    const saved = store.create(legacy).case;
    assert.equal(saved.speedMeasurement, null);
    store.close();
    store = createStore(directory);
    assert.equal(store.get(saved.id).speedMeasurement, null);
    assert.equal(store.create(explicitNull).duplicate, true);
    assert.equal(store.create(validateCase(payload)).duplicate, true);
    const database = new DatabaseSync(join(directory, "velocity.sqlite"));
    try {
      const row = database
        .prepare("SELECT record_json, fingerprint FROM cases WHERE id = ?")
        .get(saved.id);
      assert.equal(row.record_json, JSON.stringify(legacy.record));
      assert.equal(row.fingerprint, legacy.fingerprint);
    } finally {
      database.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
