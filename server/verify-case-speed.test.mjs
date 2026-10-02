import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createStore } from "./store.mjs";
import { validateCase } from "./validation.mjs";
const script = fileURLToPath(
  new URL("../scripts/verify-case-speed.mjs", import.meta.url),
);
const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "velocity speed cli "));
  const store = createStore(directory);
  const saved = store.create(
    validateCase({
      clientEventId: "cli-speed-test:1",
      trackId: 1,
      sourceName: "CLI fixture",
      sourceKind: "camera",
      className: "car",
      speedKmh: 72,
      speedLimit: 50,
      confidence: 0.9,
      captureTime: "2026-10-02T18:00:00.000Z",
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
    }),
  ).case;
  store.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, `${saved.id}.json`);
  const write = (value) => writeFileSync(path, JSON.stringify(value, null, 2));
  write(saved);
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...(args.length ? args : [path])], {
      encoding: "utf8",
      timeout: 10000,
      cwd: directory,
    });
  return { directory, path, saved, write, run };
}
test("standalone CLI reconstructs an actual exported store record without writing or needing a service", (t) => {
  const { directory, path, run } = fixture(t);
  const before = readFileSync(path);
  const files = readdirSync(directory);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, "numerically-consistent");
  assert.equal(report.method, "ground-plane-median-v2");
  assert.ok(Math.abs(report.reconstructedSpeedKmh - 72) < 1e-10);
  assert.equal(report.recordedSpeedKmh, 72);
  assert.equal(report.sampleCount, 4);
  assert.equal(report.pairCount, 6);
  assert.deepEqual(report.mediaInterval, {
    startSeconds: 10,
    endSeconds: 10.75,
    spanSeconds: 0.75,
    evidenceFrameSeconds: 10.75,
    finalSampleLagSeconds: 0,
  });
  assert.match(report.limitation, /does not establish physical speed accuracy/);
  assert.match(report.limitation, /not cryptographically authenticated/);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(directory), files);
});
test("standalone CLI fails nonzero for changed measurements, calibration or frame timestamp", (t) => {
  const { saved, write, run } = fixture(t);
  for (const mutate of [
    (s) => {
      s.speedKmh++;
    },
    (s) => {
      s.speedMeasurement.velocityMps.y++;
    },
    (s) => {
      s.speedMeasurement.samples[3].imagePoint.y += 0.1;
    },
    (s) => {
      s.calibration.lengthMeters *= 2;
    },
    (s) => {
      s.sourceTimestamp += 1;
    },
    (s) => {
      s.speedMeasurement.samples[2].timeSeconds = 10.1;
    },
  ]) {
    const changed = structuredClone(saved);
    mutate(changed);
    write(changed);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Speed verification failed:/);
  }
});
test("standalone CLI clearly rejects legacy, simulated, malformed and incorrectly wrapped exports", (t) => {
  const { saved, write, run, path } = fixture(t);
  for (const changed of [
    { ...saved, speedMeasurement: null },
    { ...saved, speedMeasurement: undefined },
    { ...saved, simulation: true },
    { ...saved, sourceKind: "demo" },
    { case: saved },
    { cases: [saved] },
    [saved],
  ]) {
    write(changed);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Speed verification failed:/);
  }
  writeFileSync(path, "{ malformed");
  assert.match(run().stderr, /not valid JSON/);
  assert.equal(run("--help").status, 0);
  assert.equal(run(path, "extra").status, 1);
  assert.equal(run(join(path, "missing.json")).status, 1);
});
