/**
 * shortlist_internships: rank investigated listings and pick up to three.
 * OWNER: Developer 2.
 *
 * Trust model: the agent passes investigation IDs, never investigation
 * results. Results are loaded from the database, and each one must belong to
 * the listing it is attached to (same URL for the scam check, same company
 * for verification, same student for eligibility). Anything that cannot be
 * tied to stored evidence is reported, not assumed.
 */
import type {
  CaseId,
  CompanyVerificationData,
  EligibilityStudentProfile,
  InternshipRequirements,
  ListingEvaluation,
  ShortlistData,
  ShortlistInput,
  ShortlistListingInput,
  StudentEligibilityData,
  StudentProfile,
  ToolResult,
} from "../shared/types.js";
import type { ScamRiskData } from "./scam-check.js";
import { normalizeCompanyName } from "./company-check.js";
import { normalizeSkill } from "./eligibility.js";
import {
  canonicalJson,
  findShortlistByRequestHash,
  getInvestigation,
  newId,
  saveShortlist,
  sha256,
  type CaseRecordInput,
  type StoredInvestigation,
} from "../execution/store.js";

export const SHORTLIST_NOTICE =
  "Shortlisting ranks listings by the evidence available. It is not a safety verdict: a shortlisted internship still needs your own checks through official company channels, and you should never pay a fee or share passwords or OTPs to get one.";

// ---------------------------------------------------------------------------
// Pure evaluation (unit-testable without a database)
// ---------------------------------------------------------------------------

export interface LoadedEvidence<D, I> {
  id: string;
  input: I;
  result: ToolResult<D>;
}

interface RiskInputStored {
  postingText?: string;
  postingUrl?: string;
  url?: string;
  jobDescription?: string;
}

interface EligibilityInputStored {
  requirements?: InternshipRequirements;
  student?: EligibilityStudentProfile;
}

export interface ListingContext {
  listing: ShortlistListingInput;
  student: StudentProfile;
  risk: LoadedEvidence<ScamRiskData, RiskInputStored> | null;
  company: LoadedEvidence<CompanyVerificationData, { companyName?: string }> | null;
  eligibility: LoadedEvidence<StudentEligibilityData, EligibilityInputStored> | null;
  /** Problems linking the supplied investigation IDs to this listing. */
  bindingProblems: string[];
}

export type PendingEvaluation = Omit<ListingEvaluation, "caseId" | "rank"> & { candidate: boolean };

