/**
 * The InternGuard workflow driven through a real MCP client, using the
 * SIMULATED fixtures in fixtures/demo. Mirrors the WorkBuddy playbook
 * (src/execution/register.ts PLAYBOOK) step by step.
 * OWNER: Developer 1. Used by scripts/demo.ts and tests/execution-e2e.test.ts.
 *
 * It never approves anything: approval happens in the approval interface.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ApplicationPackContent,
  ListingEvaluation,
  PreparedPackData,
  SaveApprovedData,
  ShortlistData,
  StudentProfile,
  ToolResult,
  TrackerData,
} from "../src/shared/types.js";

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "demo");
export const REGISTRY_FIXTURE = path.join(FIXTURES_DIR, "company-registry.simulated.json");

interface FixtureListing {
  listingRef: string;
  title: string;
  companyName: string;
  website: string | null;
  url: string;
  accessStatus: "accessed" | "provided_by_student" | "not_accessible";
  text: string | null;
  internship: { durationWeeks?: number; hoursPerWeek?: number; isPaid?: boolean };
  requirements: Record<string, unknown>;
}

export interface Fixtures {
  student: StudentProfile;
  context: { internshipCountry: string; visaOrPermitType: string };
  listings: FixtureListing[];
  packs: Record<string, ApplicationPackContent>;
}

export function loadFixtures(): Fixtures {
  const read = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf8")) as Record<string, unknown>;
  const s = read("student.simulated.json") as { profile: StudentProfile; eligibilityContext: Fixtures["context"] };
  return {
    student: s.profile,
    context: s.eligibilityContext,
    listings: (read("listings.simulated.json") as { listings: FixtureListing[] }).listings,
    packs: (read("application-content.simulated.json") as { packs: Record<string, ApplicationPackContent> }).packs,
  };
}

export type CallResult<T> = { result: ToolResult<T> & { investigationId?: string | null }; isError: boolean };

export async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult<T>> {
  const res = await client.callTool({ name, arguments: args });
  const sc = res.structuredContent as (ToolResult<T> & { investigationId?: string | null }) | undefined;
  if (sc && typeof sc === "object" && "status" in sc) return { result: sc, isError: res.isError === true };
  // Protocol-level errors (e.g. input validation) arrive as text only.
  const text = Array.isArray(res.content) ? res.content.map((c) => ("text" in c ? String(c.text) : "")).join("\n") : "";
  return { result: { status: "error", data: null, evidence: [], warnings: [text || "Tool call failed"] }, isError: true };
}

export interface PreparedEntry {
  listingRef: string;
  caseId: string;
  packageId: string | null;
  reviewUrl: string | null;
  reviewFlags: string[];
  problems: string[];
}

export interface DemoState {
  shortlistId: string;
  evaluations: Array<Pick<ListingEvaluation, "listingRef" | "decision" | "rank" | "score" | "reasons">>;
  prepared: PreparedEntry[];
  toolFailures: string[];
}

type Log = (line: string) => void;

/** Steps 2-6: investigate every listing, shortlist, prepare packages. */
export async function runInvestigateAndPrepare(client: Client, log: Log = () => {}): Promise<DemoState> {
  const fx = loadFixtures();
  const toolFailures: string[] = [];
  const shortlistListings: Record<string, unknown>[] = [];

  for (const l of fx.listings) {
    const entry: Record<string, unknown> = {
      listingRef: l.listingRef, url: l.url, title: l.title, companyName: l.companyName, accessStatus: l.accessStatus,
    };
    if (l.accessStatus === "not_accessible" || !l.text) {
      log(`${l.listingRef}: listing not accessible; no checks run, nothing assumed.`);
      shortlistListings.push(entry);
      continue;
    }
    const risk = await callTool(client, "check_internship_risk", { postingText: l.text, postingUrl: l.url, companyName: l.companyName });
    const company = await callTool(client, "verify_company", {
      companyName: l.companyName, country: fx.context.internshipCountry, ...(l.website ? { website: l.website } : {}),
    });
    const s = fx.student;
    const elig = await callTool(client, "check_student_eligibility", {
      internshipCountry: fx.context.internshipCountry,
      visaOrPermitType: fx.context.visaOrPermitType,
      studyLevel: s.studyLevel,
      currentlyEnrolled: s.currentlyEnrolled,
      ...(l.internship.durationWeeks ? { internshipDurationWeeks: l.internship.durationWeeks } : {}),
      ...(l.internship.hoursPerWeek ? { hoursPerWeek: l.internship.hoursPerWeek } : {}),
      ...(l.internship.isPaid !== undefined ? { isPaid: l.internship.isPaid } : {}),
      student: {
        major: s.major, skills: s.skills, hoursPerWeekAvailable: s.availability?.hoursPerWeek,
        availableFrom: s.availability?.startDate, availableUntil: s.availability?.endDate,
        workModes: s.availability?.workModes, locations: s.availability?.locations,
      },
      requirements: l.requirements,
    });
    for (const [name, r] of [["check_internship_risk", risk], ["verify_company", company], ["check_student_eligibility", elig]] as const) {
      if (r.result.status === "error") toolFailures.push(`${l.listingRef} ${name}: ${r.result.warnings[0] ?? "error"}`);
    }
    if (risk.result.investigationId) entry.riskInvestigationId = risk.result.investigationId;
    if (company.result.investigationId) entry.companyInvestigationId = company.result.investigationId;
    if (elig.result.investigationId) entry.eligibilityInvestigationId = elig.result.investigationId;
    log(`${l.listingRef}: risk=${(risk.result.data as { assessment?: string } | null)?.assessment ?? risk.result.status}, company=${(company.result.data as { verificationStatus?: string } | null)?.verificationStatus ?? company.result.status}, eligibility=${(elig.result.data as { outcome?: string } | null)?.outcome ?? elig.result.status}`);
    shortlistListings.push(entry);
  }

  const sl = await callTool<ShortlistData>(client, "shortlist_internships", { student: fx.student, listings: shortlistListings, maxShortlisted: 3 });
  if (!sl.result.data) throw new Error(`shortlist_internships failed: ${sl.result.warnings.join(" | ")}`);
  const shortlist = sl.result.data;

  const prepared: PreparedEntry[] = [];
  for (const e of shortlist.evaluations.filter((x) => x.decision === "shortlisted")) {
    const content = fx.packs[e.listingRef];
    if (!content) {
      prepared.push({ listingRef: e.listingRef, caseId: e.caseId, packageId: null, reviewUrl: null, reviewFlags: [], problems: ["No package content in fixtures"] });
      continue;
    }
    const p = await callTool<PreparedPackData>(client, "prepare_application_pack", { caseId: e.caseId, content });
    prepared.push({
      listingRef: e.listingRef,
      caseId: e.caseId,
      packageId: p.result.data?.packageId ?? null,
      reviewUrl: p.result.data?.reviewUrl ?? null,
      reviewFlags: p.result.data?.reviewFlags.map((f) => f.message) ?? [],
      problems: p.result.data ? [] : p.result.warnings,
    });
  }
  return {
    shortlistId: shortlist.shortlistId,
    evaluations: shortlist.evaluations.map(({ listingRef, decision, rank, score, reasons }) => ({ listingRef, decision, rank, score, reasons })),
    prepared,
    toolFailures,
  };
}

export interface ExecuteOutcome {
  saves: Array<{ listingRef: string; packageId: string; ok: boolean; data: SaveApprovedData | null; warnings: string[] }>;
  tracker: TrackerData | null;
  trackerWarnings: string[];
}

/** Steps 7-8: export what the student approved, then query the tracker. */
export async function runExecute(client: Client, state: DemoState): Promise<ExecuteOutcome> {
  const saves: ExecuteOutcome["saves"] = [];
  for (const p of state.prepared) {
    if (!p.packageId) continue;
    const r = await callTool<SaveApprovedData>(client, "save_approved_application", { packageId: p.packageId });
    saves.push({ listingRef: p.listingRef, packageId: p.packageId, ok: r.result.status === "success", data: r.result.data, warnings: r.result.warnings });
  }
  const t = await callTool<TrackerData>(client, "get_application_tracker", { shortlistId: state.shortlistId });
  return { saves, tracker: t.result.data, trackerWarnings: t.result.warnings };
}
