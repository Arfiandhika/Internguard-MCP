/**
 * save_approved_application: export an approved package to real files.
 * OWNER: Developer 4.
 *
 * Preconditions, all checked from the database (never from tool input):
 *   1. the package is the current version for its application;
 *   2. its stored content still hashes to its recorded content_hash;
 *   3. a student approval exists for this package with the same hash.
 * Files are written atomically (temp file + rename), read back and hashed.
 * Only after verification does the status change. Re-running is idempotent.
 * InternGuard never submits applications or sends email.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ApplicationPackContent,
  ApplicationStatus,
  ExportedFile,
  ReviewFlag,
  SaveApprovedData,
  ToolResult,
} from "../shared/types.js";
import { ensureDir, getPaths, safeJoin, slugify } from "./paths.js";
import { loadCaseEvidence } from "./pack.js";
import {
  getApplication,
  getApproval,
  getExport,
  getPackage,
  insertExport,
  packageHashFromRow,
  sha256,
  transition,
  upsertTask,
  type ApprovalRow,
  type PackageRow,
} from "./store.js";
import { getDb } from "./db.js";

const SUMMARY_NOTICE =
  "InternGuard has NOT submitted this application or sent any email. Final submission requires your action.";

function fail(message: string, extra: string[] = []): ToolResult<SaveApprovedData> {
  return { status: "error", data: null, evidence: [], warnings: [message, ...extra] };
}

export function renderFiles(pkg: PackageRow, approval: ApprovalRow): Record<string, string> {
  const content = JSON.parse(pkg.content_json) as ApplicationPackContent;
  const flags = JSON.parse(pkg.review_flags_json) as ReviewFlag[];
  const ev = loadCaseEvidence(
    (getDb().prepare("SELECT case_id FROM applications WHERE id = ?").get(pkg.application_id) as { case_id: string }).case_id,
  );
  if (!ev) throw new Error("Case for package not found");
  const { record } = ev;
  const e = record.evaluation;
  const applyUrl = record.applyUrl ?? record.url;
  const title = `${record.title ?? "Internship"}${record.companyName ? ` at ${record.companyName}` : ""}`;
  const bullets = (items: string[], empty = "_None recorded._") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);

  const email = [
    `# Email draft: ${title}`,
    "",
    `**To:** ${content.recruiterEmail.to ?? "_No recruiter email address appears in the listing. Apply through the link below instead._"}`,
    `**Subject:** ${content.recruiterEmail.subject}`,
    "",
    content.recruiterEmail.body,
    "",
    "---",
    `_Draft only. InternGuard does not send email. Application link: ${applyUrl}_`,
    "",
  ].join("\n");

  const mandatory = [
    `Submit the application yourself at ${applyUrl}`,
    "Confirm the company through its official website or official contact details",
    "Never pay a fee, buy equipment, or share passwords, OTPs or banking details to get an internship",
  ];
  const checklist = [`# Application checklist: ${title}`, "", ...[...content.checklist, ...mandatory].map((i) => `- [ ] ${i}`), ""].join("\n");

  const summary = [
    `# Application summary: ${title}`,
    "",
    `> ${SUMMARY_NOTICE}`,
    "",
    "## Listing",
    `- Listing URL: ${record.url}`,
    `- Apply at: ${applyUrl}`,
    `- Shortlist decision: **${e.decision}**${e.rank ? ` (rank ${e.rank})` : ""}${e.score !== null ? `, score ${e.score}/100` : ""}`,
    `- Scam check: ${e.riskAssessment ?? "not run"} (not a safety verdict)`,
    `- Company verification: ${e.companyVerificationStatus ?? "not run"}`,
    `- Eligibility: ${e.eligibilityOutcome ?? "not run"}`,
    "",
    "## Why it was shortlisted",
    bullets(e.reasons),
    "",
    "## Verified facts (backed by stored tool results or verbatim text)",
    bullets(e.verifiedFacts),
    "",
    "## Assumptions (not verified)",
    bullets(e.assumptions),
    "",
    "## Missing information or evidence",
    bullets([...new Set([...e.missingEvidence, ...content.missingInformation])]),
    "",
    "## Review flags shown at approval",
    bullets(flags.map((f) => f.message)),
    "",
    "## Approval record",
    `- Decision: **${approval.decision}** via ${approval.decided_via}`,
    `- Decided at: ${approval.decided_at}`,
    `- Package: ${pkg.id} (version ${pkg.version})`,
    `- Content SHA-256: \`${pkg.content_hash}\``,
    "",
  ].join("\n");

  return {
    "cover-letter.md": content.coverLetter.endsWith("\n") ? content.coverLetter : `${content.coverLetter}\n`,
    "email-draft.md": email,
    "checklist.md": checklist,
    "cv-suggestions.md": [`# CV suggestions for: ${title}`, "", bullets(content.cvSuggestions), ""].join("\n"),
    "application-summary.md": summary,
  };
}

/** Check exported files against their recorded hashes. */
export function verifyFiles(files: ExportedFile[]): Array<ExportedFile & { verified: boolean }> {
  const root = getPaths().exportsDir;
  return files.map((f) => {
    try {
      const abs = safeJoin(root, ...f.relativePath.split("/"));
      return { ...f, verified: existsSync(abs) && sha256(readFileSync(abs)) === f.sha256 };
    } catch {
      return { ...f, verified: false };
    }
  });
}

