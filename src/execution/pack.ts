/**
 * prepare_application_pack: validate agent-written content and store it as
 * an immutable, hashed package awaiting the student's approval.
 * OWNER: Developer 4.
 *
 * The agent writes the text; the server checks it against stored evidence.
 * BLOCKING problems (the pack is refused and nothing is stored):
 *   - a referenced skill that is not in the student's profile
 *   - an email address or link that appears nowhere in the listing, the
 *     company verification result or the student's own details
 *   - a recruiter "to" address that is not in the listing
 * REVIEW flags (stored and shown on the approval page):
 *   - placeholders, unlisted phone numbers, missing company/student name,
 *     requirement skills mentioned that the student does not list
 */
import type {
  ApplicationPackContent,
  CompanyVerificationData,
  EligibilityStudentProfile,
  InternshipRequirements,
  PreparedPackData,
  PrepareApplicationPackInput,
  ReviewFlag,
  ToolResult,
} from "../shared/types.js";
import { matchSkill } from "../tools/eligibility.js";
import { getPaths } from "./paths.js";
import { StateError, getCase, getInvestigation, packageHash, upsertPackage, type CaseRecord } from "./store.js";

const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,5}/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]{1,500}/gi;
const PHONE = /\+?\d[\d\s-]{7,16}\d/g;
const PLACEHOLDER = /\[(?:your|company|recruiter|hiring|insert|name)[^\]]{0,40}\]|<(?:your|company|name)[^>]{0,40}>|\b(?:lorem ipsum|TODO|TBD|XXX+)\b/i;

/** Text and identifiers the package is allowed to reference. */
export interface CaseEvidence {
  record: CaseRecord;
  listingText: string;
  requirements: InternshipRequirements | undefined;
  company: CompanyVerificationData | null;
}

export function loadCaseEvidence(caseId: string): CaseEvidence | null {
  const record = getCase(caseId);
  if (!record) return null;
  const risk = record.riskInvestigationId ? getInvestigation(record.riskInvestigationId) : null;
  const riskInput = (risk?.input ?? {}) as { postingText?: string; jobDescription?: string; recruiterContact?: string };
  const listingText = [riskInput.postingText ?? riskInput.jobDescription ?? "", riskInput.recruiterContact ?? ""].join("\n");
  const elig = record.eligibilityInvestigationId ? getInvestigation(record.eligibilityInvestigationId) : null;
  const company = record.companyInvestigationId ? getInvestigation(record.companyInvestigationId) : null;
  return {
    record,
    listingText,
    requirements: (elig?.input as { requirements?: InternshipRequirements; student?: EligibilityStudentProfile } | undefined)?.requirements,
    company: (company?.result.data as CompanyVerificationData | null | undefined) ?? null,
  };
}

function allTexts(c: ApplicationPackContent): string[] {
  return [c.coverLetter, c.recruiterEmail.subject, c.recruiterEmail.body, ...c.checklist, ...c.cvSuggestions, ...c.missingInformation];
}

