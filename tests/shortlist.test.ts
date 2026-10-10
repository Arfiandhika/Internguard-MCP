/** Pure shortlisting logic (Developer 2). No database needed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateListing, normalizeUrl, rankEvaluations, type ListingContext } from "../src/tools/shortlist.js";
import type { StudentProfile } from "../src/shared/types.js";

const student: StudentProfile = { name: "Test Student", major: "Computer Science", skills: ["Python", "SQL"], experience: [], resumeText: "Python projects" };
const risk = (assessment: string, redFlags: unknown[] = []) => ({
  id: "inv_r", input: { postingText: "We need Python and SQL. Computer Science students.", postingUrl: "https://a.example/job" },
  result: { status: "success" as const, evidence: [], warnings: [], data: { assessment, redFlags, information: { missing: ["company identity"] } } as never },
});
const ctx = (over: Partial<ListingContext> = {}): ListingContext => ({
  listing: { listingRef: "L", url: "https://a.example/job", accessStatus: "accessed" },
  student, risk: risk("no_major_indicators_detected"), company: null, eligibility: null, bindingProblems: [], ...over,
});
const company = (verificationStatus: string) => ({ id: "inv_c", input: { companyName: "A" }, result: { status: "success" as const, evidence: [], warnings: [], data: { companyName: "A", verificationStatus, registrationNumber: null, registeredCountry: null, officialWebsite: null, findings: [] } as never } });
const elig = (outcome: string, met: Array<boolean | null>) => ({
  id: "inv_e", input: { requirements: { requiredSkills: ["Python", "Rust"] } },
  result: { status: "success" as const, evidence: [], warnings: [], data: { outcome, requirements: met.map((m, i) => ({ description: `Required skill: ${i}`, met: m })), missingInformation: [], disclaimer: "" } as never },
});

test("inaccessible listing is insufficient_evidence and nothing is assumed", () => {
  const e = evaluateListing(ctx({ listing: { listingRef: "L", url: "https://a.example/job", accessStatus: "not_accessible" }, risk: null }));
  assert.equal(e.decision, "insufficient_evidence");
  assert.equal(e.score, null);
});

test("no scam check means insufficient_evidence, never shortlisted", () => {
  assert.equal(evaluateListing(ctx({ risk: null })).decision, "insufficient_evidence");
});

test("high risk is rejected with observed evidence first", () => {
  const e = evaluateListing(ctx({ risk: risk("high_risk", [
    { code: "urgency", basis: "heuristic", severity: "low", description: "urgent", matchedText: "u" },
    { code: "fee", basis: "observed", severity: "high", description: "fee", matchedText: "pay RM100" },
  ]) }));
  assert.equal(e.decision, "rejected");
  assert.match(e.reasons[1] ?? "", /^Observed: fee/);
});

test("company not found is rejected; ineligible is rejected with unmet requirements", () => {
  assert.equal(evaluateListing(ctx({ company: company("not_found") })).decision, "rejected");
  const e = evaluateListing(ctx({ eligibility: elig("not_eligible", [true, false]) }));
  assert.equal(e.decision, "rejected");
  assert.ok(e.reasons.some((r) => r.startsWith("Not met:")));
});

test("verified facts vs assumptions: requirement not in listing text is an assumption", () => {
  const e = evaluateListing(ctx({ eligibility: elig("eligible", [true, true]) }));
  assert.ok(e.verifiedFacts.some((f) => f.includes('"Python"')));
  assert.ok(e.assumptions.some((a) => a.includes('"Rust"')));
});

test("the result never calls a listing safe", () => {
  const e = evaluateListing(ctx({ company: company("verified"), eligibility: elig("eligible", [true]) }));
  assert.match(e.reasons.join(" "), /not a safety verdict/);
  assert.doesNotMatch(JSON.stringify(e), /\bis safe\b/i);
});

test("ranking: top N shortlisted, the rest not_selected with a reason", () => {
  const mk = (score: number) => ({ ...evaluateListing(ctx()), score, candidate: true });
  const r = rankEvaluations([mk(50), mk(90), mk(70), mk(80)], 3);
  assert.deepEqual(r.map((x) => x.decision), ["not_selected", "shortlisted", "shortlisted", "shortlisted"]);
  assert.match(r[0]?.reasons.at(-1) ?? "", /below the top 3/);
});

test("URL normalisation for binding checks", () => {
  assert.equal(normalizeUrl("https://A.Example/job/#x"), "https://a.example/job");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
});
