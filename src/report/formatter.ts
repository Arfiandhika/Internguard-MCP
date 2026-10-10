/**
 * Human-readable reports for every InternGuard tool.
 * OWNER: Developer 4. Loaded automatically by src/index.ts (export "formatReport").
 *
 * Contract (FormatReportFn): synchronous, never throws, never writes to stdout.
 * The full data stays in structuredContent; this text is a compact summary for
 * the agent and the student. Rules:
 *   - observed evidence is always shown separately from heuristic signals
 *   - nothing is ever described as "safe"
 *   - excerpts quoted from listings are untrusted: clipped, flattened, quoted
 *   - SIMULATED data is always labelled
 */
import type { FormatReportFn, InternGuardToolName, ToolResult } from "../shared/types.js";

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// defensive accessors (data arrives as unknown)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

/** Flatten and clip untrusted text so it cannot break the report layout. */
function clip(text: string, max = 160): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/`/g, "'").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cell(text: string, max = 120): string {
  return clip(text, max).replace(/\|/g, "\\|");
}

function bullets(items: string[], max = 6, clipAt = 220): string[] {
  const shown = items.slice(0, max).map((i) => `- ${clip(i, clipAt)}`);
  if (items.length > max) shown.push(`- …and ${items.length - max} more (see structured data)`);
  return shown;
}

function section(title: string, items: string[], max = 6, clipAt = 220): string[] {
  return items.length ? ["", `**${title}**`, ...bullets(items, max, clipAt)] : [];
}

const STATUS_LABEL: Record<string, string> = { success: "", partial: " (partial)", error: " (error)" };

function header(title: string, status: string): string {
  return `## ${title}${STATUS_LABEL[status] ?? ""}`;
}

function warningsBlock(result: ToolResult<unknown>, alreadyShown = ""): string[] {
  const ws = [...new Set(strs(result.warnings))].filter((w) => !alreadyShown.includes(w));
  return ws.length ? ["", "**Notes**", ...bullets(ws, 6, 300)] : [];
}

// ---------------------------------------------------------------------------
// per-tool renderers
// ---------------------------------------------------------------------------

const ASSESSMENT_LABEL: Record<string, string> = {
  high_risk: "HIGH RISK",
  medium_risk: "MEDIUM RISK",
  no_major_indicators_detected: "No major indicators detected (not a safety verdict)",
  insufficient_evidence: "INSUFFICIENT EVIDENCE",
};

function renderRisk(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  const assessment = str(d.assessment, "unknown");
  const score = typeof d.riskScore === "number" ? ` · risk score ${d.riskScore}/100` : "";
  const flags = arr(d.redFlags).map(obj);
  const line = (f: Obj) => {
    const excerpt = str(f.matchedText);
    return `[${str(f.severity, "?")}] ${str(f.description, str(f.code))}${excerpt ? ` — "${clip(excerpt, 120)}"` : ""}`;
  };
  const observed = flags.filter((f) => f.basis === "observed").map(line);
  const heuristic = flags.filter((f) => f.basis !== "observed").map(line);
  const url = obj(d.url);
  const info = obj(d.information);
  const out = [header(`Scam check: ${ASSESSMENT_LABEL[assessment] ?? assessment}${score}`, r.status)];
  if (url.provided === true) {
    const platform = str(obj(url.knownPlatform).name);
    out.push(`URL: ${url.valid === true ? `host ${str(url.hostname, "?")}${platform ? ` (${platform})` : ""}` : "not a valid web address"}`);
  }
  // Lines are already built from clipped parts; a wide limit keeps closing quotes intact.
  out.push(...section("Observed evidence (shown directly in the listing)", observed, 5, 420));
  out.push(...section("Heuristic signals (also occur in genuine listings)", heuristic, 5, 420));
  if (flags.length === 0 && r.status !== "error") out.push("", "No indicators matched the text provided.");
  if (info.sufficient === false) out.push(...section("Information missing from the listing", strs(info.missing), 5));
  const rec = str(d.recommendation);
  if (rec) out.push("", `**Recommendation:** ${rec}`);
  if (r.status !== "error") out.push("", "_Not checked: the page was not fetched; no reputation or domain-age lookup; the company was not verified._");
  return out;
}

