/**
 * get_application_tracker: the student's application records, with exported
 * files re-verified on disk at query time.
 * OWNER: Developer 4.
 */
import type {
  ApplicationStatus,
  ExportedFile,
  FollowUpTask,
  ToolResult,
  TrackedApplication,
  TrackerData,
  TrackerInput,
} from "../shared/types.js";
import { getDb } from "./db.js";
import { verifyFiles } from "./exporter.js";
import { getPaths } from "./paths.js";
import { currentPackage, getApplication, getApproval, getCase, getExport, listApplicationIds } from "./store.js";

export function trackApplication(applicationId: string): TrackedApplication | null {
  const app = getApplication(applicationId);
  if (!app) return null;
  const c = getCase(app.case_id);
  if (!c) return null;
  const pkg = currentPackage(app.id);
  const approvalRow = pkg ? getApproval(pkg.id) : null;
  const exp = pkg ? getExport(pkg.id) : null;
  const db = getDb();
  const followUps = (db.prepare("SELECT id, kind, description, due_date, status FROM follow_up_tasks WHERE application_id = ? ORDER BY created_at").all(app.id) as Array<{
    id: string; kind: string; description: string; due_date: string | null; status: "open" | "done";
  }>).map<FollowUpTask>((t) => ({ id: t.id, kind: t.kind, description: t.description, dueDate: t.due_date, status: t.status }));
  const history = (db.prepare("SELECT created_at, event, from_status, to_status FROM events WHERE application_id = ? ORDER BY id").all(app.id) as Array<{
    created_at: string; event: string; from_status: ApplicationStatus | null; to_status: ApplicationStatus | null;
  }>).map((h) => ({ at: h.created_at, event: h.event, from: h.from_status, to: h.to_status }));

  return {
    applicationId: app.id,
    caseId: c.caseId,
    shortlistId: c.shortlistId,
    title: c.title,
    companyName: c.companyName,
    url: c.url,
    applyUrl: app.apply_url,
    status: app.status,
    currentPackage: pkg ? { packageId: pkg.id, version: pkg.version, contentHash: pkg.content_hash } : null,
    approval: approvalRow
      ? {
          decision: approvalRow.decision,
          decidedAt: approvalRow.decided_at,
          contentHash: approvalRow.content_hash,
          matchesCurrentPackage: approvalRow.content_hash === pkg?.content_hash,
        }
      : null,
    files: exp ? verifyFiles(JSON.parse(exp.files_json) as ExportedFile[]) : [],
    submission: app.submitted_at ? { submittedAt: app.submitted_at, evidence: app.submission_evidence ?? "" } : null,
    followUps,
    history,
    updatedAt: app.updated_at,
  };
}

export async function getApplicationTracker(input: TrackerInput): Promise<ToolResult<TrackerData>> {
  const ids = listApplicationIds(input);
  const applications = ids.map(trackApplication).filter((a): a is TrackedApplication => a !== null);
  const counts: TrackerData["counts"] = {};
  for (const a of applications) counts[a.status] = (counts[a.status] ?? 0) + 1;

  const warnings: string[] = [];
  const broken = applications.flatMap((a) => a.files.filter((f) => !f.verified).map((f) => f.relativePath));
  if (broken.length > 0) warnings.push(`Exported file(s) missing or modified since export: ${broken.join(", ")}`);
  const stale = applications.filter((a) => a.approval && !a.approval.matchesCurrentPackage);
  if (stale.length > 0) warnings.push(`${stale.length} application(s) have an approval that does not match the current package.`);
  if (applications.some((a) => a.status === "MANUAL_ACTION_REQUIRED")) {
    warnings.push("Applications in MANUAL_ACTION_REQUIRED have NOT been submitted; the student must submit them.");
  }
  const { exportsDir, databaseFile } = getPaths();
  return {
    status: broken.length > 0 ? "partial" : "success",
    data: { applications, counts, exportsRoot: exportsDir, databasePath: databaseFile, dashboardUrl: getPaths().approvalBaseUrl },
    evidence: applications.flatMap((a) =>
      a.files.filter((f) => f.verified).map((f) => ({ source: "exports", description: `${f.relativePath} verified on disk (sha256 matches).` })),
    ),
    warnings,
  };
}
