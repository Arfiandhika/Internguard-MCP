/**
 * InternGuard shared contracts.
 *
 * OWNER: Developer 1 (MCP Core & Integration Lead).
 * Developers 2, 3 and 4 import from this file but must NOT edit it.
 * Any change here is a breaking change for the whole team: propose it in the
 * team channel first, then Developer 1 merges it.
 *
 * This file contains types only (no runtime code), so importing it is free.
 * Always import with `import type { ... } from "../shared/types.js";`
 */

// ---------------------------------------------------------------------------
// Generic tool result envelope (every tool returns this)
// ---------------------------------------------------------------------------

/**
 * - "success": the check ran fully and `data` is populated.
 * - "partial": the check ran but something was missing (a source timed out,
 *              input was incomplete). `data` is populated with what is known;
 *              `warnings` must explain what is missing.
 * - "error":   no usable result. `data` must be null; `warnings` must contain
 *              at least one human-readable reason.
 */
export type ToolStatus = "success" | "partial" | "error";

/** A single piece of supporting evidence for a conclusion. */
export interface Evidence {
  /** Where it came from: a URL, a registry name, or "posting_text" for the user's own input. */
  source: string;
  /** What the evidence shows, in one or two plain sentences. */
  description: string;
}

export interface ToolResult<T> {
  status: ToolStatus;
  data: T | null;
  evidence: Evidence[];
  warnings: string[];
}

export type Severity = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Tool 1: check_internship_risk  (Developer 2 -> src/tools/scam-check.ts)
// ---------------------------------------------------------------------------

export interface CheckInternshipRiskInput {
  /** Full text of the internship posting or recruiter message. Required. */
  postingText: string;
  /** Where the posting was found, if known. */
  postingUrl?: string;
  /** Company name as claimed in the posting. */
  companyName?: string;
  /** Recruiter email, phone number or messaging handle as given in the posting. */
  recruiterContact?: string;
}

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface RedFlag {
  /** Stable machine-readable id, snake_case, e.g. "upfront_payment_requested". */
  code: string;
  /** Plain-language explanation for the student. */
  description: string;
  severity: Severity;
}

export interface InternshipRiskData {
  riskLevel: RiskLevel;
  /** 0 (no risk signals) to 100 (almost certainly a scam); null if not computed. */
  riskScore: number | null;
  redFlags: RedFlag[];
  /** One or two sentences of practical advice for the student. */
  recommendation: string;
}

export type CheckInternshipRiskHandler = (
  input: CheckInternshipRiskInput,
) => Promise<ToolResult<InternshipRiskData>>;

// ---------------------------------------------------------------------------
// Tool 2: verify_company  (Developer 3 -> src/tools/company-check.ts)
// ---------------------------------------------------------------------------

export interface VerifyCompanyInput {
  companyName: string;
  /** Country where the company claims to be registered (name or ISO 3166-1 alpha-2 code). */
  country?: string;
  /** Website as claimed by the company or posting. */
  website?: string;
  /** Business registration number, if the posting shows one. */
  registrationNumber?: string;
}

export type CompanyVerificationStatus =
  | "verified" // matched in an authoritative source
  | "unverified" // some signals found, but no authoritative match
  | "not_found" // searched, nothing found
  | "inconclusive"; // could not complete the search

export interface CompanyVerificationData {
  companyName: string;
  verificationStatus: CompanyVerificationStatus;
  registrationNumber: string | null;
  registeredCountry: string | null;
  officialWebsite: string | null;
  /** Short factual findings, one per line. */
  findings: string[];
  /** Evidence that would be needed to raise confidence (optional). */
  missingEvidence?: string[];
}

export type VerifyCompanyHandler = (
  input: VerifyCompanyInput,
) => Promise<ToolResult<CompanyVerificationData>>;

// ---------------------------------------------------------------------------
// Tool 3: check_student_eligibility  (Developer 3 -> src/tools/eligibility.ts)
// ---------------------------------------------------------------------------

export type StudyLevel = "secondary" | "diploma" | "undergraduate" | "postgraduate" | "other";

export interface CheckStudentEligibilityInput {
  /** Country where the internship takes place. Required. */
  internshipCountry: string;
  studentNationality?: string;
  /** e.g. "student pass", "F-1", "Tier 4", or "citizen". Free text. */
  visaOrPermitType?: string;
  studyLevel?: StudyLevel;
  currentlyEnrolled?: boolean;
  age?: number;
  internshipDurationWeeks?: number;
  hoursPerWeek?: number;
  isPaid?: boolean;
  /** Optional: the student's profile, for matching against the listing's requirements. */
  student?: EligibilityStudentProfile;
  /** Optional: requirements stated in the listing (as extracted by the agent). */
  requirements?: InternshipRequirements;
}

export type WorkMode = "remote" | "hybrid" | "on-site";

