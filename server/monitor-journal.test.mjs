import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createMonitorJournal } from "./monitor-journal.mjs";
const at = "2026-10-02T20:00:00.000Z";
const endedAt = "2026-10-02T20:01:00.000Z";
function status(id = randomUUID()) {
  return {
    sessionId: id,
    state: "running",
    message: "Continuous camera analysis.",
    sourceName: "Cinderford Triangle · Nest",
    sourceType: "nest",
    startedAt: at,
    lastFrameAt: "2026-10-02T20:00:12.000Z",
    engine: { name: "YOLOX-S", provider: "dml", warnings: [] },
    config: {
      revision: 1,
      speedLimitKmh: 60,
      calibration: null,
      countingLine: { a: { x: 0.04, y: 0.55 }, b: { x: 0.28, y: 0.55 } },
      referenceFrame: { width: 1280, height: 720 },
    },
    stats: {
      observed: 8,
      active: 2,
      framesProcessed: 112,
      framesDropped: 3,
      analysisFps: 9.8,
      casesCreated: 0,
      pendingCases: 0,
      elapsedSeconds: 12.3,
      gapCount: 1,
      crossings: {
        total: 6,
        forward: 1,
        reverse: 5,
        classes: { car: 4, truck: 1, bus: 0, motorcycle: 1, bicycle: 0 },
      },
    },
    error: null,
  };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "velocity-journal-"));
  const connections = [];
  const open = () => {
    const journal = createMonitorJournal(directory);
    connections.push(journal);
    return journal;
  };
  t.after(() => {
    for (const journal of connections) {
      try {
        journal.close();
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, journal: open() };
}
function terminal(value) {
  const next = structuredClone(value);
  next.state = "stopped";
  next.stats.active = 0;
  next.stats.analysisFps = 0;
  return next;
}
test("reopened journal retains current totals and separate, nonadditive configuration snapshots", (t) => {
  const { journal, open, directory } = fixture(t);
  const live = status();
  const first = journal.checkpoint(live, { reason: "crossing" });
  live.stats.crossings.total++;
  live.stats.crossings.reverse++;
  live.stats.crossings.classes.car++;
  live.stats.framesProcessed += 10;
  live.stats.elapsedSeconds++;
  const latestFirst = journal.checkpoint(live, { reason: "configuration" });
  live.config.revision++;
  live.config.countingLine = { a: { x: 0.1, y: 0.6 }, b: { x: 0.8, y: 0.6 } };
  live.config.speedLimitKmh = 50;
  live.stats.crossings = {
    total: 0,
    forward: 0,
    reverse: 0,
    classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
  };
  journal.checkpoint(live, { reason: "configuration" });
  live.stats.crossings.total = 2;
  live.stats.crossings.reverse = 2;
  live.stats.crossings.classes.car = 2;
  const saved = journal.checkpoint(terminal(live), {
    reason: "ended",
    endedAt,
  });
  journal.close();
  const reopened = open(),
    detail = reopened.get(live.sessionId);
  assert.deepEqual(detail.session, saved);
  assert.deepEqual(
    detail.revisions.map((row) => [
      row.config.revision,
      row.stats.crossings.total,
    ]),
    [
      [1, 7],
      [2, 2],
    ],
  );
  assert.deepEqual(detail.revisions[0], latestFirst);
  assert.equal(detail.session.sequence, first.sequence);
  assert.equal(detail.session.stats.crossings.total, 2);
  assert.deepEqual(reopened.history(), {
    sessions: [saved],
    total: 1,
    nextCursor: null,
  });
  assert.equal(
    readdirSync(directory).some((name) => name === "monitor-history.sqlite"),
    true,
  );
});
test("committed checkpoint survives process exit without an explicit database close", (t) => {
  const { directory, journal } = fixture(t);
  const live = status();
  journal.close();
  const program = `import { createMonitorJournal } from ${JSON.stringify(new URL("./monitor-journal.mjs", import.meta.url).href)};
    createMonitorJournal(${JSON.stringify(directory)}).checkpoint(${JSON.stringify(live)}, {reason:"periodic"}); process.exit(0);`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const reopened = createMonitorJournal(directory);
  try {
    assert.deepEqual(reopened.get(live.sessionId).session.stats, {
      ...live.stats,
    });
    assert.equal(reopened.get(live.sessionId).session.interrupted, false);
  } finally {
    reopened.close();
  }
});
test("only explicit recovery finalizes unfinished sessions, preserving their last saved observations", (t) => {
  const { journal, open } = fixture(t);
  const live = status(),
    done = terminal(status());
  live.stats.pendingCases = 2;
  const saved = journal.checkpoint(live, { reason: "periodic" });
  const closed = journal.checkpoint(done, { reason: "ended", endedAt });
  journal.close();
  const reopened = open();
  assert.deepEqual(reopened.get(live.sessionId).session, saved);
  const before = Date.now(),
    recovered = reopened.recoverInterruptedSessions(),
    after = Date.now();
  assert.equal(recovered.length, 1);
  const row = recovered[0];
  assert.equal(row.state, "stopped");
  assert.equal(row.interrupted, true);
  assert.equal(row.reason, "interrupted");
  assert.equal(
    row.message,
    "Service stopped before this session was closed. Counts cover saved observations only.",
  );
  assert.equal(row.lastFrameAt, saved.lastFrameAt);
  assert.deepEqual(row.config, saved.config);
  assert.deepEqual(row.stats, { ...saved.stats, active: 0, analysisFps: 0 });
  assert.ok(
    Date.parse(row.endedAt) >= before && Date.parse(row.endedAt) <= after,
  );
  assert.deepEqual(reopened.get(done.sessionId).session, closed);
  assert.deepEqual(reopened.get(live.sessionId).revisions, [row]);
  assert.deepEqual(reopened.recoverInterruptedSessions(), []);
  assert.throws(() => reopened.checkpoint(live, { reason: "periodic" }), {
    status: 409,
  });
});
test("explicit allowlist omits raw camera data, errors, images, tracks and engine warnings", (t) => {
  const { journal, directory } = fixture(t);
  const live = status();
  const secret = "TEST_CAMERA_SECRET_91";
  const url = `rtsp://user:${secret}@camera.invalid/live`;
  live.camera = { url, username: "user", password: secret };
  live.message = `Failed ${url}`;
  live.error = `Decoder ${url}`;
  live.jpeg = `data:image/jpeg;base64,${secret}`;
  live.tracks = [{ plate: secret }];
  live.engine.warnings = [`Failed opening ${url}`];
  live.engine.rawError = url;
  live.stats.pendingHistory = true;
  live.stats.cameraUrl = url;
  const saved = journal.checkpoint(live, { reason: "periodic" });
  assert.equal(saved.error, null);
  assert.deepEqual(saved.engine, { name: "YOLOX-S", provider: "dml" });
  assert.equal("pendingHistory" in saved.stats, false);
  assert.equal("camera" in saved, false);
  assert.equal("tracks" in saved, false);
  assert.equal("jpeg" in saved, false);
  assert.ok(!JSON.stringify(journal.get(live.sessionId)).includes(secret));
  for (const name of readdirSync(directory)) {
    assert.equal(
      readFileSync(join(directory, name)).includes(Buffer.from(secret)),
      false,
      name,
    );
    assert.equal(
      readFileSync(join(directory, name)).includes(
        Buffer.from("camera.invalid"),
      ),
      false,
      name,
    );
  }
});
test("unsafe labels and malformed UUIDs cannot smuggle URLs into durable fields or errors", (t) => {
  const { journal } = fixture(t);
  for (const mutate of [
    (s) => {
      s.sourceName = "rtsp://user:secret@camera.invalid";
    },
    (s) => {
      s.sourceType = "https://camera.invalid";
    },
    (s) => {
      s.engine.provider = "user:secret@camera.invalid";
    },
    (s) => {
      s.engine.name = "data:image/jpeg;base64,secret";
    },
    (s) => {
      s.sourceName = "Camera\nsecret";
    },
    (s) => {
      s.sessionId = "secret";
    },
  ]) {
    const live = status();
    mutate(live);
    assert.throws(
      () => journal.checkpoint(live, { reason: "periodic" }),
      (error) => error.status === 400 && !error.message.includes("secret"),
    );
  }
  assert.equal(journal.history().total, 0);
});
test("invalid counters, class totals and configuration are atomically rejected", (t) => {
  const { journal } = fixture(t),
    live = status();
  const saved = journal.checkpoint(live, { reason: "periodic" });
  for (const mutate of [
    (s) => {
      s.stats.gapCount = NaN;
    },
    (s) => {
      s.stats.framesProcessed = 1.5;
    },
    (s) => {
      s.stats.elapsedSeconds = -1;
    },
    (s) => {
      s.stats.crossings.total++;
    },
    (s) => {
      s.stats.crossings.classes.bus++;
    },
    (s) => {
      delete s.stats.crossings.classes.car;
    },
    (s) => {
      s.stats.crossings.classes.person = 1;
    },
    (s) => {
      s.stats.active = 999;
    },
    (s) => {
      s.stats.observed = 1;
    },
    (s) => {
      s.config.speedLimitKmh = 0;
    },
    (s) => {
      s.config.revision = 1.5;
    },
    (s) => {
      s.config.countingLine.b = { ...s.config.countingLine.a };
    },
    (s) => {
      s.config.countingLine.a.x = Infinity;
    },
    (s) => {
      s.config.referenceFrame = null;
    },
    (s) => {
      s.config.referenceFrame.width = 0;
    },
    (s) => {
      s.config.url = "rtsp://camera.invalid";
    },
    (s) => {
      s.config.calibration = {
        points: Array(4).fill({ x: 0, y: 0 }),
        widthMeters: 3,
        lengthMeters: 10,
      };
    },
    (s) => {
      s.lastFrameAt = "2026-02-30T00:00:00.000Z";
    },
  ]) {
    const bad = structuredClone(live);
    bad.config.revision++;
    mutate(bad);
    assert.throws(() => journal.checkpoint(bad, { reason: "configuration" }), {
      status: 400,
    });
    assert.deepEqual(journal.get(live.sessionId), {
      session: saved,
      revisions: [saved],
    });
  }
});
test("configuration revisions and session observations never move backward", (t) => {
  const { journal } = fixture(t),
    live = status();
  live.config.revision = 2;
  const saved = journal.checkpoint(live, { reason: "periodic" });
  for (const mutate of [
    (s) => {
      s.config.revision--;
    },
    (s) => {
      s.config.speedLimitKmh++;
    },
    (s) => {
      s.config.referenceFrame.width++;
    },
    (s) => {
      s.stats.framesDropped--;
    },
    (s) => {
      s.stats.observed--;
    },
    (s) => {
      s.stats.elapsedSeconds--;
    },
    (s) => {
      s.sourceName = "Another camera";
    },
    (s) => {
      s.startedAt = endedAt;
    },
    (s) => {
      s.stats.crossings.total--;
      s.stats.crossings.reverse--;
      s.stats.crossings.classes.car--;
    },
  ]) {
    const bad = structuredClone(live);
    mutate(bad);
    assert.throws(() => journal.checkpoint(bad, { reason: "periodic" }), {
      status: 409,
    });
    assert.deepEqual(journal.get(live.sessionId).session, saved);
  }
});
test("terminal summaries are immutable except exact retries or bounded evidence retry bookkeeping", (t) => {
  const { journal } = fixture(t),
    done = terminal(status());
  done.stats.pendingCases = 3;
  done.state = "error";
  const saved = journal.checkpoint(done, { reason: "ended", endedAt });
  assert.deepEqual(
    journal.checkpoint(done, { reason: "ended", endedAt }),
    saved,
  );
  for (const mutate of [
    (s) => {
      s.stats.framesProcessed++;
    },
    (s) => {
      s.stats.crossings.total++;
      s.stats.crossings.reverse++;
      s.stats.crossings.classes.car++;
    },
    (s) => {
      s.config.revision++;
    },
    (s) => {
      s.lastFrameAt = endedAt;
    },
    (s) => {
      s.stats.elapsedSeconds++;
    },
    (s) => {
      s.stats.casesCreated = 2;
      s.stats.pendingCases = 2;
    },
    (s) => {
      s.stats.pendingCases++;
    },
  ]) {
    const bad = structuredClone(done);
    mutate(bad);
    assert.throws(() => journal.checkpoint(bad, { reason: "retry", endedAt }), {
      status: 409,
    });
    assert.deepEqual(journal.get(done.sessionId).session, saved);
  }
  done.stats.casesCreated = 2;
  done.stats.pendingCases = 0;
  assert.throws(() => journal.checkpoint(done, { reason: "ended", endedAt }), {
    status: 409,
  });
  const retried = journal.checkpoint(done, { reason: "retry", endedAt });
  assert.equal(retried.stats.casesCreated, 2);
  assert.equal(retried.stats.pendingCases, 0);
  assert.equal(retried.endedAt, saved.endedAt);
  assert.deepEqual(journal.get(done.sessionId).revisions, [retried]);
  assert.deepEqual(
    journal.checkpoint(done, { reason: "retry", endedAt }),
    retried,
  );
});
test("terminal state and end time must agree and cannot retain active analysis", (t) => {
  const { journal } = fixture(t);
  assert.throws(
    () => journal.checkpoint(status(), { reason: "ended", endedAt }),
    { status: 400 },
  );
  assert.throws(
    () => journal.checkpoint(terminal(status()), { reason: "ended" }),
    { status: 400 },
  );
  const bad = terminal(status());
  bad.stats.active = 1;
  assert.throws(() => journal.checkpoint(bad, { reason: "ended", endedAt }), {
    status: 400,
  });
  assert.equal(journal.history().total, 0);
});
test("SQL failure between session and revision writes rolls back both tables", (t) => {
  const { journal, directory } = fixture(t),
    live = status();
  const saved = journal.checkpoint(live, { reason: "periodic" });
  const db = new DatabaseSync(join(directory, "monitor-history.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER fail_revision BEFORE INSERT ON monitor_revisions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
    );
    live.config.revision++;
    assert.throws(
      () => journal.checkpoint(live, { reason: "configuration" }),
      /fixture failure/,
    );
    assert.deepEqual(journal.get(live.sessionId), {
      session: saved,
      revisions: [saved],
    });
    assert.throws(
      () => journal.checkpoint(status(), { reason: "started" }),
      /fixture failure/,
    );
    assert.equal(journal.history().total, 1);
  } finally {
    db.close();
  }
});
test("pagination uses stable session creation sequence despite checkpoint updates", (t) => {
  const { journal } = fixture(t);
  const all = [];
  for (let i = 0; i < 5; i++)
    all.push(journal.checkpoint(status(), { reason: "started" }));
  journal.checkpoint(all[0], { reason: "periodic" });
  const first = journal.history({ limit: 2 });
  assert.deepEqual(
    first.sessions.map((row) => row.sequence),
    [5, 4],
  );
  assert.equal(first.total, 5);
  assert.equal(first.nextCursor, 4);
  const second = journal.history({ limit: 2, before: first.nextCursor });
  assert.deepEqual(
    second.sessions.map((row) => row.sequence),
    [3, 2],
  );
  const third = journal.history({ limit: 2, before: second.nextCursor });
  assert.deepEqual(
    third.sessions.map((row) => row.sequence),
    [1],
  );
  assert.equal(third.nextCursor, null);
  assert.deepEqual(journal.history({ before: 1 }), {
    sessions: [],
    total: 5,
    nextCursor: null,
  });
  assert.equal(journal.get(randomUUID()), null);
  assert.equal(journal.get("not-a-uuid"), null);
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { limit: 2.5 },
    { before: 0 },
    { before: "2" },
    { before: Infinity },
  ])
    assert.throws(() => journal.history(options), { status: 400 });
});
test("saved and returned records are detached from mutable caller data", (t) => {
  const { journal } = fixture(t),
    live = status();
  const saved = journal.checkpoint(live, { reason: "periodic" });
  const expected = structuredClone(saved);
  live.stats.crossings.classes.car = 999;
  live.config.countingLine.a.x = 1;
  saved.stats.crossings.total = 999;
  const read = journal.get(live.sessionId);
  assert.deepEqual(read.session, expected);
  read.revisions[0].config.speedLimitKmh = 999;
  assert.deepEqual(journal.get(live.sessionId).session, expected);
});