export function evaluateListing(ctx: ListingContext): PendingEvaluation {
  const { listing, student } = ctx;
  const reasons: string[] = [];
  const verifiedFacts: string[] = [];
  const assumptions: string[] = [];
  const missingEvidence: string[] = [...ctx.bindingProblems];
  const base = {
    listingRef: listing.listingRef,
    url: listing.url,
    title: listing.title ?? null,
    companyName: listing.companyName ?? ctx.company?.result.data?.companyName ?? null,
    riskAssessment: ctx.risk?.result.data?.assessment ?? null,
    companyVerificationStatus: ctx.company?.result.data?.verificationStatus ?? null,
    eligibilityOutcome: ctx.eligibility?.result.data?.outcome ?? null,
  };
  const finish = (decision: ListingEvaluation["decision"], score: number | null, candidate = false): PendingEvaluation => ({
    ...base, decision, score, reasons, verifiedFacts, assumptions, missingEvidence, candidate,
  });

  // ---- access ----
  if (listing.accessStatus === "not_accessible") {
    reasons.push("The listing could not be accessed, so nothing about it was assessed or assumed.");
    missingEvidence.push("The listing text (open the link yourself or paste the description).");
    return finish("insufficient_evidence", null);
  }
  if (listing.accessStatus === "provided_by_student") assumptions.push("Listing text was supplied by the student, not retrieved from the URL.");

  // ---- scam risk (required) ----
  const risk = ctx.risk?.result;
  if (!risk || risk.status === "error" || !risk.data) {
    reasons.push("No usable scam check is linked to this listing, so it cannot be shortlisted.");
    missingEvidence.push("A check_internship_risk result for this listing's URL and text.");
    return finish("insufficient_evidence", null);
  }
  const postingText = ctx.risk?.input.postingText ?? ctx.risk?.input.jobDescription ?? "";
  const riskData = risk.data;
  if (riskData.assessment === "high_risk") {
    const sev = { high: 0, medium: 1, low: 2 } as const;
    const top = [...riskData.redFlags]
      .sort((a, b) => (a.basis === b.basis ? 0 : a.basis === "observed" ? -1 : 1) || sev[a.severity] - sev[b.severity])
      .slice(0, 3);
    reasons.push("Rejected: the scam check found strong risk indicators.");
    for (const f of top) reasons.push(`${f.basis === "observed" ? "Observed" : "Heuristic"}: ${f.description} ("${f.matchedText}")`);
    return finish("rejected", null);
  }
  if (riskData.assessment === "insufficient_evidence") {
    reasons.push("The scam check had too little information to assess this listing.");
    missingEvidence.push(...riskData.information.missing.map((m) => `Listing detail: ${m}`));
    return finish("insufficient_evidence", null);
  }
  if (riskData.assessment === "medium_risk") {
    reasons.push(`Caution: the scam check found warning signs (${riskData.redFlags.filter((f) => f.severity !== "low").map((f) => f.code).join(", ")}).`);
  } else {
    reasons.push("The scam check found no major indicators in the listing text (this is not a safety verdict).");
  }

  // ---- company verification ----
  let companyPoints = 5;
  const company = ctx.company?.result;
  if (!company?.data) {
    missingEvidence.push("A verify_company result for this employer.");
  } else {
    const c = company.data;
    const simulated = company.evidence.some((e) => e.source.startsWith("SIMULATED"));
    const tag = simulated ? " [SIMULATED registry fixture]" : "";
    if (c.verificationStatus === "not_found") {
      reasons.push(`Rejected: "${c.companyName}" was not found in the registry source checked${tag}.`);
      return finish("rejected", null);
    }
    if (c.verificationStatus === "verified") {
      companyPoints = 20;
      verifiedFacts.push(`Company registration matched: ${c.companyName}${c.registrationNumber ? ` (${c.registrationNumber})` : ""}${tag}.`);
    } else if (c.verificationStatus === "unverified") {
      companyPoints = 0;
      reasons.push(`Caution: company details conflict with the registry record${tag}: ${c.findings.join(" ")}`);
    } else {
      companyPoints = 8;
      missingEvidence.push(...(c.missingEvidence ?? ["Official registry confirmation of the company."]));
    }
  }

  // ---- eligibility ----
  const elig = ctx.eligibility?.result.data;
  let metRatio = 0.5;
  let preferredRatio = 1; // no preferred skills listed = nothing unmet
  if (!elig) {
    missingEvidence.push("A check_student_eligibility result comparing the student with this listing.");
  } else {
    const mandatory = elig.requirements.filter((r) => !r.description.startsWith("Preferred skill"));
    const preferred = elig.requirements.filter((r) => r.description.startsWith("Preferred skill"));
    if (elig.outcome === "not_eligible") {
      reasons.push("Rejected: the student does not meet these stated requirements:");
      for (const r of mandatory.filter((m) => m.met === false)) reasons.push(`Not met: ${r.description}`);
      return finish("rejected", null);
    }
    if (mandatory.length > 0) {
      metRatio = (mandatory.filter((r) => r.met === true).length + 0.5 * mandatory.filter((r) => r.met === null).length) / mandatory.length;
    }
    if (preferred.length > 0) preferredRatio = preferred.filter((r) => r.met === true).length / preferred.length;
    if (elig.outcome === "conditionally_eligible") reasons.push("Meets the stated requirements that could be checked; some could not be confirmed.");
    if (elig.outcome === "eligible") reasons.push("Meets all stated requirements that were checked.");
    missingEvidence.push(...elig.missingInformation.map((m) => `Student information: ${m}`));
  }

  // ---- cross-check agent-extracted requirements against the stored listing text ----
  const req = ctx.eligibility?.input.requirements;
  const text = postingText.toLowerCase();
  for (const skill of [...(req?.requiredSkills ?? []), ...(req?.majors ?? [])]) {
    if (containsTerm(text, skill)) verifiedFacts.push(`The listing text states the requirement "${skill}".`);
    else assumptions.push(`Requirement "${skill}" was supplied by the agent but does not appear verbatim in the listing text.`);
  }

  // ---- student claims vs CV text ----
  const resume = (student.resumeText ?? "").toLowerCase();
  const required = new Set((req?.requiredSkills ?? []).map(normalizeSkill));
  for (const skill of student.skills.filter((s) => required.has(normalizeSkill(s)))) {
    if (resume && containsTerm(resume, skill)) verifiedFacts.push(`The student's CV mentions "${skill}".`);
    else assumptions.push(`The student stated the skill "${skill}"; it does not appear in the CV text provided.`);
  }

  const riskPoints = riskData.assessment === "no_major_indicators_detected" ? 20 : 0;
  const score = Math.max(0, Math.min(100, Math.round(50 * metRatio + 10 * preferredRatio + companyPoints + riskPoints)));
  return finish("not_selected", score, true);
}

