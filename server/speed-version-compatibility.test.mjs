import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { validateCase, validateCaseSpeedMeasurement } from "./validation.mjs";
import { createStore } from "./store.mjs";
import { createEvidenceOutbox } from "./evidence-outbox.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const { calculateSpeedMeasurement } = await loadVisionShared();
const V2 = "ground-plane-median-v2";
const V3 = "ground-plane-geometric-median-v3";
const SESSION_ID = "7e7a3a73-6973-4f14-b4f3-86d9f1a8b1df";
const JPEG = "data:image/jpeg;base64,/9j/4AAC/9k=";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const V2_RECORD_JSON =
  '{"clientEventId":"7e7a3a73-6973-4f14-b4f3-86d9f1a8b1df:7","trackId":7,"sourceName":"Version fixture","sourceKind":"camera","className":"car","speedKmh":70.43591129530446,"speedLimit":20,"confidence":0.9,"captureTime":"2026-10-02T18:00:00.000Z","sourceTimestamp":1,"calibration":{"points":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1},{"x":0,"y":1}],"widthMeters":20,"lengthMeters":100},"simulation":false,"evidenceSha256":"499af7b940c9579b2062696bdabd7b849ac18c9246e6f5abf6c5a52d4de43850","evidenceBytes":8,"speedMeasurement":{"method":"ground-plane-median-v2","samples":[{"timeSeconds":0,"imagePoint":{"x":0.2,"y":0.2}},{"timeSeconds":0.25,"imagePoint":{"x":0.22,"y":0.25}},{"timeSeconds":0.5,"imagePoint":{"x":0.24,"y":0.29}},{"timeSeconds":0.75,"imagePoint":{"x":0.255,"y":0.365}},{"timeSeconds":1,"imagePoint":{"x":0.29,"y":0.39}}],"velocityMps":{"x":1.6000000000000005,"y":19.5},"speedKmh":70.43591129530446,"pairCount":10}}';
const V2_FINGERPRINT =
  "5b42a9f20083183bcd5aeaec52959e4f4b197b642765558e2b0638036442e5b8";
function legacyPayload() {
  const { simulation, evidenceSha256, evidenceBytes, ...payload } =
    JSON.parse(V2_RECORD_JSON);
  return { ...payload, evidence: JPEG };
}
function payloadFor(method) {
  const payload = legacyPayload();
  if (method === V2) return payload;
  const xs = [0.2, 0.27, 0.35, 0.48, 0.57],
    ys = [0.2, 0.21, 0.235, 0.24, 0.255];
  const samples = xs.map((x, index) => ({
    timeSeconds: index * 0.25,
    imagePoint: { x, y: ys[index] },
  }));
  const measurement = calculateSpeedMeasurement(
    samples,
    payload.calibration,
    method,
  );
  assert.equal(
    measurement?.method,
    method,
    "The shared server bundle must support the requested estimator version.",
  );
  return {
    ...payload,
    speedKmh: measurement.speedKmh,
    speedMeasurement: measurement,
  };
}
function directory(t) {
  const value = mkdtempSync(join(tmpdir(), "velocity speed versions "));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}
