/**
 * Data access for the execution layer.
 * OWNER: Developer 4.
 *
 * All identifiers are generated here (prefix + crypto.randomUUID()).
 * Status changes go through transition(), which checks the current status
 * inside a transaction so stale or repeated requests cannot skip states.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ApplicationId,
  ApplicationPackContent,
  ApplicationStatus,
  CaseId,
  ExportedFile,
  InvestigationId,
  InvestigationToolName,
  ListingEvaluation,
  PackageId,
  ReviewFlag,
  ShortlistData,
  ShortlistId,
  StudentProfile,
  ToolResult,
} from "../shared/types.js";
import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// ids, time, hashing
// ---------------------------------------------------------------------------

export const ID_PATTERNS = {
  investigation: /^inv_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  shortlist: /^sl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  case: /^case_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  application: /^app_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  package: /^pkg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
} as const;

export function newId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The approval binds to this hash: case + exact content. */
export function packageHash(caseId: string, content: ApplicationPackContent): string {
  return sha256(canonicalJson({ caseId, content }));
}

// ---------------------------------------------------------------------------
// investigations
// ---------------------------------------------------------------------------

export interface StoredInvestigation {
  id: InvestigationId;
  tool: InvestigationToolName;
  input: unknown;
  result: ToolResult<unknown>;
  createdAt: string;
}

