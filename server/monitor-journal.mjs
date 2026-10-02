import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpError } from "./validation.mjs";
const STATES = new Set([
  "starting",
  "running",
  "stalled",
  "reconnecting",
  "stopping",
  "stopped",
  "error",
]);
const CLASSES = ["car", "truck", "bus", "motorcycle", "bicycle"];
const COUNTERS = [
  "observed",
  "active",
  "framesProcessed",
  "framesDropped",
  "casesCreated",
  "pendingCases",
  "gapCount",
];
const CUMULATIVE = [
  "observed",
  "framesProcessed",
  "framesDropped",
  "casesCreated",
  "gapCount",
  "elapsedSeconds",
];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGES = {
  starting: "Camera analysis was starting at the last saved observation.",
  running: "Camera analysis was running at the last saved observation.",
  stalled:
    "Camera analysis was waiting for fresh video at the last saved observation.",
  reconnecting:
    "The camera connection was being restored at the last saved observation.",
  stopping: "Camera analysis was stopping at the last saved observation.",
  stopped: "Camera analysis stopped. Counts cover saved observations only.",
  error:
    "Camera analysis stopped after an error. Counts cover saved observations only.",
};
const INTERRUPTED =
  "Service stopped before this session was closed. Counts cover saved observations only.";
function invalid() {
  throw new HttpError(400, "Invalid monitoring history checkpoint.");
}
function conflict() {
  throw new HttpError(
    409,
    "Monitoring history cannot replace an earlier configuration or finalized observations.",
  );
}
function object(value, allowed = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key)))
    invalid();
  return value;
}
function number(
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  integer = false,
) {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    invalid();
  return value;
}
function safeText(value, max) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]|[a-z][a-z\d+.-]*:\/\/|(?:data|blob):|[^\s:]+:[^\s@]+@/iu.test(
      value,
    )
  )
    invalid();
  return value.trim();
}
function date(value, nullable = false) {
  if (value === null && nullable) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid();
  return value;
}
function point(value) {
  object(value, ["x", "y"]);
  return { x: number(value.x, 0, 1), y: number(value.y, 0, 1) };
}
function calibration(value) {
  if (value === null) return null;
  object(value, ["points", "widthMeters", "lengthMeters"]);
  if (!Array.isArray(value.points) || value.points.length !== 4) invalid();
  const points = Array.from(value.points, point);
  const turns = points.map((a, i) => {
    const b = points[(i + 1) % 4],
      c = points[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  const twiceArea = Math.abs(
    points.reduce((sum, a, i) => {
      const b = points[(i + 1) % 4];
      return sum + a.x * b.y - a.y * b.x;
    }, 0),
  );
  if (
    turns.some((turn) => Math.abs(turn) < 1e-9) ||
    !turns.every((turn) => Math.sign(turn) === Math.sign(turns[0])) ||
    twiceArea < 0.002
  )
    invalid();
  return {
    points,
    widthMeters: number(value.widthMeters, 0.1, 10000),
    lengthMeters: number(value.lengthMeters, 0.1, 10000),
  };
}
function config(value) {
  object(value, [
    "revision",
    "speedLimitKmh",
    "calibration",
    "countingLine",
    "referenceFrame",
  ]);
  let countingLine = null,
    referenceFrame = null;
  if (value.countingLine !== null) {
    object(value.countingLine, ["a", "b"]);
    countingLine = {
      a: point(value.countingLine.a),
      b: point(value.countingLine.b),
    };
    if (
      Math.hypot(
        countingLine.b.x - countingLine.a.x,
        countingLine.b.y - countingLine.a.y,
      ) +
        1e-10 <
      0.05
    )
      invalid();
  }
  if (value.referenceFrame !== null) {
    object(value.referenceFrame, ["width", "height"]);
    referenceFrame = {
      width: number(value.referenceFrame.width, 1, 16384, true),
      height: number(value.referenceFrame.height, 1, 16384, true),
    };
  }
  const result = {
    revision: number(value.revision, 1, Number.MAX_SAFE_INTEGER, true),
    speedLimitKmh: number(value.speedLimitKmh, 1, 500),
    calibration: calibration(value.calibration),
    countingLine,
    referenceFrame,
  };
  if ((result.calibration || result.countingLine) && !referenceFrame) invalid();
  return result;
}
function stats(value) {
  object(value);
  object(value.crossings, ["total", "forward", "reverse", "classes"]);
  object(value.crossings.classes, CLASSES);
  const classes = Object.fromEntries(
    CLASSES.map((name) => [
      name,
      number(value.crossings.classes[name], 0, Number.MAX_SAFE_INTEGER, true),
    ]),
  );
  const crossings = {
    total: number(value.crossings.total, 0, Number.MAX_SAFE_INTEGER, true),
    forward: number(value.crossings.forward, 0, Number.MAX_SAFE_INTEGER, true),
    reverse: number(value.crossings.reverse, 0, Number.MAX_SAFE_INTEGER, true),
    classes,
  };
  if (
    crossings.forward + crossings.reverse !== crossings.total ||
    Object.values(classes).reduce((sum, count) => sum + count, 0) !==
      crossings.total
  )
    invalid();
  const result = Object.fromEntries(
    COUNTERS.map((key) => [
      key,
      number(value[key], 0, Number.MAX_SAFE_INTEGER, true),
    ]),
  );
  result.analysisFps = number(value.analysisFps, 0, 10000);
  result.elapsedSeconds = number(value.elapsedSeconds);
  result.crossings = crossings;
  if (result.active > result.observed || crossings.total > result.observed)
    invalid();
  return result;
}
function sanitize(value) {
  object(value);
  if (
    typeof value.sessionId !== "string" ||
    !UUID.test(value.sessionId) ||
    !STATES.has(value.state)
  )
    invalid();
  let engine = null;
  if (value.engine !== null) {
    object(value.engine);
    engine = {
      name: safeText(value.engine.name, 120),
      provider: safeText(value.engine.provider, 80),
    };
  }
  return {
    sessionId: value.sessionId.toLowerCase(),
    state: value.state,
    message: MESSAGES[value.state],
    sourceName:
      value.sourceName === null ? null : safeText(value.sourceName, 80),
    sourceType:
      value.sourceType === null ? null : safeText(value.sourceType, 32),
    startedAt: date(value.startedAt),
    lastFrameAt: date(value.lastFrameAt, true),
    engine,
    config: config(value.config),
    stats: stats(value.stats),
    error: null,
  };
}
function read(row) {
  if (!row) return null;
  return {
    ...JSON.parse(row.status_json),
    savedAt: row.saved_at,
    endedAt: row.ended_at,
    interrupted: Boolean(row.interrupted),
    sequence: row.sequence,
    reason: row.reason,
  };
}
export function createMonitorJournal(dataDirectory) {
  const directory = resolve(dataDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "monitor-history.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS monitor_sessions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      status_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      ended_at TEXT,
      interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1)),
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitor_revisions (
      session_id TEXT NOT NULL REFERENCES monitor_sessions(session_id),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      status_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      ended_at TEXT,
      interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1)),
      reason TEXT NOT NULL,
      PRIMARY KEY (session_id, revision)
    );
  `);
  const lookup = db.prepare(
    "SELECT * FROM monitor_sessions WHERE session_id = ?",
  );
  const insert = db.prepare(
    "INSERT INTO monitor_sessions (session_id, status_json, saved_at, ended_at, interrupted, reason) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE monitor_sessions SET status_json = ?, saved_at = ?, ended_at = ?, interrupted = ?, reason = ? WHERE session_id = ?",
  );
  const revision =
    db.prepare(`INSERT INTO monitor_revisions (session_id, revision, status_json, saved_at, ended_at, interrupted, reason) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, revision) DO UPDATE SET status_json = excluded.status_json, saved_at = excluded.saved_at, ended_at = excluded.ended_at, interrupted = excluded.interrupted, reason = excluded.reason`);
  const revisions = db.prepare(
    "SELECT r.*, s.sequence FROM monitor_revisions r JOIN monitor_sessions s USING (session_id) WHERE r.session_id = ? ORDER BY r.revision ASC",
  );
  const latest = db.prepare(
    "SELECT * FROM monitor_sessions ORDER BY sequence DESC LIMIT ?",
  );
  const older = db.prepare(
    "SELECT * FROM monitor_sessions WHERE sequence < ? ORDER BY sequence DESC LIMIT ?",
  );
  const total = db.prepare("SELECT COUNT(*) AS total FROM monitor_sessions");
  const unfinished = db.prepare(
    "SELECT * FROM monitor_sessions WHERE ended_at IS NULL ORDER BY sequence ASC",
  );
  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function write(status, savedAt, endedAt, interrupted, reason, existing) {
    const json = JSON.stringify(status);
    if (existing)
      update.run(
        json,
        savedAt,
        endedAt,
        Number(interrupted),
        reason,
        status.sessionId,
      );
    else
      insert.run(
        status.sessionId,
        json,
        savedAt,
        endedAt,
        Number(interrupted),
        reason,
      );
    revision.run(
      status.sessionId,
      status.config.revision,
      json,
      savedAt,
      endedAt,
      Number(interrupted),
      reason,
    );
    return read(lookup.get(status.sessionId));
  }
  return {
    checkpoint(value, { reason, endedAt = null } = {}) {
      const status = sanitize(value);
      if (typeof reason !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(reason))
        invalid();
      date(endedAt, true);
      if (
        (status.state === "stopped" || status.state === "error") !==
        (endedAt !== null)
      )
        invalid();
      if (
        endedAt !== null &&
        (status.stats.active !== 0 || status.stats.analysisFps !== 0)
      )
        invalid();
      return transaction(() => {
        const row = lookup.get(status.sessionId),
          previous = read(row);
        if (previous) {
          const prior = JSON.parse(row.status_json);
          if (previous.endedAt !== null) {
            if (
              row.status_json === JSON.stringify(status) &&
              previous.endedAt === endedAt &&
              previous.reason === reason
            )
              return previous;
            const comparable = structuredClone(status);
            comparable.stats.casesCreated = prior.stats.casesCreated;
            comparable.stats.pendingCases = prior.stats.pendingCases;
            const added = status.stats.casesCreated - prior.stats.casesCreated;
            const removed =
              prior.stats.pendingCases - status.stats.pendingCases;
            if (
              reason !== "retry" ||
              previous.interrupted ||
              previous.endedAt !== endedAt ||
              JSON.stringify(comparable) !== row.status_json ||
              added < 0 ||
              removed < 0 ||
              added > removed
            )
              conflict();
          } else {
            if (
              status.startedAt !== prior.startedAt ||
              status.sourceName !== prior.sourceName ||
              status.sourceType !== prior.sourceType ||
              status.config.revision < prior.config.revision ||
              CUMULATIVE.some((key) => status.stats[key] < prior.stats[key])
            )
              conflict();
            if (status.config.revision === prior.config.revision) {
              if (
                JSON.stringify(status.config) !==
                  JSON.stringify(prior.config) ||
                ["total", "forward", "reverse"].some(
                  (key) =>
                    status.stats.crossings[key] < prior.stats.crossings[key],
                ) ||
                CLASSES.some(
                  (key) =>
                    status.stats.crossings.classes[key] <
                    prior.stats.crossings.classes[key],
                )
              )
                conflict();
            }
          }
        }
        return write(
          status,
          new Date().toISOString(),
          endedAt,
          false,
          reason,
          row,
        );
      });
    },
    recoverInterruptedSessions() {
      return transaction(() => {
        const recoveredAt = new Date().toISOString();
        return unfinished.all().map((row) => {
          const status = JSON.parse(row.status_json);
          status.state = "stopped";
          status.message = INTERRUPTED;
          status.stats.active = 0;
          status.stats.analysisFps = 0;
          status.error = null;
          return write(
            status,
            recoveredAt,
            recoveredAt,
            true,
            "interrupted",
            row,
          );
        });
      });
    },
    history({ limit = 20, before = null } = {}) {
      number(limit, 1, 100, true);
      if (before !== null) number(before, 1, Number.MAX_SAFE_INTEGER, true);
      const rows =
        before === null ? latest.all(limit + 1) : older.all(before, limit + 1);
      const sessions = rows.slice(0, limit).map(read);
      return {
        sessions,
        total: total.get().total,
        nextCursor: rows.length > limit ? sessions.at(-1).sequence : null,
      };
    },
    get(sessionId) {
      if (typeof sessionId !== "string" || !UUID.test(sessionId)) return null;
      const id = sessionId.toLowerCase(),
        session = read(lookup.get(id));
      return session
        ? { session, revisions: revisions.all(id).map(read) }
        : null;
    },
    close() {
      db.close();
    },
  };
}