function renderCompany(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  const simulated = arr(r.evidence).some((e) => str(obj(e).source).startsWith("SIMULATED"));
  const status = str(d.verificationStatus, "unknown");
  const out = [header(`Company check: ${str(d.companyName, "?")} — ${status.toUpperCase()}${simulated ? " [SIMULATED registry]" : ""}`, r.status)];
  const facts = [
    d.registrationNumber ? `Registration number: ${str(d.registrationNumber)}` : "",
    d.registeredCountry ? `Registered in: ${str(d.registeredCountry)}` : "",
    d.officialWebsite ? `Website on record: ${str(d.officialWebsite)}` : "",
  ].filter(Boolean);
  out.push(...section("Record", facts));
  out.push(...section("Findings", strs(d.findings)));
  out.push(...section("Evidence still needed", strs(d.missingEvidence), 4));
  return out;
}

function renderEligibility(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  const reqs = arr(d.requirements).map(obj).map((q) => {
    const mark = q.met === true ? "✓" : q.met === false ? "✗" : "?";
    return `${mark} ${str(q.description)}`;
  });
  const out = [header(`Eligibility: ${str(d.outcome, "unknown").replace(/_/g, " ").toUpperCase()}`, r.status)];
  out.push(...section("Requirements (✓ met · ✗ not met · ? cannot tell)", reqs, 12));
  out.push(...section("Missing information", strs(d.missingInformation)));
  const disclaimer = str(d.disclaimer);
  if (disclaimer) out.push("", `_${disclaimer}_`);
  return out;
}

function renderShortlist(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  const evals = arr(d.evaluations).map(obj);
  const out = [header(`Shortlist: ${evals.filter((e) => e.decision === "shortlisted").length} of ${evals.length} listings selected`, r.status)];
  if (d.reused === true) out.push("_Identical request: stored shortlist returned._");
  if (evals.length > 0) {
    out.push("", "| Ref | Company | Decision | Rank | Score | Main reason |", "|---|---|---|---|---|---|");
    for (const e of evals) {
      const reasons = strs(e.reasons);
      const rejectedAt = reasons.findIndex((x) => x.startsWith("Rejected"));
      const main =
        e.decision === "rejected" && rejectedAt >= 0
          ? reasons.slice(rejectedAt, rejectedAt + 2).join(" ")
          : (reasons.find((x) => !x.startsWith("The scam check found no major")) ?? reasons[0] ?? "");
      out.push(
        `| ${cell(str(e.listingRef), 12)} | ${cell(str(e.companyName, "?"), 40)} | ${str(e.decision).replace(/_/g, " ")} | ${e.rank ?? "–"} | ${e.score ?? "–"} | ${cell(main, 150)} |`,
      );
    }
  }
  for (const e of evals.filter((x) => x.decision === "shortlisted")) {
    out.push("", `**${str(e.listingRef)} · ${clip(str(e.title, "Internship"), 60)} at ${clip(str(e.companyName, "?"), 50)}** · caseId \`${str(e.caseId)}\``);
    const verified = strs(e.verifiedFacts);
    const assumptions = strs(e.assumptions);
    const missing = strs(e.missingEvidence);
    // Two of each, so assumptions and gaps are never hidden behind verified facts.
    if (verified.length) out.push(...bullets(verified.map((v) => `Verified: ${v}`), 2));
    if (assumptions.length) out.push(...bullets(assumptions.map((a) => `Assumption: ${a}`), 2));
    else out.push("- Assumptions: none recorded");
    if (missing.length) out.push(...bullets(missing.map((m) => `Missing: ${m}`), 2));
  }
  const notice = str(d.notice);
  if (notice) out.push("", `_${notice}_`);
  return out;
}

function renderPrepare(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  if (r.status === "error" || !isObj(r.data)) return [header("Application package NOT saved", "error")];
  const flags = arr(d.reviewFlags).map(obj).map((f) => `${f.level === "blocking" ? "BLOCKING" : "Review"}: ${str(f.message)}`);
  return [
    header(`Application package v${str(d.version, "?")} awaiting the student's approval`, r.status),
    `Package \`${str(d.packageId)}\` · content SHA-256 \`${str(d.contentHash).slice(0, 16)}…\` · status ${str(d.status)}${d.reused === true ? " · identical content, existing package returned" : ""}`,
    "",
    `**Student review link:** ${str(d.reviewUrl)}`,
    "The student must open this link (approval interface: `npm run approval`) and decide. The agent cannot approve.",
    ...section("Review flags shown to the student", flags),
  ];
}