export function recordInvestigation(tool: InvestigationToolName, input: unknown, result: ToolResult<unknown>): InvestigationId {
  const id = newId("inv");
  getDb()
    .prepare("INSERT INTO investigations (id, tool, input_json, result_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, tool, JSON.stringify(input), JSON.stringify(result), result.status, nowIso());
  return id;
}

export function getInvestigation(id: string): StoredInvestigation | null {
  if (!ID_PATTERNS.investigation.test(id)) return null;
  const row = getDb().prepare("SELECT * FROM investigations WHERE id = ?").get(id) as
    | { id: InvestigationId; tool: InvestigationToolName; input_json: string; result_json: string; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    tool: row.tool,
    input: JSON.parse(row.input_json) as unknown,
    result: JSON.parse(row.result_json) as ToolResult<unknown>,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// shortlists and cases
// ---------------------------------------------------------------------------

export function findShortlistByRequestHash(hash: string): ShortlistData | null {
  const row = getDb().prepare("SELECT result_json FROM shortlists WHERE request_hash = ?").get(hash) as
    | { result_json: string }
    | undefined;
  return row ? (JSON.parse(row.result_json) as ShortlistData) : null;
}

export interface CaseRecordInput {
  evaluation: ListingEvaluation;
  applyUrl: string | null;
  accessStatus: string;
  riskInvestigationId: string | null;
  companyInvestigationId: string | null;
  eligibilityInvestigationId: string | null;
}

export function saveShortlist(args: {
  shortlistId: ShortlistId;
  requestHash: string;
  student: StudentProfile;
  maxShortlisted: number;
  result: ShortlistData;
  cases: CaseRecordInput[];
}): void {
  const db = getDb();
  const insertCase = db.prepare(
    `INSERT INTO internship_cases (id, shortlist_id, listing_ref, url, apply_url, title, company_name, access_status,
      risk_investigation_id, company_investigation_id, eligibility_investigation_id, decision, rank, score, evaluation_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  db.transaction(() => {
    db.prepare("INSERT INTO shortlists (id, request_hash, student_json, max_shortlisted, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      args.shortlistId,
      args.requestHash,
      JSON.stringify(args.student),
      args.maxShortlisted,
      JSON.stringify(args.result),
      now,
    );
    for (const c of args.cases) {
      const e = c.evaluation;
      insertCase.run(
        e.caseId, args.shortlistId, e.listingRef, e.url, c.applyUrl, e.title, e.companyName, c.accessStatus,
        c.riskInvestigationId, c.companyInvestigationId, c.eligibilityInvestigationId,
        e.decision, e.rank, e.score, JSON.stringify(e), now,
      );
    }
  })();
}

export interface CaseRecord {
  caseId: CaseId;
  shortlistId: ShortlistId;
  url: string;
  applyUrl: string | null;
  title: string | null;
  companyName: string | null;
  decision: ListingEvaluation["decision"];
  evaluation: ListingEvaluation;
  student: StudentProfile;
  riskInvestigationId: string | null;
  companyInvestigationId: string | null;
  eligibilityInvestigationId: string | null;
}

export function getCase(caseId: string): CaseRecord | null {
  if (!ID_PATTERNS.case.test(caseId)) return null;
  const row = getDb()
    .prepare(
      `SELECT c.*, s.student_json FROM internship_cases c JOIN shortlists s ON s.id = c.shortlist_id WHERE c.id = ?`,
    )
    .get(caseId) as Record<string, string | number | null> | undefined;
  if (!row) return null;
  return {
    caseId: row.id as CaseId,
    shortlistId: row.shortlist_id as ShortlistId,
    url: row.url as string,
    applyUrl: (row.apply_url as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    companyName: (row.company_name as string | null) ?? null,
    decision: row.decision as ListingEvaluation["decision"],
    evaluation: JSON.parse(row.evaluation_json as string) as ListingEvaluation,
    student: JSON.parse(row.student_json as string) as StudentProfile,
    riskInvestigationId: (row.risk_investigation_id as string | null) ?? null,
    companyInvestigationId: (row.company_investigation_id as string | null) ?? null,
    eligibilityInvestigationId: (row.eligibility_investigation_id as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// applications, packages, approvals, exports
// ---------------------------------------------------------------------------

export interface ApplicationRow {
  id: ApplicationId;
  case_id: CaseId;
  status: ApplicationStatus;
  apply_url: string | null;
  export_dir: string | null;
  submitted_at: string | null;
  submission_evidence: string | null;
  created_at: string;
  updated_at: string;
}

export interface PackageRow {
  id: PackageId;
  application_id: ApplicationId;
  version: number;
  content_json: string;
  content_hash: string;
  review_flags_json: string;
  created_at: string;
  superseded_at: string | null;
}

export interface ApprovalRow {
  id: string;
  package_id: PackageId;
  content_hash: string;
  decision: "approved" | "rejected";
  decided_via: string;
  note: string | null;
  decided_at: string;
}

export interface ExportRow {
  id: string;
  package_id: PackageId;
  approval_id: string;
  directory: string;
  files_json: string;
  exported_at: string;
}

export function getApplication(id: string): ApplicationRow | null {
  if (!ID_PATTERNS.application.test(id)) return null;
  return (getDb().prepare("SELECT * FROM applications WHERE id = ?").get(id) as ApplicationRow | undefined) ?? null;
}

export function getApplicationByCase(caseId: string): ApplicationRow | null {
  return (getDb().prepare("SELECT * FROM applications WHERE case_id = ?").get(caseId) as ApplicationRow | undefined) ?? null;
}

export function getPackage(id: string): PackageRow | null {
  if (!ID_PATTERNS.package.test(id)) return null;
  return (getDb().prepare("SELECT * FROM application_packages WHERE id = ?").get(id) as PackageRow | undefined) ?? null;
}

export function currentPackage(applicationId: string): PackageRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM application_packages WHERE application_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1")
      .get(applicationId) as PackageRow | undefined) ?? null
  );
}

export function getApproval(packageId: string): ApprovalRow | null {
  return (getDb().prepare("SELECT * FROM approvals WHERE package_id = ?").get(packageId) as ApprovalRow | undefined) ?? null;
}

export function getExport(packageId: string): ExportRow | null {
  return (getDb().prepare("SELECT * FROM exports WHERE package_id = ?").get(packageId) as ExportRow | undefined) ?? null;
}

export function addEvent(applicationId: string, event: string, from: ApplicationStatus | null, to: ApplicationStatus | null, detail?: unknown): void {
  getDb()
    .prepare("INSERT INTO events (application_id, event, from_status, to_status, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(applicationId, event, from, to, detail === undefined ? null : JSON.stringify(detail), nowIso());
}

export class StateError extends Error {}

/** Move an application to `to` only if its current status is one of `from`. */
export function transition(applicationId: string, from: ApplicationStatus[], to: ApplicationStatus, event: string, detail?: unknown): void {
  const db = getDb();
  db.transaction(() => {
    const app = getApplication(applicationId);
    if (!app) throw new StateError(`Application ${applicationId} not found`);
    if (!from.includes(app.status)) {
      throw new StateError(`Application is ${app.status}; expected one of ${from.join(", ")}`);
    }
    db.prepare("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?").run(to, nowIso(), applicationId);
    addEvent(applicationId, event, app.status, to, detail);
  })();
}

/**
 * Create a new package version (or return the existing one with identical content).
 * Returns the application id, package row and whether it was reused.
 */
export function upsertPackage(args: {
  caseId: CaseId;
  applyUrl: string | null;
  content: ApplicationPackContent;
  contentHash: string;
  reviewFlags: ReviewFlag[];
}): { application: ApplicationRow; pkg: PackageRow; reused: boolean } {
  const db = getDb();
  return db.transaction(() => {
    let app = getApplicationByCase(args.caseId);
    const now = nowIso();
    if (!app) {
      const id = newId("app");
      db.prepare("INSERT INTO applications (id, case_id, status, apply_url, created_at, updated_at) VALUES (?, ?, 'PREPARED', ?, ?, ?)").run(
        id, args.caseId, args.applyUrl, now, now,
      );
      addEvent(id, "application_created", null, "PREPARED");
      app = getApplication(id) as ApplicationRow;
    }
    if (app.status === "SUBMITTED") throw new StateError("This application was already submitted; its package can no longer change.");

    const same = db
      .prepare("SELECT * FROM application_packages WHERE application_id = ? AND content_hash = ?")
      .get(app.id, args.contentHash) as PackageRow | undefined;
    if (same && same.superseded_at === null) return { application: app, pkg: same, reused: true };

    const prev = currentPackage(app.id);
    if (prev) db.prepare("UPDATE application_packages SET superseded_at = ? WHERE id = ?").run(now, prev.id);
    const maxRow = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM application_packages WHERE application_id = ?").get(app.id) as { v: number };
    const pkgId = newId("pkg");
    db.prepare(
      `INSERT INTO application_packages (id, application_id, version, content_json, content_hash, review_flags_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(pkgId, app.id, maxRow.v + 1, canonicalJson(args.content), args.contentHash, JSON.stringify(args.reviewFlags), now);
    // Content identical to an older, superseded version still gets a fresh version and needs fresh approval.
    addEvent(app.id, "package_prepared", app.status, "AWAITING_APPROVAL", { packageId: pkgId, version: maxRow.v + 1, contentHash: args.contentHash });
    db.prepare("UPDATE applications SET status = 'AWAITING_APPROVAL', updated_at = ? WHERE id = ?").run(now, app.id);
    return { application: getApplication(app.id) as ApplicationRow, pkg: getPackage(pkgId) as PackageRow, reused: false };
  })();
}

export function recordDecision(args: {
  packageId: PackageId;
  contentHash: string;
  decision: "approved" | "rejected";
  decidedVia: string;
  note: string | null;
}): ApprovalRow {
  const db = getDb();
  return db.transaction(() => {
    const pkg = getPackage(args.packageId);
    if (!pkg) throw new StateError("Package not found");
    if (pkg.superseded_at !== null) throw new StateError("This package version was replaced by a newer one. Review the latest version.");
    if (pkg.content_hash !== args.contentHash) throw new StateError("The package changed after this page was loaded. Reload and review again.");
    if (packageHashFromRow(pkg) !== pkg.content_hash) {
      throw new StateError("Stored package content does not match its hash; refusing to record a decision.");
    }
    if (getApproval(pkg.id)) throw new StateError("A decision was already recorded for this package version.");
    const id = newId("apr");
    db.prepare("INSERT INTO approvals (id, package_id, content_hash, decision, decided_via, note, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, pkg.id, pkg.content_hash, args.decision, args.decidedVia, args.note, nowIso(),
    );
    transition(
      pkg.application_id,
      ["AWAITING_APPROVAL"],
      args.decision === "approved" ? "READY_TO_SUBMIT" : "REJECTED_BY_STUDENT",
      args.decision === "approved" ? "student_approved" : "student_rejected",
      { packageId: pkg.id, contentHash: pkg.content_hash, via: args.decidedVia },
    );
    return getApproval(pkg.id) as ApprovalRow;
  })();
}

/** Recompute the hash from stored content (detects tampering with the database). */
export function packageHashFromRow(pkg: PackageRow): string {
  const app = getDb().prepare("SELECT case_id FROM applications WHERE id = ?").get(pkg.application_id) as { case_id: string };
  return packageHash(app.case_id, JSON.parse(pkg.content_json) as ApplicationPackContent);
}

export function insertExport(args: {
  packageId: PackageId;
  approvalId: string;
  applicationId: ApplicationId;
  directory: string;
  files: ExportedFile[];
}): void {
  getDb()
    .prepare("INSERT INTO exports (id, package_id, approval_id, directory, files_json, exported_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(newId("exp"), args.packageId, args.approvalId, args.directory, JSON.stringify(args.files), nowIso());
  getDb().prepare("UPDATE applications SET export_dir = ?, updated_at = ? WHERE id = ?").run(args.directory, nowIso(), args.applicationId);
}

export function upsertTask(applicationId: string, kind: string, description: string, dueDate: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO follow_up_tasks (id, application_id, kind, description, due_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)
       ON CONFLICT (application_id, kind) DO UPDATE SET description = excluded.description, due_date = excluded.due_date`,
    )
    .run(newId("task"), applicationId, kind, description, dueDate, nowIso());
}

export function completeTask(applicationId: string, kind: string): void {
  getDb().prepare("UPDATE follow_up_tasks SET status = 'done' WHERE application_id = ? AND kind = ?").run(applicationId, kind);
}

export function recordSubmission(applicationId: string, evidence: string): void {
  const db = getDb();
  db.transaction(() => {
    transition(applicationId, ["MANUAL_ACTION_REQUIRED"], "SUBMITTED", "submission_confirmed_by_student", { evidence });
    db.prepare("UPDATE applications SET submitted_at = ?, submission_evidence = ? WHERE id = ?").run(nowIso(), evidence, applicationId);
    completeTask(applicationId, "submit_application");
    const due = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    upsertTask(applicationId, "follow_up", "Follow up with the employer if there is no response (about one week after submitting).", due);
  })();
}

/**
 * Permanently delete one application and everything recorded for it (packages,
 * approvals, exports, follow-ups, history). The internship case and its
 * investigations are kept, so a new package can be prepared for the listing.
 * Returns the export directory (if any) for the caller to remove from disk.
 * Only the student's dashboard calls this; there is no MCP tool for it.
 */
export function deleteApplication(applicationId: string): { exportDir: string | null } {
  const db = getDb();
  return db.transaction(() => {
    const app = getApplication(applicationId);
    if (!app) throw new StateError("Application not found (it may already be deleted).");
    const pkgIds = (db.prepare("SELECT id FROM application_packages WHERE application_id = ?").all(app.id) as { id: string }[]).map((r) => r.id);
    for (const id of pkgIds) {
      db.prepare("DELETE FROM exports WHERE package_id = ?").run(id);
      db.prepare("DELETE FROM approvals WHERE package_id = ?").run(id);
    }
    db.prepare("DELETE FROM application_packages WHERE application_id = ?").run(app.id);
    db.prepare("DELETE FROM follow_up_tasks WHERE application_id = ?").run(app.id);
    db.prepare("DELETE FROM events WHERE application_id = ?").run(app.id);
    db.prepare("DELETE FROM applications WHERE id = ?").run(app.id);
    return { exportDir: app.export_dir };
  })();
}

export function listApplicationIds(filter: { shortlistId?: string; applicationId?: string; status?: ApplicationStatus }): ApplicationId[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.applicationId) {
    where.push("a.id = ?");
    params.push(filter.applicationId);
  }
  if (filter.shortlistId) {
    where.push("c.shortlist_id = ?");
    params.push(filter.shortlistId);
  }
  if (filter.status) {
    where.push("a.status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT a.id FROM applications a JOIN internship_cases c ON c.id = a.case_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY c.rank IS NULL, c.rank, a.created_at`;
  return (getDb().prepare(sql).all(...params) as { id: ApplicationId }[]).map((r) => r.id);
}
