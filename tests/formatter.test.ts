/** Report formatter (Developer 4). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatReport } from "../src/report/formatter.js";
import { checkInternshipRisk } from "../src/tools/scam-check.js";
import { verifyCompany } from "../src/tools/company-check.js";
import { checkStudentEligibility } from "../src/tools/eligibility.js";
import type { InternGuardToolName, ToolResult } from "../src/shared/types.js";

const TOOLS: InternGuardToolName[] = [
  "hello_internguard", "check_internship_risk", "verify_company", "check_student_eligibility",
  "shortlist_internships", "prepare_application_pack", "save_approved_application", "get_application_tracker",
  "get_workflow_playbook", "open_student_dashboard", "show_application_tracker",
];
const SAFETY_CLAIM = /\b(?:is|looks|appears|seems)\s+(?:safe|legit|legitimate|genuine)\b/i;
const unnegated = (t: string) => t.split(/(?<=[.!?])\s+|\n/).filter((x) => SAFETY_CLAIM.test(x) && !/\b(?:not|never|no)\b|n't\b/i.test(x));

test("never throws and always returns text, even for malformed results", () => {
  const garbage: unknown[] = [
    null, undefined, 42, "x", [], {},
    { status: "success", data: null, evidence: [], warnings: [] },
    { status: "success", data: { redFlags: "nope", evaluations: 7, applications: [null, 3, { files: "x" }], requirements: [{}] }, evidence: null, warnings: [1, null] },
    { status: "error", data: null, evidence: [], warnings: ["boom"] },
  ];
  for (const tool of TOOLS) {
    for (const g of garbage) {
      const out = formatReport(tool, g as ToolResult<unknown>);
      assert.equal(typeof out, "string", `${tool}`);
      assert.ok(out.length > 0, `${tool}`);
    }
  }
});

test("error results show their reasons", () => {
  const out = formatReport("save_approved_application", { status: "error", data: null, evidence: [], warnings: ["No student approval exists for this package."] });
  assert.match(out, /Export refused/);
  assert.match(out, /No student approval exists/);
});

test("scam report separates observed evidence from heuristic signals and stays compact", async () => {
  const r = await checkInternshipRisk({
    url: "https://bit.ly/x",
    jobDescription: "You must pay a registration fee of RM150. Only 3 slots left, reply within 24 hours. Contact our HR on WhatsApp.",
  });
  const out = formatReport("check_internship_risk", r);
  const observed = out.indexOf("Observed evidence");
  const heuristic = out.indexOf("Heuristic signals");
  assert.ok(observed >= 0 && heuristic > observed, out);
  assert.match(out.slice(observed, heuristic), /registration fee/);
  assert.match(out.slice(heuristic), /URL shortener|link shortener|shortener/i);
  assert.ok(out.length < JSON.stringify(r).length, "summary shorter than the raw JSON");
  for (const line of out.split("\n").filter((l) => l.includes(' — "'))) assert.match(line, /"$/, "excerpt quote closed");
});

test("a clean scam result never reads as a safety verdict", async () => {
  const r = await checkInternshipRisk({
    url: "https://careers.acme.example/jobs/1",
    jobDescription: "Data Analytics Intern at Acme Analytics Sdn Bhd. Responsibilities: you will build dashboards and support the analytics team. Requirements: undergraduate students in statistics or computer science with SQL skills. Duration 12 weeks, hybrid in our office, allowance per month. Apply through our careers page; interviews by video call.",
  });
  const out = formatReport("check_internship_risk", r);
  assert.match(out, /not a safety verdict/);
  assert.deepEqual(unnegated(out), []);
});

test("company report labels simulated registry data", async () => {
  const reg = path.join(mkdtempSync(path.join(tmpdir(), "ig-fmt-")), "r.json");
  writeFileSync(reg, JSON.stringify({ simulated: true, companies: [{ name: "Acme Ltd", registrationNumber: "SIM-9", country: "Malaysia", status: "active" }] }));
  process.env.INTERNGUARD_SIMULATED_REGISTRY = reg;
  const out = formatReport("verify_company", await verifyCompany({ companyName: "Acme Ltd" }));
  delete process.env.INTERNGUARD_SIMULATED_REGISTRY;
  assert.match(out, /VERIFIED \[SIMULATED registry\]/);
});

test("eligibility marks met, unmet and unknown requirements distinctly", async () => {
  const r = await checkStudentEligibility({
    internshipCountry: "Malaysia",
    student: { skills: ["SQL"], hoursPerWeekAvailable: 20 },
    requirements: { requiredSkills: ["SQL", "Java"], minHoursPerWeek: 20, startDate: "2026-06-01" },
  });
  const out = formatReport("check_student_eligibility", r);
  assert.match(out, /✓ Required skill: SQL/);
  assert.match(out, /\? Required skill: Java \(not shown in your profile\)/);
  assert.match(out, /\? Can start by 2026-06-01/);
  assert.match(out, /not legal or immigration advice/);
});

test("shortlist report: table, rejection reason, assumptions visible, notice once", () => {
  const notice = "Shortlisting ranks listings by the evidence available. It is not a safety verdict.";
  const r: ToolResult<unknown> = {
    status: "success",
    evidence: [],
    warnings: [notice],
    data: {
      shortlistId: "sl_x", reused: false, notice,
      shortlistedCaseIds: ["case_a"],
      evaluations: [
        { listingRef: "L1", caseId: "case_a", companyName: "A | Co", title: "Intern", decision: "shortlisted", rank: 1, score: 90,
          reasons: ["The scam check found no major indicators in the listing text (this is not a safety verdict).", "Meets all stated requirements that were checked."],
          verifiedFacts: ["f1", "f2", "f3"], assumptions: ['Requirement "Rust" was supplied by the agent'], missingEvidence: ["m1"] },
        { listingRef: "L6", caseId: "case_b", companyName: "B", decision: "rejected", rank: null, score: null,
          reasons: ["The scam check found no major indicators in the listing text (this is not a safety verdict).", "Rejected: the student does not meet these stated requirements:", "Not met: 40 hours per week"],
          verifiedFacts: [], assumptions: [], missingEvidence: [] },
      ],
    },
  };
  const out = formatReport("shortlist_internships", r);
  assert.match(out, /\| Ref \| Company \|/);
  assert.match(out, /A \\\| Co/, "pipe in cell is escaped");
  assert.match(out, /\| L6 .*Rejected: the student does not meet.*Not met: 40 hours/);
  assert.match(out, /Assumption: Requirement "Rust"/);
  assert.match(out, /Missing: m1/);
  assert.equal(out.split(notice).length - 1, 1, "notice printed once");
});

test("prepare and tracker reports keep the student in control", () => {
  const prep = formatReport("prepare_application_pack", {
    status: "success", evidence: [], warnings: [],
    data: { packageId: "pkg_1", version: 2, contentHash: "a".repeat(64), status: "AWAITING_APPROVAL", reviewUrl: "http://127.0.0.1:4317/review/pkg_1", reviewFlags: [{ level: "review", message: "Placeholder text" }], reused: false },
  });
  assert.match(prep, /review link:\*\* http:\/\/127\.0\.0\.1:4317\/review\/pkg_1/);
  assert.match(prep, /The agent cannot approve/);
  const tr = formatReport("get_application_tracker", {
    status: "success", evidence: [], warnings: [],
    data: { counts: { MANUAL_ACTION_REQUIRED: 1 }, applications: [{ companyName: "Acme", status: "MANUAL_ACTION_REQUIRED", approval: { decision: "approved", decidedAt: "t", matchesCurrentPackage: true }, files: [{ verified: true }, { verified: false }], submission: null, applyUrl: "https://acme.example/apply", followUps: [{ status: "open", description: "Submit it yourself" }] }] },
  });
  assert.match(tr, /Files: 1\/2 verified/);
  assert.match(tr, /To do: Submit it yourself/);
  assert.doesNotMatch(tr, /Submitted \(confirmed/);
});