export interface EligibilityStudentProfile {
  major?: string;
  skills?: string[];
  hoursPerWeekAvailable?: number;
  /** ISO date YYYY-MM-DD */
  availableFrom?: string;
  /** ISO date YYYY-MM-DD */
  availableUntil?: string;
  workModes?: WorkMode[];
  locations?: string[];
}

export interface InternshipRequirements {
  majors?: string[];
  studyLevels?: StudyLevel[];
  requiresEnrollment?: boolean;
  requiredSkills?: string[];
  preferredSkills?: string[];
  minHoursPerWeek?: number;
  /** ISO date YYYY-MM-DD */
  startDate?: string;
  /** ISO date YYYY-MM-DD */
  endDate?: string;
  workMode?: WorkMode;
  location?: string;
}

export type EligibilityOutcome =
  | "eligible"
  | "conditionally_eligible"
  | "not_eligible"
  | "unknown";

export interface EligibilityRequirement {
  description: string;
  /** true = met, false = not met, null = cannot tell from the input. */
  met: boolean | null;
}

export interface StudentEligibilityData {
  outcome: EligibilityOutcome;
  requirements: EligibilityRequirement[];
  /** Input fields that would change or firm up the outcome if provided. */
  missingInformation: string[];
  /** Must state that this is informational and not legal or immigration advice. */
  disclaimer: string;
}

export type CheckStudentEligibilityHandler = (
  input: CheckStudentEligibilityInput,
) => Promise<ToolResult<StudentEligibilityData>>;

// ---------------------------------------------------------------------------
// Report formatter  (Developer 4 -> src/report/formatter.ts)
// ---------------------------------------------------------------------------

export type InternGuardToolName =
  | "hello_internguard"
  | "check_internship_risk"
  | "verify_company"
  | "check_student_eligibility"
  | "shortlist_internships"
  | "prepare_application_pack"
  | "save_approved_application"
  | "get_application_tracker"
  | "get_workflow_playbook"
  | "open_student_dashboard";

export type InvestigationToolName = "check_internship_risk" | "verify_company" | "check_student_eligibility";

/**
 * Turns a ToolResult into the human-readable text the MCP client shows.
 * Must be synchronous, must not throw, must not write to stdout.
 * Return Markdown-friendly plain text.
 */
export type FormatReportFn = (toolName: InternGuardToolName, result: ToolResult<unknown>) => string;

// ---------------------------------------------------------------------------
// hello_internguard (Developer 1, connection test)
// ---------------------------------------------------------------------------

/** "module" = the developer's real file was loaded; "stub" = temporary fallback in use. */
export type ModuleSource = "module" | "stub";

export type IntegrationComponent =
  | "check_internship_risk"
  | "verify_company"
  | "check_student_eligibility"
  | "formatter";

export interface HelloData {
  message: string;
  server: { name: string; version: string };
  timestamp: string;
  modules: Record<IntegrationComponent, ModuleSource>;
  execution?: { database: "ok" | "unavailable"; detail: string };
}

// ===========================================================================
// EXECUTION LAYER CONTRACTS (shortlisting, packages, approval, tracking)
// Owners: Developer 2 (shortlist), Developer 4 (packages, persistence,
// approval, export, tracker), Developer 1 (registration). Types only.
// ===========================================================================

/** Server-generated identifiers. Format: <prefix>_<uuid v4>. Never accept other formats. */
export type InvestigationId = `inv_${string}`;
export type ShortlistId = `sl_${string}`;
export type CaseId = `case_${string}`;
export type ApplicationId = `app_${string}`;
export type PackageId = `pkg_${string}`;

// ---- shortlist_internships (Developer 2: src/tools/shortlist.ts) ----------

export interface StudentExperience {
  title: string;
  organization?: string;
  description?: string;
}

export interface StudentProfile {
  name: string;
  major: string;
  studyLevel?: StudyLevel;
  currentlyEnrolled?: boolean;
  skills: string[];
  experience: StudentExperience[];
  availability?: {
    startDate?: string;
    endDate?: string;
    hoursPerWeek?: number;
    workModes?: WorkMode[];
    locations?: string[];
  };
  /** Plain-text CV. Used only to check which claimed skills the CV itself evidences. */
  resumeText?: string;
  email?: string;
  phone?: string;
}

/** How the agent obtained the listing text. */
export type ListingAccessStatus = "accessed" | "provided_by_student" | "not_accessible";

export interface ShortlistListingInput {
  /** Agent-chosen label, unique within the request, e.g. "L1". */
  listingRef: string;
  url: string;
  title?: string;
  companyName?: string;
  /** Direct link where the student submits the application (defaults to url). */
  applyUrl?: string;
  accessStatus: ListingAccessStatus;
  riskInvestigationId?: string;
  companyInvestigationId?: string;
  eligibilityInvestigationId?: string;
}