function renderSave(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  if (r.status === "error" || !isObj(r.data)) return [header("Export refused", "error")];
  const files = arr(d.files).map(obj).map((f) => `${str(f.relativePath)} (${str(f.bytes)} bytes, sha256 ${str(f.sha256).slice(0, 12)}…)`);
  return [
    header(`Exported ${files.length} files · status ${str(d.status)}${d.alreadyExported === true ? " (already exported, nothing duplicated)" : ""}`, r.status),
    `Folder: ${str(d.exportDirectory)}`,
    ...section("Files (verified by read-back)", files, 8),
    "",
    `**Next:** ${str(d.nextAction)}`,
  ];
}

function renderTracker(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  const apps = arr(d.applications).map(obj);
  const counts = Object.entries(obj(d.counts)).map(([k, v]) => `${k}: ${str(v)}`).join(" · ");
  const out = [header(`Application tracker: ${apps.length} application(s)`, r.status)];
  if (counts) out.push(counts);
  for (const a of apps) {
    const files = arr(a.files).map(obj);
    const ok = files.filter((f) => f.verified === true).length;
    const approval = obj(a.approval);
    const sub = obj(a.submission);
    out.push("", `### ${clip(str(a.companyName, str(a.title, "Internship")), 60)} — ${str(a.status)}`);
    const lines = [
      isObj(a.approval)
        ? `Approval: ${str(approval.decision)} at ${str(approval.decidedAt)}${approval.matchesCurrentPackage === false ? " (DOES NOT match the current package)" : ""}`
        : "Approval: none yet",
      files.length ? `Files: ${ok}/${files.length} verified on disk` : "Files: not exported",
      isObj(a.submission) ? `Submitted (confirmed by student): ${str(sub.evidence)} at ${str(sub.submittedAt)}` : "",
      a.applyUrl ? `Apply at: ${str(a.applyUrl)}` : "",
      ...arr(a.followUps).map(obj).filter((t) => t.status === "open").map((t) => `To do: ${str(t.description)}${t.dueDate ? ` (by ${str(t.dueDate)})` : ""}`),
    ].filter(Boolean);
    out.push(...bullets(lines, 8, 260));
  }
  if (apps.length === 0) out.push("", "No applications yet.");
  return out;
}

function renderHello(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  const mods = Object.entries(obj(d.modules)).map(([k, v]) => `${k}: ${str(v) === "module" ? "live" : "TEMPORARY STUB"}`);
  const exec = obj(d.execution);
  return [
    header(str(d.message, "InternGuard"), r.status),
    ...section("Modules", mods),
    isObj(d.execution) ? `\nDatabase: ${str(exec.database)} (${clip(str(exec.detail), 200)})` : "",
  ];
}

function renderPlaybook(r: ToolResult<unknown>): string[] {
  const text = str(obj(r.data).playbook);
  return ["## InternGuard workflow playbook", "Follow these steps exactly.", "", text];
}

function renderDashboard(r: ToolResult<unknown>): string[] {
  const d = obj(r.data);
  if (!isObj(r.data)) return [header("Student dashboard not available", "error")];
  return [
    header(`Student dashboard ${d.started === true ? "started and " : ""}${d.browserOpened === true ? "opened in the student's browser" : "running"}`, r.status),
    `Dashboard: ${str(d.dashboardUrl)}`,
    "The student reviews, approves, opens exported files and records submissions there. The agent cannot approve.",
  ];
}

const RENDERERS: Record<InternGuardToolName, (r: ToolResult<unknown>) => string[]> = {
  open_student_dashboard: renderDashboard,
  get_workflow_playbook: renderPlaybook,
  hello_internguard: renderHello,
  check_internship_risk: renderRisk,
  verify_company: renderCompany,
  check_student_eligibility: renderEligibility,
  shortlist_internships: renderShortlist,
  prepare_application_pack: renderPrepare,
  save_approved_application: renderSave,
  get_application_tracker: renderTracker,
};

/** Shown when the result itself is malformed or a renderer fails. */
function fallback(toolName: string, result: unknown): string {
  const r = obj(result);
  return [`## ${toolName} (${str(r.status, "unknown status")})`, ...bullets(strs(r.warnings), 6, 300)].join("\n");
}

export const formatReport: FormatReportFn = (toolName, result) => {
  try {
    if (!isObj(result)) return fallback(toolName, result);
    const render = RENDERERS[toolName];
    if (!render) return fallback(toolName, result);
    // An error result has no usable data: show the reasons only.
    const body = result.status === "error" && !isObj(result.data) && toolName !== "prepare_application_pack" && toolName !== "save_approved_application"
      ? [header(`${toolName}: no result`, "error")]
      : render(result);
    return [...body, ...warningsBlock(result, body.join("\n"))].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  } catch {
    return fallback(toolName, result);
  }
};
