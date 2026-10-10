/**
 * SQLite connection and schema.
 * OWNER: Developer 4.
 *
 * Two processes share the database: the MCP server (launched by WorkBuddy)
 * and the local approval server (started by the student). WAL mode plus a
 * busy timeout lets them read and write concurrently.
 */
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { ensureDir, getPaths } from "./paths.js";

export type Db = BetterSqlite3.Database;

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- Every call to an investigation tool, exactly as executed.
CREATE TABLE IF NOT EXISTS investigations (
  id          TEXT PRIMARY KEY,
  tool        TEXT NOT NULL CHECK (tool IN ('check_internship_risk','verify_company','check_student_eligibility')),
  input_json  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('success','partial','error')),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shortlists (
  id             TEXT PRIMARY KEY,
  request_hash   TEXT NOT NULL UNIQUE,
  student_json   TEXT NOT NULL,
  max_shortlisted INTEGER NOT NULL,
  result_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS internship_cases (
  id                          TEXT PRIMARY KEY,
  shortlist_id                TEXT NOT NULL REFERENCES shortlists(id),
  listing_ref                 TEXT NOT NULL,
  url                         TEXT NOT NULL,
  apply_url                   TEXT,
  title                       TEXT,
  company_name                TEXT,
  access_status               TEXT NOT NULL,
  risk_investigation_id       TEXT REFERENCES investigations(id),
  company_investigation_id    TEXT REFERENCES investigations(id),
  eligibility_investigation_id TEXT REFERENCES investigations(id),
  decision                    TEXT NOT NULL CHECK (decision IN ('shortlisted','not_selected','rejected','insufficient_evidence')),
  rank                        INTEGER,
  score                       REAL,
  evaluation_json             TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE (shortlist_id, listing_ref)
);

-- At most one application per case: repeated requests cannot duplicate it.
CREATE TABLE IF NOT EXISTS applications (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL UNIQUE REFERENCES internship_cases(id),
  status              TEXT NOT NULL CHECK (status IN ('PREPARED','AWAITING_APPROVAL','REJECTED_BY_STUDENT','READY_TO_SUBMIT','MANUAL_ACTION_REQUIRED','SUBMITTED')),
  apply_url           TEXT,
  export_dir          TEXT,
  submitted_at        TEXT,
  submission_evidence TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Immutable package versions. Content never changes after insert.
CREATE TABLE IF NOT EXISTS application_packages (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id),
  version           INTEGER NOT NULL,
  content_json      TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  review_flags_json TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  superseded_at     TEXT,
  UNIQUE (application_id, version)
);

-- One human decision per package version, bound to that version's hash.
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  package_id   TEXT NOT NULL UNIQUE REFERENCES application_packages(id),
  content_hash TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_via  TEXT NOT NULL,
  note         TEXT,
  decided_at   TEXT NOT NULL
);

-- One export per approved package version.
CREATE TABLE IF NOT EXISTS exports (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL UNIQUE REFERENCES application_packages(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  directory   TEXT NOT NULL,
  files_json  TEXT NOT NULL,
  exported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL,
  description    TEXT NOT NULL,
  due_date       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('open','done')),
  created_at     TEXT NOT NULL,
  UNIQUE (application_id, kind)
);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES applications(id),
  event          TEXT NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  detail_json    TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_shortlist ON internship_cases(shortlist_id);
CREATE INDEX IF NOT EXISTS idx_packages_app ON application_packages(application_id);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(application_id);
`;

const connections = new Map<string, Db>();

/** Open (or reuse) the database for the current INTERNGUARD_DATA_DIR. Throws a clear error if unavailable. */
export function getDb(): Db {
  const { dataDir, databaseFile } = getPaths();
  const existing = connections.get(databaseFile);
  if (existing?.open) return existing;

  let Database: typeof BetterSqlite3;
  try {
    const require = createRequire(import.meta.url);
    Database = require("better-sqlite3") as typeof BetterSqlite3;
  } catch (err) {
    throw new Error(
      `SQLite is unavailable: could not load better-sqlite3 (${err instanceof Error ? err.message : String(err)}). Run "npm install" on this machine.`,
    );
  }

  ensureDir(dataDir);
  const db = new Database(databaseFile);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  else if (row.version > SCHEMA_VERSION) {
    throw new Error(`Database schema v${row.version} is newer than this code (v${SCHEMA_VERSION}).`);
  }
  connections.set(databaseFile, db);
  return db;
}

/** Close all connections (tests, shutdown). */
export function closeAllDbs(): void {
  for (const db of connections.values()) if (db.open) db.close();
  connections.clear();
}

/** Non-throwing health check for hello_internguard. */
export function databaseHealth(): { database: "ok" | "unavailable"; detail: string } {
  try {
    getDb().prepare("SELECT 1").get();
    return { database: "ok", detail: getPaths().databaseFile };
  } catch (err) {
    return { database: "unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
}