function fileSnapshot(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name),
        key = `${prefix}${entry.name}`;
      return entry.isDirectory()
        ? fileSnapshot(path, `${key}/`)
        : [[key, hash(readFileSync(path))]];
    });
}
test("released noisy v2 trace preserves exact canonical JSON and immutable fingerprint", () => {
  const expected = JSON.parse(V2_RECORD_JSON),
    payload = legacyPayload();
  assert.equal(hash(V2_RECORD_JSON), V2_FINGERPRINT);
  const replay = calculateSpeedMeasurement(
    payload.speedMeasurement.samples,
    payload.calibration,
    V2,
  );
  assert.deepEqual(replay, expected.speedMeasurement);
  const checked = validateCase(payload);
  assert.equal(JSON.stringify(checked.record), V2_RECORD_JSON);
  assert.equal(checked.fingerprint, V2_FINGERPRINT);
  assert.deepEqual(
    validateCaseSpeedMeasurement(expected),
    expected.speedMeasurement,
  );
});
test("a method-only relabel cannot reinterpret a noisy trace as the other estimator", () => {
  const current = payloadFor(V3);
  const legacyMeasurement = calculateSpeedMeasurement(
    current.speedMeasurement.samples,
    current.calibration,
    V2,
  );
  const legacy = {
    ...current,
    speedKmh: legacyMeasurement.speedKmh,
    speedMeasurement: legacyMeasurement,
  };
  assert.notDeepEqual(
    legacy.speedMeasurement.velocityMps,
    current.speedMeasurement.velocityMps,
  );
  assert.ok(
    Math.abs(legacy.speedKmh - current.speedKmh) > 1e-5,
    "Fixture must distinguish the estimators beyond validation tolerance.",
  );
  assert.notEqual(
    validateCase(legacy).fingerprint,
    validateCase(current).fingerprint,
  );
  for (const [payload, otherMethod] of [
    [legacy, V3],
    [current, V2],
  ]) {
    const changed = structuredClone(payload);
    changed.speedMeasurement.method = otherMethod;
    assert.throws(() => validateCase(changed), { status: 400 });
    assert.throws(() => validateCaseSpeedMeasurement(changed), { status: 400 });
  }
});
test("a pre-upgrade v2 outbox row replays and acknowledges its original fingerprint", (t) => {
  const path = directory(t),
    baseline = JSON.parse(V2_RECORD_JSON);
  let outbox = createEvidenceOutbox(path),
    store;
  try {
    outbox.close();
    const db = new DatabaseSync(join(path, "evidence-outbox.sqlite"));
    try {
      const json = JSON.stringify(legacyPayload());
      db.prepare(
        "INSERT INTO evidence_outbox (schema_version, session_id, event_id, payload_json, payload_bytes, payload_sha256, evidence_sha256, fingerprint) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        SESSION_ID,
        baseline.clientEventId,
        json,
        Buffer.byteLength(json),
        hash(json),
        baseline.evidenceSha256,
        V2_FINGERPRINT,
      );
    } finally {
      db.close();
    }
    outbox = createEvidenceOutbox(path);
    const recovered = outbox.peek();
    assert.equal(JSON.stringify(recovered.value.record), V2_RECORD_JSON);
    assert.equal(recovered.value.fingerprint, V2_FINGERPRINT);
    store = createStore(path);
    const saved = store.create(recovered.value);
    assert.deepEqual(store.evidence(saved.case.id), recovered.value.evidence);
    assert.equal(outbox.acknowledge(recovered.eventId, V2_FINGERPRINT), true);
    assert.equal(outbox.peek(), null);
  } finally {
    outbox.close();
    store?.close();
  }
});
for (const method of [V2, V3]) {
  test(`${method} survives outbox reopen, idempotent store recovery and final acknowledgement`, (t) => {
    const path = directory(t),
      payload = payloadFor(method),
      expected = validateCase(payload);
    let outbox = createEvidenceOutbox(path),
      store = createStore(path);
    try {
      const queued = outbox.enqueue(SESSION_ID, payload);
      assert.equal(queued.fingerprint, expected.fingerprint);
      const first = store.create(queued);
      const firstId = first.case.id;
      assert.equal(first.duplicate, false);
      outbox.close();
      store.close();
      outbox = createEvidenceOutbox(path);
      store = createStore(path);
      const replay = outbox.peek();
      assert.equal(replay.value.fingerprint, expected.fingerprint);
      assert.deepEqual(
        replay.value.record.speedMeasurement,
        expected.record.speedMeasurement,
      );
      const duplicate = store.create(replay.value);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.case.id, firstId);
      assert.equal(store.list().total, 1);
      assert.equal(store.audit().length, 1);
      assert.deepEqual(store.evidence(firstId), replay.value.evidence);
      assert.equal(
        outbox.acknowledge(replay.eventId, replay.value.fingerprint),
        true,
      );
      assert.equal(outbox.summary().pending, 0);
      assert.equal(outbox.peek(), null);
    } finally {
      outbox.close();
      store.close();
    }
  });
  test(`${method} exported case verifies offline without file writes and rejects a relabeled method`, (t) => {
    const path = directory(t),
      store = createStore(path);
    let saved;
    try {
      saved = store.create(validateCase(payloadFor(method))).case;
    } finally {
      store.close();
    }
    const casePath = join(path, `${saved.id}.json`);
    writeFileSync(casePath, JSON.stringify(saved, null, 2));
    const before = fileSnapshot(path);
    const script = fileURLToPath(
      new URL("../scripts/verify-case-speed.mjs", import.meta.url),
    );
    const run = () =>
      spawnSync(process.execPath, [script, casePath], {
        cwd: path,
        encoding: "utf8",
        timeout: 10000,
      });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.method, method);
    assert.equal(report.reconstructedSpeedKmh, saved.speedMeasurement.speedKmh);
    assert.deepEqual(report.velocityMps, saved.speedMeasurement.velocityMps);
    assert.equal(report.sampleCount, 5);
    assert.equal(report.pairCount, 10);
    assert.equal(report.mediaInterval.spanSeconds, 1);
    assert.match(
      report.limitation,
      /does not establish physical speed accuracy/,
    );
    assert.deepEqual(fileSnapshot(path), before);
    saved.speedMeasurement.method = method === V2 ? V3 : V2;
    writeFileSync(casePath, JSON.stringify(saved));
    const tamperedBefore = fileSnapshot(path),
      rejected = run();
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.match(
      rejected.stderr,
      /Speed verification failed: speedMeasurement/,
    );
    assert.deepEqual(fileSnapshot(path), tamperedBefore);
  });
}
