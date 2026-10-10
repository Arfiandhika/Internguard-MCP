/** verify_company and check_student_eligibility (Developer 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCompany } from "../src/tools/company-check.js";
import { checkStudentEligibility } from "../src/tools/eligibility.js";

const registry = path.join(mkdtempSync(path.join(tmpdir(), "ig-reg-")), "reg.json");
writeFileSync(registry, JSON.stringify({ simulated: true, companies: [
  { name: "Acme Analytics Sdn Bhd", registrationNumber: "SIM-1", country: "Malaysia", website: "https://acme.example", status: "active" },
  { name: "Gone Ltd", registrationNumber: "SIM-2", country: "Malaysia", status: "dissolved" },
] }));

test("without a registry source the result is inconclusive, never verified", async () => {
  delete process.env.INTERNGUARD_SIMULATED_REGISTRY;
  const r = await verifyCompany({ companyName: "Acme Analytics Sdn Bhd" });
  assert.equal(r.data?.verificationStatus, "inconclusive");
  assert.equal(r.status, "partial");
});

test("registry matches are labelled SIMULATED", async () => {
  process.env.INTERNGUARD_SIMULATED_REGISTRY = registry;
  const r = await verifyCompany({ companyName: "ACME Analytics Sdn. Bhd.", website: "https://careers.acme.example" });
  assert.equal(r.data?.verificationStatus, "verified");
  assert.ok(r.evidence.every((e) => e.source.startsWith("SIMULATED")));
  assert.ok(r.warnings.some((w) => w.startsWith("SIMULATED")));
});

test("conflicts downgrade to unverified; absence from the fixture is inconclusive, never not_found", async () => {
  process.env.INTERNGUARD_SIMULATED_REGISTRY = registry;
  assert.equal((await verifyCompany({ companyName: "Acme Analytics Sdn Bhd", registrationNumber: "OTHER" })).data?.verificationStatus, "unverified");
  assert.equal((await verifyCompany({ companyName: "Acme Analytics Sdn Bhd", website: "https://acme-careers.example" })).data?.verificationStatus, "unverified");
  assert.equal((await verifyCompany({ companyName: "Gone Ltd" })).data?.verificationStatus, "unverified");
  const miss = await verifyCompany({ companyName: "Nobody Co" });
  assert.equal(miss.data?.verificationStatus, "inconclusive");
  assert.match(miss.data?.findings.join(" ") ?? "", /Not in the simulated demo registry/);
});

const base = { internshipCountry: "Malaysia", studyLevel: "undergraduate" as const, currentlyEnrolled: true, visaOrPermitType: "citizen" };

test("all requirements met -> eligible; one unmet -> not_eligible", async () => {
  const student = { major: "Computer Science", skills: ["JS", "SQL"], hoursPerWeekAvailable: 25, availableFrom: "2026-06-01", workModes: ["hybrid" as const] };
  const ok = await checkStudentEligibility({ ...base, student, requirements: { majors: ["computer science"], requiredSkills: ["JavaScript", "sql"], minHoursPerWeek: 20, startDate: "2026-06-15", workMode: "hybrid" } });
  assert.equal(ok.data?.outcome, "eligible");
  const no = await checkStudentEligibility({ ...base, student, requirements: { minHoursPerWeek: 40 } });
  assert.equal(no.data?.outcome, "not_eligible");
});

test("unknown facts are null, not guessed; preferred skills do not decide the outcome", async () => {
  const r = await checkStudentEligibility({ ...base, student: { skills: ["Python"] }, requirements: { requiredSkills: ["Python"], preferredSkills: ["PyTorch"], minHoursPerWeek: 20 } });
  assert.equal(r.data?.outcome, "conditionally_eligible");
  assert.ok(r.data?.requirements.some((q) => q.met === null));
  assert.ok(r.data?.missingInformation.some((m) => m.includes("hours")));
});

test("skills: specific skills demonstrate general ones; missing skills are unknown, not unmet", async () => {
  const r = await checkStudentEligibility({
    ...base,
    student: { major: "Computer Science (Cybersecurity)", skills: ["Kali Linux", "UNIX", "Wireshark", "MySQL"], hoursPerWeekAvailable: 40 },
    requirements: { requiredSkills: ["Linux", "Networking", "SQL", "Windows"], minHoursPerWeek: 40 },
  });
  const q = (k: string) => r.data?.requirements.find((x) => x.description.startsWith(`Required skill: ${k}`));
  assert.equal(q("Linux")?.met, true);
  assert.match(q("Linux")?.description ?? "", /shown by your skill "Kali Linux"/);
  assert.equal(q("Networking")?.met, true);
  assert.equal(q("SQL")?.met, true);
  assert.equal(q("Windows")?.met, null);
  assert.equal(r.data?.outcome, "conditionally_eligible", "a skill missing from the profile does not make the student ineligible");
  assert.ok(r.data?.missingInformation.some((m) => m.includes("Windows") && m.includes("only if you really have them")));
});

test("related skills are not proof; hard requirements still reject", async () => {
  const r = await checkStudentEligibility({ ...base, student: { skills: ["UNIX"], hoursPerWeekAvailable: 20 }, requirements: { requiredSkills: ["Linux"] } });
  const linux = r.data?.requirements.find((x) => x.description.startsWith("Required skill: Linux"));
  assert.equal(linux?.met, null);
  assert.match(linux?.description ?? "", /related to your skill "UNIX"/);
  const hours = await checkStudentEligibility({ ...base, student: { skills: ["Kali Linux"], hoursPerWeekAvailable: 20 }, requirements: { requiredSkills: ["Linux"], minHoursPerWeek: 40 } });
  assert.equal(hours.data?.outcome, "not_eligible");
  // "Java" must not be satisfied by "JavaScript"; one-letter skills only match exactly
  const j = await checkStudentEligibility({ ...base, student: { skills: ["JavaScript", "C++"] }, requirements: { requiredSkills: ["Java", "C"] } });
  assert.ok(j.data?.requirements.every((x) => x.met === null));
});

test("work authorization is never decided", async () => {
  const r = await checkStudentEligibility({ internshipCountry: "Malaysia", visaOrPermitType: "student pass", requirements: { requiresEnrollment: true }, currentlyEnrolled: true });
  const visa = r.data?.requirements.find((q) => q.description.includes("student pass"));
  assert.equal(visa?.met, null);
  assert.equal(r.data?.outcome, "conditionally_eligible");
  assert.match(r.data?.disclaimer ?? "", /not legal or immigration advice/);
});

test("no requirements -> unknown", async () => {
  assert.equal((await checkStudentEligibility({ internshipCountry: "Malaysia" })).data?.outcome, "unknown");
});
