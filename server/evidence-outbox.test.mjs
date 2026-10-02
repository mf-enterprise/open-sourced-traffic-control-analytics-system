import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createEvidenceOutbox } from "./evidence-outbox.mjs";
import { createStore } from "./store.mjs";
import { validateCase } from "./validation.mjs";
const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function payload(sessionId, trackId = 7) {
  return {
    clientEventId: `${sessionId}:${trackId}`,
    trackId,
    sourceName: "Road camera",
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
      samples: [0, 1, 2, 3].map((index) => ({
        timeSeconds: 10 + index * 0.25,
        imagePoint: { x: 0.5, y: 0.2 + index * 0.05 },
      })),
      velocityMps: { x: 0, y: 20 },
      speedKmh: 72,
      pairCount: 6,
    },
    evidence: `data:image/jpeg;base64,${image.toString("base64")}`,
  };
}
function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "velocity-outbox-"));
  const openHandles = [];
  const open = (overrides = options) => {
    const outbox = createEvidenceOutbox(directory, overrides);
    openHandles.push(outbox);
    return outbox;
  };
  t.after(() => {
    for (const handle of openHandles) {
      try {
        handle.close();
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, outbox: open() };
}
const hasStatus = (status) => (error) => error.status === status;
test("committed captures reopen in FIFO order with exact validated evidence and no input/return aliases", (t) => {
  const { outbox, open } = fixture(t);
  const id = randomUUID(),
    otherId = randomUUID();
  const raw = payload(id),
    expected = validateCase(structuredClone(raw));
  const returned = outbox.enqueue(id, raw);
  outbox.enqueue(otherId, payload(otherId, 1));
  raw.calibration.points[0].x = 0.9;
  raw.speedMeasurement.samples[0].imagePoint.x = 0.2;
  raw.evidence = "changed";
  returned.record.sourceName = "changed";
  returned.record.speedMeasurement.samples[0].timeSeconds = 20;
  returned.evidence.fill(0);
  assert.deepEqual(outbox.peek(), {
    sessionId: id,
    eventId: expected.record.clientEventId,
    value: expected,
  });
  const firstRead = outbox.peek();
  firstRead.value.record.calibration.points[0].x = 0.2;
  firstRead.value.evidence.fill(1);
  const before = outbox.summary();
  assert.equal(before.pending, 2);
  assert.ok(before.bytes > image.length * 2);
  outbox.close();
  const reopened = open();
  assert.deepEqual(reopened.peek().value, expected);
  assert.deepEqual(reopened.summary(), before);
  assert.equal(
    reopened.acknowledge(expected.record.clientEventId, expected.fingerprint),
    true,
  );
  assert.equal(reopened.peek().sessionId, otherId);
});
test("same canonical fingerprint is idempotent even at capacity; changed event payload is rejected", (t) => {
  const { outbox } = fixture(t, { maxCount: 1 });
  const id = randomUUID(),
    raw = payload(id);
  const saved = outbox.enqueue(id, raw),
    before = outbox.summary();
  const normalizedEquivalent = {
    ...raw,
    sourceName: "  Road camera  ",
    captureTime: "2026-10-02T16:00:00+01:00",
  };
  assert.deepEqual(outbox.enqueue(id, normalizedEquivalent), saved);
  assert.deepEqual(outbox.summary(), before);
  assert.throws(
    () => outbox.enqueue(id, { ...raw, speedLimit: 55 }),
    hasStatus(409),
  );
  assert.deepEqual(outbox.peek().value, saved);
});
test("acknowledgement requires the exact fingerprint and is harmless after committed removal", (t) => {
  const { outbox, open } = fixture(t);
  const id = randomUUID(),
    raw = payload(id),
    saved = outbox.enqueue(id, raw);
  assert.throws(
    () => outbox.acknowledge(raw.clientEventId, "0".repeat(64)),
    hasStatus(409),
  );
  assert.equal(outbox.summary().pending, 1);
  assert.throws(
    () => outbox.acknowledge(raw.clientEventId, "secret"),
    hasStatus(400),
  );
  assert.equal(outbox.acknowledge(raw.clientEventId, saved.fingerprint), true);
  outbox.close();
  const reopened = open();
  assert.equal(
    reopened.acknowledge(raw.clientEventId, saved.fingerprint),
    false,
  );
  assert.equal(reopened.peek(), null);
  assert.deepEqual(reopened.summary(), { pending: 0, bytes: 0 });
});
test("count and actual UTF-8 payload-byte limits never evict an earlier capture", (t) => {
  const { outbox, open } = fixture(t, { maxCount: 1 });
  const id = randomUUID(),
    saved = outbox.enqueue(id, payload(id));
  const bytes = outbox.summary().bytes;
  assert.throws(() => outbox.enqueue(id, payload(id, 8)), hasStatus(503));
  assert.deepEqual(outbox.peek().value, saved);
  outbox.close();
  const byteLimited = open({ maxCount: 10, maxBytes: bytes });
  assert.deepEqual(byteLimited.enqueue(id, payload(id)), saved);
  assert.throws(() => byteLimited.enqueue(id, payload(id, 9)), hasStatus(503));
  assert.equal(byteLimited.summary().bytes, bytes);
  byteLimited.acknowledge(saved.record.clientEventId, saved.fingerprint);
  const unicode = payload(id, 8);
  unicode.sourceName = "路".repeat(250);
  assert.throws(() => byteLimited.enqueue(id, unicode), hasStatus(503));
  assert.equal(byteLimited.peek(), null);
});
test("session/track identity and unknown fields are rejected without persisting or leaking credentials", (t) => {
  const { outbox, directory } = fixture(t);
  const id = randomUUID();
  const secret = "rtsp://username:password@private.invalid";
  for (const [sessionId, body] of [
    [secret, payload(id)],
    [randomUUID(), payload(id)],
    [id, { ...payload(id), clientEventId: `${id}:8` }],
    [id, { ...payload(id), clientEventId: ` ${id}:7 ` }],
    [id, { ...payload(id), [secret]: "unexpected credential field" }],
    [id, { ...payload(id), sourceTimestamp: NaN }],
    [id, { ...payload(id), evidence: secret }],
  ]) {
    assert.throws(
      () => outbox.enqueue(sessionId, body),
      (error) =>
        error.status === 400 &&
        !error.message.includes("password") &&
        !error.message.includes("private.invalid"),
    );
  }
  assert.deepEqual(outbox.summary(), { pending: 0, bytes: 0 });
  for (const file of readdirSync(directory))
    assert.equal(
      readFileSync(join(directory, file)).includes(Buffer.from(secret)),
      false,
    );
});
test("new outbox accepts only measured background-camera motor-vehicle captures", (t) => {
  const { outbox } = fixture(t);
  const id = randomUUID();
  for (const change of [
    { sourceKind: "video" },
    { sourceKind: "demo", calibration: null, speedMeasurement: null },
    { speedMeasurement: null },
    { speedMeasurement: undefined },
    { className: "person" },
    { className: "bicycle" },
  ])
    assert.throws(
      () => outbox.enqueue(id, { ...payload(id), ...change }),
      hasStatus(400),
    );
  assert.equal(outbox.summary().pending, 0);
  for (const [index, className] of [
    "car",
    "truck",
    "bus",
    "motorcycle",
  ].entries())
    assert.equal(
      outbox.enqueue(id, { ...payload(id, index), className }).record.className,
      className,
    );
});
test("SQLite uses WAL; failed transaction insertion leaves no partial queued event", (t) => {
  const { outbox, directory } = fixture(t);
  const raw = new DatabaseSync(join(directory, "evidence-outbox.sqlite"));
  try {
    assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    raw.exec(
      "CREATE TRIGGER reject_insert BEFORE INSERT ON evidence_outbox BEGIN SELECT RAISE(ABORT, 'rtsp://user:secret@camera.invalid'); END;",
    );
    const id = randomUUID();
    assert.throws(
      () => outbox.enqueue(id, payload(id)),
      (error) =>
        error.status === 503 &&
        !error.message.includes("secret") &&
        !error.message.includes("camera.invalid"),
    );
    assert.deepEqual(outbox.summary(), { pending: 0, bytes: 0 });
    raw.exec("DROP TRIGGER reject_insert");
    assert.equal(
      outbox.enqueue(id, payload(id)).record.clientEventId,
      `${id}:7`,
    );
  } finally {
    raw.close();
  }
});
for (const [name, damage] of [
  [
    "payload hash",
    (db) =>
      db.exec(
        "UPDATE evidence_outbox SET payload_sha256 = '" + "0".repeat(64) + "'",
      ),
  ],
  [
    "fingerprint",
    (db) =>
      db.exec(
        "UPDATE evidence_outbox SET fingerprint = '" + "0".repeat(64) + "'",
      ),
  ],
  [
    "evidence hash",
    (db) =>
      db.exec(
        "UPDATE evidence_outbox SET evidence_sha256 = '" + "0".repeat(64) + "'",
      ),
  ],
  [
    "byte metadata",
    (db) => db.exec("UPDATE evidence_outbox SET payload_bytes = 1"),
  ],
  [
    "session identity",
    (db) =>
      db.prepare("UPDATE evidence_outbox SET session_id = ?").run(randomUUID()),
  ],
  [
    "event identity",
    (db) =>
      db
        .prepare("UPDATE evidence_outbox SET event_id = ?")
        .run(`${randomUUID()}:7`),
  ],
  [
    "future schema version",
    (db) => db.exec("UPDATE evidence_outbox SET schema_version = 2"),
  ],
  [
    "malformed JSON with matching payload hash",
    (db) => {
      const json = '{"rtsp://user:secret@camera.invalid":';
      db.prepare(
        "UPDATE evidence_outbox SET payload_json = ?, payload_bytes = ?, payload_sha256 = ?",
      ).run(json, Buffer.byteLength(json), hash(json));
    },
  ],
  [
    "changed evidence despite updated payload hash",
    (db) => {
      const body = JSON.parse(
        db.prepare("SELECT payload_json FROM evidence_outbox").get()
          .payload_json,
      );
      const changed = Buffer.from(image);
      changed[5] = 3;
      body.evidence = `data:image/jpeg;base64,${changed.toString("base64")}`;
      const json = JSON.stringify(body);
      db.prepare(
        "UPDATE evidence_outbox SET payload_json = ?, payload_bytes = ?, payload_sha256 = ?",
      ).run(json, Buffer.byteLength(json), hash(json));
    },
  ],
  [
    "invalid case despite updated payload hash",
    (db) => {
      const body = JSON.parse(
        db.prepare("SELECT payload_json FROM evidence_outbox").get()
          .payload_json,
      );
      body.speedLimit = 500;
      const json = JSON.stringify(body);
      db.prepare(
        "UPDATE evidence_outbox SET payload_json = ?, payload_bytes = ?, payload_sha256 = ?",
      ).run(json, Buffer.byteLength(json), hash(json));
    },
  ],
  [
    "non-background case despite recomputed hashes",
    (db) => {
      const body = JSON.parse(
        db.prepare("SELECT payload_json FROM evidence_outbox").get()
          .payload_json,
      );
      body.sourceKind = "video";
      const value = validateCase(body),
        json = JSON.stringify(body);
      db.prepare(
        "UPDATE evidence_outbox SET payload_json = ?, payload_bytes = ?, payload_sha256 = ?, fingerprint = ?",
      ).run(json, Buffer.byteLength(json), hash(json), value.fingerprint);
    },
  ],
  [
    "oversized payload",
    (db) => {
      const json = " ".repeat(5 * 1024 * 1024 + 1);
      db.prepare(
        "UPDATE evidence_outbox SET payload_json = ?, payload_bytes = ?, payload_sha256 = ?",
      ).run(json, Buffer.byteLength(json), hash(json));
    },
  ],
])
  test(`corrupt ${name} blocks replay and deletion while retaining the queued row`, (t) => {
    const { outbox, directory } = fixture(t);
    const id = randomUUID(),
      body = payload(id),
      saved = outbox.enqueue(id, body);
    const db = new DatabaseSync(join(directory, "evidence-outbox.sqlite"));
    try {
      damage(db);
      const row = db.prepare("SELECT * FROM evidence_outbox").get();
      const rejectCorrupt = (error) =>
        error.status === 409 &&
        /integrity/.test(error.message) &&
        !error.message.includes("secret") &&
        !error.message.includes("camera.invalid");
      assert.throws(() => outbox.peek(), rejectCorrupt);
      assert.throws(
        () => outbox.acknowledge(row.event_id, saved.fingerprint),
        rejectCorrupt,
      );
      if (row.event_id === body.clientEventId)
        assert.throws(() => outbox.enqueue(id, body), rejectCorrupt);
      assert.deepEqual(db.prepare("SELECT * FROM evidence_outbox").get(), row);
      assert.equal(outbox.summary().pending, 1);
    } finally {
      db.close();
    }
  });
test("abrupt child termination after enqueue commit survives reopen without orderly close", (t) => {
  const { outbox, open, directory } = fixture(t);
  outbox.close();
  const id = randomUUID(),
    body = payload(id);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { writeSync } from 'node:fs';
    import { createEvidenceOutbox } from ${JSON.stringify(new URL("./evidence-outbox.mjs", import.meta.url).href)};
    const outbox = createEvidenceOutbox(${JSON.stringify(directory)});
    outbox.enqueue(${JSON.stringify(id)}, ${JSON.stringify(body)});
    writeSync(1, 'ENQUEUE_COMMITTED\\n');
    process.kill(process.pid, 'SIGKILL');
  `,
    ],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  assert.equal(child.error, undefined);
  assert.match(child.stdout, /ENQUEUE_COMMITTED/);
  assert.notEqual(child.status, 0);
  assert.deepEqual(open().peek().value, validateCase(body));
});
test("crash after case creation before acknowledgement replays once and verifies the existing JPEG before removal", (t) => {
  const { outbox, open, directory } = fixture(t);
  outbox.close();
  const id = randomUUID(),
    body = payload(id);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { writeSync } from 'node:fs';
    import { createEvidenceOutbox } from ${JSON.stringify(new URL("./evidence-outbox.mjs", import.meta.url).href)};
    import { createStore } from ${JSON.stringify(new URL("./store.mjs", import.meta.url).href)};
    const outbox = createEvidenceOutbox(${JSON.stringify(directory)});
    const value = outbox.enqueue(${JSON.stringify(id)}, ${JSON.stringify(body)});
    const store = createStore(${JSON.stringify(directory)});
    store.create(value);
    writeSync(1, 'CASE_COMMITTED\\n');
    process.kill(process.pid, 'SIGKILL');
  `,
    ],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  assert.equal(child.error, undefined);
  assert.match(child.stdout, /CASE_COMMITTED/);
  assert.notEqual(child.status, 0);
  const recovered = open(),
    pending = recovered.peek(),
    store = createStore(directory);
  try {
    const result = store.create(pending.value);
    assert.equal(result.duplicate, true);
    assert.equal(store.list().total, 1);
    assert.deepEqual(store.evidence(result.case.id), pending.value.evidence);
    assert.equal(
      recovered.acknowledge(pending.eventId, pending.value.fingerprint),
      true,
    );
    recovered.close();
    assert.deepEqual(open().summary(), { pending: 0, bytes: 0 });
  } finally {
    store.close();
  }
});
test("closed outbox rejects operations with sanitized actionable errors", (t) => {
  const { outbox } = fixture(t);
  outbox.close();
  assert.throws(() => outbox.peek(), hasStatus(503));
  assert.throws(() => outbox.summary(), hasStatus(503));
  assert.doesNotThrow(() => outbox.close());
});