/**
 * Remove an application's export folder. Refuses anything that is not a direct
 * child of the exports root with InternGuard's folder naming (<slug>-<8 hex>).
 */
export function removeExportDir(dir: string | null): boolean {
  if (!dir) return false;
  const root = path.resolve(getPaths().exportsDir);
  const target = path.resolve(dir);
  const name = path.basename(target);
  if (path.dirname(target) !== root || !/^[a-z0-9-]{1,40}-[0-9a-f]{8}$/.test(name)) return false;
  rmSync(safeJoin(root, name), { recursive: true, force: true });
  return true;
}

function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function saveApprovedApplication(input: { packageId: string }): Promise<ToolResult<SaveApprovedData>> {
  const pkg = getPackage(input.packageId);
  if (!pkg) return fail(`Package ${input.packageId} not found.`);
  const app = getApplication(pkg.application_id);
  if (!app) return fail("Application for this package not found.");
  const reviewUrl = `${getPaths().approvalBaseUrl}/review/${pkg.id}`;

  if (pkg.superseded_at !== null) return fail("This package version was replaced by a newer version. Ask the student to review and approve the latest version.");
  if (packageHashFromRow(pkg) !== pkg.content_hash) {
    return fail("Integrity check failed: the stored package content does not match its recorded hash. Nothing was exported.");
  }
  const approval = getApproval(pkg.id);
  if (!approval) return fail(`No student approval exists for this package. Ask the student to review it at ${reviewUrl}.`);
  if (approval.decision !== "approved") return fail("The student rejected this package. Prepare a revised package if they want to continue.");
  if (approval.content_hash !== pkg.content_hash) return fail(`The approval is for different content. Ask the student to review again at ${reviewUrl}.`);
  const allowed: ApplicationStatus[] = ["READY_TO_SUBMIT", "MANUAL_ACTION_REQUIRED", "SUBMITTED"];
  if (!allowed.includes(app.status)) return fail(`Application status is ${app.status}; it cannot be exported.`);

  const root = getPaths().exportsDir;
  const ev = loadCaseEvidence(app.case_id);
  const folder = `${slugify(ev?.record.companyName ?? ev?.record.title)}-${app.id.slice(4, 12)}`;
  const applyUrl = app.apply_url;
  const nextAction = `Review the files (open_student_dashboard shows them in the browser), then submit the application yourself at ${applyUrl ?? "the listing page"}. InternGuard has not submitted anything.`;

  // Idempotency: same approved package already exported and files intact.
  const prior = getExport(pkg.id);
  if (prior) {
    const checked = verifyFiles(JSON.parse(prior.files_json) as ExportedFile[]);
    if (checked.every((f) => f.verified)) {
      return {
        status: "success",
        data: {
          applicationId: app.id, packageId: pkg.id, status: app.status, exportDirectory: prior.directory,
          files: checked.map(({ verified: _v, ...f }) => f), applyUrl, nextAction, alreadyExported: true,
        },
        evidence: checked.map((f) => ({ source: "exports", description: `${f.relativePath} present, sha256 ${f.sha256.slice(0, 12)}…` })),
        warnings: ["This approved package was already exported; no files were duplicated."],
      };
    }
  }

  ensureDir(root);
  const dir = safeJoin(root, folder);
  ensureDir(dir);
  const rendered = renderFiles(pkg, approval);
  const files: ExportedFile[] = [];
  for (const [name, data] of Object.entries(rendered)) {
    const target = safeJoin(root, folder, name);
    writeAtomic(target, data);
    const readBack = readFileSync(target);
    const expected = sha256(Buffer.from(data, "utf8"));
    if (sha256(readBack) !== expected) return fail(`Write verification failed for ${name}; status was not changed.`);
    files.push({ name, relativePath: `${folder}/${name}`, bytes: readBack.byteLength, sha256: expected });
  }

  const db = getDb();
  db.transaction(() => {
    if (prior) {
      db.prepare("UPDATE exports SET files_json = ?, directory = ?, exported_at = ? WHERE id = ?").run(JSON.stringify(files), path.join(root, folder), new Date().toISOString(), prior.id);
    } else {
      insertExport({ packageId: pkg.id, approvalId: approval.id, applicationId: app.id, directory: path.join(root, folder), files });
    }
    if (app.status === "READY_TO_SUBMIT") {
      transition(app.id, ["READY_TO_SUBMIT"], "MANUAL_ACTION_REQUIRED", "exported", { packageId: pkg.id, files: files.map((f) => f.relativePath) });
    }
    upsertTask(app.id, "submit_application", `Submit the application yourself at ${applyUrl ?? "the listing page"} using the exported files.`, null);
    const missing = ev ? [...new Set([...ev.record.evaluation.missingEvidence])] : [];
    if (missing.length > 0) upsertTask(app.id, "resolve_missing_evidence", `Before submitting, resolve: ${missing.slice(0, 5).join("; ")}`, null);
  })();

  const after = getApplication(app.id);
  return {
    status: "success",
    data: {
      applicationId: app.id, packageId: pkg.id, status: after?.status ?? app.status, exportDirectory: path.join(root, folder),
      files, applyUrl, nextAction, alreadyExported: false,
    },
    evidence: files.map((f) => ({ source: "exports", description: `Wrote ${f.relativePath} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 12)}…), verified by read-back.` })),
    warnings: [SUMMARY_NOTICE],
  };
}