function urlKey(u: string): string {
  try {
    const x = new URL(u.replace(/[.,;:!?]+$/, ""));
    return `${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u.toLowerCase();
  }
}

/** Returns blocking problems and review flags. Pure apart from its inputs. */
export function validatePackContent(content: ApplicationPackContent, ev: CaseEvidence): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const block = (message: string) => flags.push({ level: "blocking", message });
  const review = (message: string) => flags.push({ level: "review", message });
  const { student } = ev.record;
  const texts = allTexts(content);
  const joined = texts.join("\n");

  // skills
  // A skill is backed if the profile lists it or a specific skill that demonstrates it (Kali Linux -> Linux).
  const backed = (s: string) => {
    const m = matchSkill(student.skills, s).status;
    return m === "exact" || m === "implied";
  };
  for (const s of content.skillsReferenced) {
    if (!backed(s)) block(`Skill "${s}" is referenced but is not in the student's profile. Remove it or ask the student.`);
  }
  for (const reqSkill of ev.requirements?.requiredSkills ?? []) {
    if (!backed(reqSkill) && joined.toLowerCase().includes(reqSkill.toLowerCase())) {
      review(`The text mentions "${reqSkill}", which is not in your profile. Make sure it is not presented as a skill you have.`);
    }
  }

  // emails
  const listingEmails = new Set((ev.listingText.match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  const allowedEmails = new Set([...listingEmails, ...(student.email ? [student.email.toLowerCase()] : [])]);
  for (const e of new Set((joined.match(EMAIL) ?? []).map((x) => x.toLowerCase()))) {
    if (!allowedEmails.has(e)) block(`Email address ${e} does not appear in the listing or the student's details. Do not invent contact addresses.`);
  }
  const to = content.recruiterEmail.to?.trim().toLowerCase() ?? null;
  if (to !== null && !listingEmails.has(to)) {
    block(`Recruiter address ${to} is not in the listing. Set "to" to null and direct the student to the application link instead.`);
  }

  // links
  const allowedUrls = new Set(
    [ev.record.url, ev.record.applyUrl ?? "", ev.company?.officialWebsite ?? "", ...(ev.listingText.match(URL_RE) ?? [])]
      .filter(Boolean)
      .map(urlKey),
  );
  const allowedHosts = new Set([...allowedUrls].map((k) => k.split("/")[0]));
  for (const u of new Set(joined.match(URL_RE) ?? [])) {
    const key = urlKey(u);
    if (!allowedUrls.has(key) && !allowedHosts.has(key.split("/")[0])) block(`Link ${u} does not come from the listing or the verified company website.`);
  }

  // review-level checks
  const knownDigits = new Set(
    [...(ev.listingText.match(PHONE) ?? []), student.phone ?? ""].map((p) => p.replace(/\D/g, "")).filter((d) => d.length > 0),
  );
  for (const p of joined.match(PHONE) ?? []) {
    const digits = p.replace(/\D/g, "");
    if (digits.length >= 8 && !knownDigits.has(digits)) review(`Phone number "${p.trim()}" is not in the listing or your details; check it.`);
  }
  for (const t of texts) {
    const m = PLACEHOLDER.exec(t);
    if (m) {
      review(`Placeholder text "${m[0]}" must be filled in or removed.`);
      break;
    }
  }
  const companyName = ev.record.companyName;
  if (companyName && !content.coverLetter.toLowerCase().includes(companyName.toLowerCase().split(/\s+/)[0] ?? "")) {
    review(`The cover letter does not mention ${companyName}.`);
  }
  if (!content.coverLetter.toLowerCase().includes(student.name.toLowerCase().split(/\s+/)[0] ?? "")) {
    review("The cover letter does not include your name.");
  }
  return flags;
}

export async function prepareApplicationPack(input: PrepareApplicationPackInput): Promise<ToolResult<PreparedPackData>> {
  const ev = loadCaseEvidence(input.caseId);
  if (!ev) return { status: "error", data: null, evidence: [], warnings: [`Case ${input.caseId} not found. Use a caseId returned by shortlist_internships.`] };
  if (ev.record.decision !== "shortlisted") {
    return { status: "error", data: null, evidence: [], warnings: [`Case ${input.caseId} was not shortlisted (decision: ${ev.record.decision}); no package can be prepared for it.`] };
  }

  const flags = validatePackContent(input.content, ev);
  const blocking = flags.filter((f) => f.level === "blocking");
  if (blocking.length > 0) {
    return {
      status: "error",
      data: null,
      evidence: [],
      warnings: ["The package was NOT saved because it references information not backed by the student's profile or the listing:", ...blocking.map((b) => b.message)],
    };
  }

  const contentHash = packageHash(ev.record.caseId, input.content);
  try {
    const { application, pkg, reused } = upsertPackage({
      caseId: ev.record.caseId,
      applyUrl: ev.record.applyUrl ?? ev.record.url,
      content: input.content,
      contentHash,
      reviewFlags: flags,
    });
    const reviewUrl = `${getPaths().approvalBaseUrl}/review/${pkg.id}`;
    return {
      status: "success",
      data: {
        applicationId: application.id,
        packageId: pkg.id,
        version: pkg.version,
        contentHash,
        status: application.status,
        reviewUrl,
        reviewFlags: flags,
        reused,
      },
      evidence: [],
      warnings: [
        `Awaiting the student's approval. Ask the student to open ${reviewUrl} (approval server: "npm run approval"). The agent cannot approve.`,
        ...(reused ? ["Identical content was already prepared; the existing package was returned."] : []),
        ...flags.map((f) => `Review flag: ${f.message}`),
      ],
    };
  } catch (err) {
    if (err instanceof StateError) return { status: "error", data: null, evidence: [], warnings: [err.message] };
    throw err;
  }
}