function containsTerm(haystack: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (t.length === 0) return false;
  const idx = haystack.indexOf(t);
  if (idx === -1) return false;
  const before = haystack[idx - 1] ?? " ";
  const after = haystack[idx + t.length] ?? " ";
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/** Rank candidates and mark the top `max` as shortlisted. Pure. */
export function rankEvaluations(pending: PendingEvaluation[], max: number): Array<PendingEvaluation & { rank: number | null }> {
  const order = pending
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.candidate)
    .sort((a, b) => (b.p.score ?? 0) - (a.p.score ?? 0) || a.i - b.i);
  const ranks = new Map<number, number>();
  order.forEach(({ i }, pos) => ranks.set(i, pos + 1));
  return pending.map((p, i) => {
    const rank = ranks.get(i) ?? null;
    if (rank !== null && rank <= max) return { ...p, decision: "shortlisted", rank };
    if (rank !== null) {
      return { ...p, rank, reasons: [...p.reasons, `Scored ${p.score}, below the top ${max} candidates.`] };
    }
    return { ...p, rank };
  });
}

// ---------------------------------------------------------------------------
// Binding checks: does each stored investigation belong to this listing?
// ---------------------------------------------------------------------------

export function normalizeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

function load<D, I>(
  id: string | undefined,
  tool: StoredInvestigation["tool"],
  label: string,
  problems: string[],
): LoadedEvidence<D, I> | null {
  if (!id) return null;
  const inv = getInvestigation(id);
  if (!inv) {
    problems.push(`${label}: investigation ${id} does not exist; it was ignored.`);
    return null;
  }
  if (inv.tool !== tool) {
    problems.push(`${label}: investigation ${id} is a ${inv.tool} result, not ${tool}; it was ignored.`);
    return null;
  }
  return { id: inv.id, input: inv.input as I, result: inv.result as ToolResult<D> };
}