export interface ShortlistInput {
  student: StudentProfile;
  listings: ShortlistListingInput[];
  /** 1..3, default 3 */
  maxShortlisted?: number;
}

export type ShortlistDecision = "shortlisted" | "not_selected" | "rejected" | "insufficient_evidence";

export interface ListingEvaluation {
  listingRef: string;
  caseId: CaseId;
  url: string;
  title: string | null;
  companyName: string | null;
  decision: ShortlistDecision;
  rank: number | null;
  /** 0..100 relative suitability; only meaningful for comparison within one shortlist. */
  score: number | null;
  reasons: string[];
  /** Facts backed by a stored tool result or by verbatim listing/CV text. */
  verifiedFacts: string[];
  /** Things taken on trust from the agent or student and not checked. */
  assumptions: string[];
  missingEvidence: string[];
  riskAssessment: string | null;
  companyVerificationStatus: string | null;
  eligibilityOutcome: string | null;
}

export interface ShortlistData {
  shortlistId: ShortlistId;
  /** true if an identical request was already processed and its stored result was returned. */
  reused: boolean;
  evaluations: ListingEvaluation[];
  shortlistedCaseIds: CaseId[];
  /** Always present: shortlisting is not a safety verdict. */
  notice: string;
}

// ---- application packages (Developer 4: src/execution/*) ------------------

export type ApplicationStatus =
  | "PREPARED"
  | "AWAITING_APPROVAL"
  | "REJECTED_BY_STUDENT"
  | "READY_TO_SUBMIT"
  | "MANUAL_ACTION_REQUIRED"
  | "SUBMITTED";

export interface RecruiterEmailDraft {
  /** Must appear in the stored listing text, or be null. Never invented. */
  to: string | null;
  subject: string;
  body: string;
}

/** Content generated by the agent (WorkBuddy). The server validates but never writes it. */
export interface ApplicationPackContent {
  coverLetter: string;
  recruiterEmail: RecruiterEmailDraft;
  checklist: string[];
  cvSuggestions: string[];
  missingInformation: string[];
  /** Every student skill the texts rely on. Each must exist in the student's profile. */
  skillsReferenced: string[];
}

export interface PrepareApplicationPackInput {
  caseId: string;
  content: ApplicationPackContent;
}

export type ReviewFlagLevel = "blocking" | "review";

export interface ReviewFlag {
  level: ReviewFlagLevel;
  message: string;
}

export interface PreparedPackData {
  applicationId: ApplicationId;
  packageId: PackageId;
  version: number;
  contentHash: string;
  status: ApplicationStatus;
  /** Local approval page. The student must open it; the agent cannot approve. */
  reviewUrl: string;
  reviewFlags: ReviewFlag[];
  reused: boolean;
}

export interface ExportedFile {
  name: string;
  /** Path relative to the exports root. */
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface SaveApprovedData {
  applicationId: ApplicationId;
  packageId: PackageId;
  status: ApplicationStatus;
  exportDirectory: string;
  files: ExportedFile[];
  applyUrl: string | null;
  nextAction: string;
  /** true if this exact approved package had already been exported. */
  alreadyExported: boolean;
}

export interface FollowUpTask {
  id: string;
  kind: string;
  description: string;
  dueDate: string | null;
  status: "open" | "done";
}

export interface TrackedFile extends ExportedFile {
  /** Checked at query time: exists on disk and sha256 still matches. */
  verified: boolean;
}

export interface TrackedApplication {
  applicationId: ApplicationId;
  caseId: CaseId;
  shortlistId: ShortlistId;
  title: string | null;
  companyName: string | null;
  url: string;
  applyUrl: string | null;
  status: ApplicationStatus;
  currentPackage: { packageId: PackageId; version: number; contentHash: string } | null;
  approval: { decision: "approved" | "rejected"; decidedAt: string; contentHash: string; matchesCurrentPackage: boolean } | null;
  files: TrackedFile[];
  submission: { submittedAt: string; evidence: string } | null;
  followUps: FollowUpTask[];
  history: { at: string; event: string; from: ApplicationStatus | null; to: ApplicationStatus | null }[];
  updatedAt: string;
}

export interface TrackerInput {
  shortlistId?: string;
  applicationId?: string;
  status?: ApplicationStatus;
}

export interface DashboardData {
  /** Base URL only; never contains a login token. */
  dashboardUrl: string;
  /** true if this call had to start the dashboard. */
  started: boolean;
  browserOpened: boolean;
}

export interface TrackerData {
  applications: TrackedApplication[];
  /** Where the student can see this tracker, open files and record submissions. */
  dashboardUrl?: string;
  counts: Partial<Record<ApplicationStatus, number>>;
  exportsRoot: string;
  databasePath: string;
}
