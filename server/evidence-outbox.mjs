import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpError, MAX_BODY_BYTES, validateCase } from "./validation.mjs";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MOTOR = new Set(["car", "truck", "bus", "motorcycle"]);
const READ_COLUMNS = `sequence, schema_version, session_id, event_id,
  CASE WHEN length(CAST(payload_json AS BLOB)) <= ${MAX_BODY_BYTES}
    THEN payload_json ELSE NULL END AS payload_json,
  payload_bytes, payload_sha256, evidence_sha256, fingerprint`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const invalid = () =>
  new HttpError(
    400,
    "Invalid pending evidence payload or session identity. Recheck the captured event before retrying.",
  );
const conflict = () =>
  new HttpError(
    409,
    "This pending event already contains different evidence or measurements. Preserve the original capture.",
  );
const corrupt = () =>
  new HttpError(
    409,
    "Saved pending evidence failed its integrity checks. The entry has been retained; inspect or restore a verified copy of the outbox before retrying.",
  );
const unavailable = () =>
  new HttpError(
    503,
    "The durable evidence outbox could not complete this operation. Keep the service running, check local storage, and retry saving.",
  );
function validIdentity(sessionId, record) {
  return (
    typeof sessionId === "string" &&
    UUID.test(sessionId) &&
    Number.isSafeInteger(record?.trackId) &&
    record.trackId >= 0 &&
    record.clientEventId === `${sessionId}:${record.trackId}`
  );
}
function validBackgroundCapture(record) {
  return (
    record.sourceKind === "camera" &&
    record.simulation === false &&
    MOTOR.has(record.className) &&
    record.calibration != null &&
    record.speedMeasurement != null
  );
}
function canonicalPayload({ record, evidence }) {
  const {
    simulation: _simulation,
    evidenceSha256: _hash,
    evidenceBytes: _bytes,
    ...payload
  } = record;
  return JSON.stringify({
    ...payload,
    evidence: `data:image/jpeg;base64,${evidence.toString("base64")}`,
  });
}
export function createEvidenceOutbox(
  dataDirectory,
  { maxCount = 200, maxBytes = 64 * 1024 * 1024 } = {},
) {
  if (
    !Number.isSafeInteger(maxCount) ||
    maxCount < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new HttpError(
      400,
      "Evidence outbox capacity must use positive integer limits.",
    );
  let db;
  try {
    const directory = resolve(dataDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(join(directory, "evidence-outbox.sqlite"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS evidence_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        payload_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );
    `);
    if (
      db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal" ||
      db.prepare("PRAGMA synchronous").get().synchronous !== 2
    )
      throw new Error("Required durability mode unavailable");
  } catch {
    try {
      db?.close();
    } catch {}
    throw unavailable();
  }
  let closed = false;
  const protect = (operation) => {
    if (closed) throw unavailable();
    try {
      return operation();
    } catch (error) {
      throw error instanceof HttpError ? error : unavailable();
    }
  };
  const transaction = (operation) =>
    protect(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    });
  const lookup = (eventId) =>
    db
      .prepare(`SELECT ${READ_COLUMNS} FROM evidence_outbox WHERE event_id = ?`)
      .get(eventId);
  const totals = () => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS pending, COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes FROM evidence_outbox",
      )
      .get();
    return { pending: row.pending, bytes: row.bytes };
  };
  const read = (row) => {
    try {
      if (
        !row ||
        row.schema_version !== 1 ||
        typeof row.payload_json !== "string" ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 1 ||
        !Number.isSafeInteger(row.payload_bytes) ||
        row.payload_bytes < 1 ||
        row.payload_bytes !== Buffer.byteLength(row.payload_json, "utf8") ||
        !SHA256.test(row.payload_sha256) ||
        !SHA256.test(row.fingerprint) ||
        !SHA256.test(row.evidence_sha256) ||
        hash(row.payload_json) !== row.payload_sha256
      )
        throw new Error("Invalid metadata");
      const payload = JSON.parse(row.payload_json);
      const value = validateCase(payload);
      if (
        !validIdentity(row.session_id, value.record) ||
        !validBackgroundCapture(value.record) ||
        payload.clientEventId !== row.event_id ||
        value.record.clientEventId !== row.event_id ||
        value.fingerprint !== row.fingerprint ||
        value.record.evidenceSha256 !== row.evidence_sha256 ||
        canonicalPayload(value) !== row.payload_json
      )
        throw new Error("Invalid identity or canonical evidence");
      return { sessionId: row.session_id, eventId: row.event_id, value };
    } catch {
      throw corrupt();
    }
  };
  return {
    enqueue(sessionId, rawCasePayload) {
      let value;
      try {
        value = validateCase(rawCasePayload);
        if (
          !validIdentity(sessionId, value.record) ||
          !validBackgroundCapture(value.record) ||
          rawCasePayload.clientEventId !== value.record.clientEventId
        )
          throw invalid();
      } catch (error) {
        if (error instanceof HttpError && error.status === 413)
          throw new HttpError(
            413,
            "Pending JPEG evidence exceeds the allowed capture size.",
          );
        throw invalid();
      }
      const json = canonicalPayload(value);
      const bytes = Buffer.byteLength(json, "utf8");
      return transaction(() => {
        const existing = lookup(value.record.clientEventId);
        if (existing) {
          const saved = read(existing);
          if (saved.value.fingerprint !== value.fingerprint) throw conflict();
          return saved.value;
        }
        const usage = totals();
        if (usage.pending >= maxCount || bytes > maxBytes - usage.bytes)
          throw new HttpError(
            503,
            "The durable evidence outbox is full. Save pending captures before continuing; no existing capture was removed.",
          );
        db.prepare(
          "INSERT INTO evidence_outbox (schema_version, session_id, event_id, payload_json, payload_bytes, payload_sha256, evidence_sha256, fingerprint) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          sessionId,
          value.record.clientEventId,
          json,
          bytes,
          hash(json),
          value.record.evidenceSha256,
          value.fingerprint,
        );
        return read(lookup(value.record.clientEventId)).value;
      });
    },
    peek() {
      return protect(() => {
        const row = db
          .prepare(
            `SELECT ${READ_COLUMNS} FROM evidence_outbox ORDER BY sequence LIMIT 1`,
          )
          .get();
        return row ? read(row) : null;
      });
    },
    acknowledge(eventId, fingerprint) {
      if (
        typeof eventId !== "string" ||
        eventId.length > 180 ||
        typeof fingerprint !== "string" ||
        !SHA256.test(fingerprint)
      )
        throw invalid();
      return transaction(() => {
        const row = lookup(eventId);
        if (!row) return false;
        const saved = read(row);
        if (saved.value.fingerprint !== fingerprint) throw conflict();
        const deleted = db
          .prepare(
            "DELETE FROM evidence_outbox WHERE event_id = ? AND fingerprint = ?",
          )
          .run(eventId, fingerprint);
        if (deleted.changes !== 1) throw unavailable();
        return true;
      });
    },
    summary() {
      return protect(totals);
    },
    close() {
      if (closed) return;
      protect(() => db.close());
      closed = true;
    },
  };
}
