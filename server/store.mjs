import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { HttpError } from "./validation.mjs";
export function createStore(dataDirectory) {
  const directory = resolve(dataDirectory);
  const evidenceDirectory = join(directory, "evidence");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "velocity.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS case_sequences (year INTEGER PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cases (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      client_event_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      record_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'approved', 'dismissed')) DEFAULT 'draft',
      plate TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', reviewer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES cases(id),
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS cases_immutable BEFORE UPDATE ON cases
      WHEN OLD.id IS NOT NEW.id OR OLD.sequence IS NOT NEW.sequence OR OLD.client_event_id IS NOT NEW.client_event_id
        OR OLD.fingerprint IS NOT NEW.fingerprint OR OLD.record_json IS NOT NEW.record_json OR OLD.created_at IS NOT NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'Case measurements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS cases_review_once BEFORE UPDATE ON cases
      WHEN OLD.state != 'draft' OR NEW.state NOT IN ('approved', 'dismissed')
      BEGIN SELECT RAISE(ABORT, 'Case review is final'); END;
    CREATE TRIGGER IF NOT EXISTS cases_no_delete BEFORE DELETE ON cases
      BEGIN SELECT RAISE(ABORT, 'Cases cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
      BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
      BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
  `);
  const serialize = (row) =>
    row
      ? {
          id: row.id,
          vehicleBox: null,
          speedMeasurement: null,
          ...JSON.parse(row.record_json),
          state: row.state,
          plate: row.plate,
          notes: row.notes,
          reviewer: row.reviewer,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          evidenceUrl: `/api/cases/${row.id}/evidence`,
        }
      : null;
  const lookup = (id) => db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
  const appendAudit = (id, action, actor, details, now) =>
    db
      .prepare(
        "INSERT INTO audit (case_id, timestamp, action, actor, details_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, now, action, actor, JSON.stringify(details));
  return {
    list(limit = 500) {
      return {
        cases: db
          .prepare("SELECT * FROM cases ORDER BY sequence DESC LIMIT ?")
          .all(limit)
          .map(serialize),
        total: db.prepare("SELECT COUNT(*) AS total FROM cases").get().total,
      };
    },
    get(id) {
      return serialize(lookup(id));
    },
    create({ record, evidence, fingerprint }) {
      const existing = db
        .prepare("SELECT * FROM cases WHERE client_event_id = ?")
        .get(record.clientEventId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "clientEventId is already used for different evidence or measurements.",
          );
        return { case: serialize(existing), duplicate: true };
      }
      const now = new Date().toISOString(),
        year = new Date(now).getUTCFullYear();
      let temporaryPath, evidencePath;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO case_sequences (year, value) VALUES (?, 1) ON CONFLICT(year) DO UPDATE SET value = value + 1",
        ).run(year);
        const sequence = db
          .prepare("SELECT value FROM case_sequences WHERE year = ?")
          .get(year).value;
        const id = `VEL-${year}-${String(sequence).padStart(6, "0")}`;
        evidencePath = join(evidenceDirectory, `${id}.jpg`);
        temporaryPath = join(evidenceDirectory, `${id}-${randomUUID()}.tmp`);
        const fd = openSync(temporaryPath, "wx", 0o600);
        try {
          writeFileSync(fd, evidence);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporaryPath, evidencePath);
        temporaryPath = undefined;
        db.prepare(
          "INSERT INTO cases (id, client_event_id, fingerprint, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          record.clientEventId,
          fingerprint,
          JSON.stringify(record),
          now,
          now,
        );
        appendAudit(
          id,
          "created",
          "system",
          {
            state: "draft",
            simulation: record.simulation,
            evidenceSha256: record.evidenceSha256,
            clientEventId: record.clientEventId,
          },
          now,
        );
        db.exec("COMMIT");
        return { case: serialize(lookup(id)), duplicate: false };
      } catch (error) {
        db.exec("ROLLBACK");
        for (const path of [temporaryPath, evidencePath])
          if (path) {
            try {
              unlinkSync(path);
            } catch {}
          }
        throw error;
      }
    },
    review(id, review) {
      const existing = lookup(id);
      if (!existing) throw new HttpError(404, "Case not found.");
      if (existing.state !== "draft")
        throw new HttpError(
          409,
          "This case has already been reviewed. Its review is final.",
        );
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE cases SET state = ?, plate = ?, notes = ?, reviewer = ?, updated_at = ? WHERE id = ? AND state = ?",
        ).run(
          review.state,
          review.plate,
          review.notes,
          review.reviewer,
          now,
          id,
          "draft",
        );
        appendAudit(
          id,
          "reviewed",
          review.reviewer,
          { previousState: "draft", ...review },
          now,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return serialize(lookup(id));
    },
    evidence(id) {
      const record = serialize(lookup(id));
      if (!record) throw new HttpError(404, "Case not found.");
      let bytes;
      try {
        bytes = readFileSync(join(evidenceDirectory, `${record.id}.jpg`));
      } catch {
        throw new HttpError(500, "The stored evidence file is unavailable.");
      }
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        record.evidenceSha256
      )
        throw new HttpError(
          409,
          "The stored evidence failed its integrity check.",
        );
      return bytes;
    },
    audit(limit = 500, caseId = null) {
      const rows = caseId
        ? db
            .prepare(
              "SELECT * FROM audit WHERE case_id = ? ORDER BY id DESC LIMIT ?",
            )
            .all(caseId, limit)
        : db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
      return rows.map((row) => ({
        id: row.id,
        caseId: row.case_id,
        timestamp: row.timestamp,
        action: row.action,
        actor: row.actor,
        details: JSON.parse(row.details_json),
      }));
    },
    close() {
      db.close();
    },
  };
}