export function buildContext(listing: ShortlistListingInput, student: StudentProfile): ListingContext {
  const problems: string[] = [];
  let risk = load<ScamRiskData, RiskInputStored>(listing.riskInvestigationId, "check_internship_risk", "Scam check", problems);
  let company = load<CompanyVerificationData, { companyName?: string }>(listing.companyInvestigationId, "verify_company", "Company check", problems);
  let eligibility = load<StudentEligibilityData, EligibilityInputStored>(
    listing.eligibilityInvestigationId, "check_student_eligibility", "Eligibility check", problems,
  );

  if (risk) {
    const checked = normalizeUrl(risk.input.postingUrl ?? risk.input.url);
    const target = normalizeUrl(listing.url);
    if (!checked || checked !== target) {
      problems.push(`Scam check ${risk.id} was run for ${checked ?? "no URL"}, not for this listing (${target ?? listing.url}); it was ignored.`);
      risk = null;
    }
  }
  if (company && listing.companyName) {
    const a = normalizeCompanyName(company.input.companyName ?? "");
    const b = normalizeCompanyName(listing.companyName);
    if (a !== b) {
      problems.push(`Company check ${company.id} was for "${company.input.companyName}", not "${listing.companyName}"; it was ignored.`);
      company = null;
    }
  }
  if (eligibility) {
    const s = eligibility.input.student;
    const profileSkills = new Set(student.skills.map(normalizeSkill));
    const extra = (s?.skills ?? []).filter((k) => !profileSkills.has(normalizeSkill(k)));
    if ((s?.major && s.major.toLowerCase() !== student.major.toLowerCase()) || extra.length > 0) {
      problems.push(
        `Eligibility check ${eligibility.id} used a different student profile${extra.length ? ` (skills not in the profile: ${extra.join(", ")})` : ""}; it was ignored.`,
      );
      eligibility = null;
    }
  }
  return { listing, student, risk, company, eligibility, bindingProblems: problems };
}

// ---------------------------------------------------------------------------
// Entry point used by the MCP tool
// ---------------------------------------------------------------------------

export async function shortlistInternships(input: ShortlistInput): Promise<ToolResult<ShortlistData>> {
  const max = Math.min(3, Math.max(1, input.maxShortlisted ?? 3));
  const refs = new Set<string>();
  for (const l of input.listings) {
    if (refs.has(l.listingRef)) {
      return { status: "error", data: null, evidence: [], warnings: [`Duplicate listingRef "${l.listingRef}". Each listing needs a unique ref.`] };
    }
    refs.add(l.listingRef);
  }

  const requestHash = sha256(canonicalJson({ ...input, maxShortlisted: max }));
  const existing = findShortlistByRequestHash(requestHash);
  if (existing) {
    return { status: "success", data: { ...existing, reused: true }, evidence: [], warnings: ["Identical request: returning the stored shortlist."] };
  }

  const ranked = rankEvaluations(input.listings.map((l) => evaluateListing(buildContext(l, input.student))), max);
  const shortlistId = newId("sl");
  const cases: CaseRecordInput[] = [];
  const evaluations: ListingEvaluation[] = ranked.map((r, i) => {
    const { candidate: _candidate, ...rest } = r;
    const listing = input.listings[i] as ShortlistListingInput;
    const evaluation: ListingEvaluation = { ...rest, caseId: newId("case") as CaseId };
    cases.push({
      evaluation,
      applyUrl: listing.applyUrl ?? listing.url,
      accessStatus: listing.accessStatus,
      riskInvestigationId: listing.riskInvestigationId ?? null,
      companyInvestigationId: listing.companyInvestigationId ?? null,
      eligibilityInvestigationId: listing.eligibilityInvestigationId ?? null,
    });
    return evaluation;
  });

  const data: ShortlistData = {
    shortlistId,
    reused: false,
    evaluations,
    shortlistedCaseIds: evaluations.filter((e) => e.decision === "shortlisted").map((e) => e.caseId),
    notice: SHORTLIST_NOTICE,
  };
  saveShortlist({ shortlistId, requestHash, student: input.student, maxShortlisted: max, result: data, cases });

  const warnings = [SHORTLIST_NOTICE];
  const insufficient = evaluations.filter((e) => e.decision === "insufficient_evidence").length;
  if (insufficient > 0) warnings.push(`${insufficient} listing(s) had insufficient evidence and were not assessed.`);
  if (data.shortlistedCaseIds.length < max) warnings.push(`Only ${data.shortlistedCaseIds.length} listing(s) qualified for the shortlist.`);

  return {
    status: insufficient > 0 ? "partial" : "success",
    data,
    evidence: evaluations.flatMap((e) =>
      e.verifiedFacts.map((f) => ({ source: `listing ${e.listingRef}`, description: f })),
    ),
    warnings,
  };
}
