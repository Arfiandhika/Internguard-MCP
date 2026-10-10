/**
 * MCP registration for the execution layer: four tools and one prompt.
 * OWNER: Developer 1. Handlers live in Developer 2/4 modules.
 *
 * Deliberately absent: any tool that approves, submits or sends. Approval
 * happens only in the local approval interface (src/approval).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  InternGuardToolName,
  PrepareApplicationPackInput,
  ShortlistInput,
  ToolResult,
  TrackerInput,
} from "../shared/types.js";
import { shortlistInternships } from "../tools/shortlist.js";
import { openStudentDashboard } from "./dashboard.js";
import { saveApprovedApplication } from "./exporter.js";
import { prepareApplicationPack } from "./pack.js";
import { ID_PATTERNS } from "./store.js";
import { getApplicationTracker } from "./tracker.js";

export interface RegistrationHelpers {
  run: <I>(tool: InternGuardToolName, handler: (input: I) => Promise<ToolResult<unknown>>, input: I) => Promise<ToolResult<unknown>>;
  respond: (tool: InternGuardToolName, result: ToolResult<unknown>) => CallToolResult;
}

// ---- schemas ---------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const workMode = z.enum(["remote", "hybrid", "on-site"]);
const studyLevel = z.enum(["secondary", "diploma", "undergraduate", "postgraduate", "other"]);
const httpUrl = z
  .string()
  .max(2_048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");
const shortText = (max: number) => z.string().min(1).max(max);
const idOf = (re: RegExp, what: string) => z.string().regex(re, `must be a ${what} id issued by InternGuard`);

export const studentProfileSchema = z.object({
  name: shortText(120),
  major: shortText(120),
  studyLevel: studyLevel.optional(),
  currentlyEnrolled: z.boolean().optional(),
  skills: z.array(shortText(60)).min(1).max(60).describe("Only skills the student actually stated."),
  experience: z
    .array(z.object({ title: shortText(150), organization: z.string().max(150).optional(), description: z.string().max(1_000).optional() }))
    .max(20),
  availability: z
    .object({
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      hoursPerWeek: z.number().min(1).max(80).optional(),
      workModes: z.array(workMode).max(3).optional(),
      locations: z.array(z.string().max(100)).max(10).optional(),
    })
    .optional(),
  resumeText: z.string().max(20_000).optional().describe("Plain-text CV, used to check which claimed skills the CV evidences."),
  email: z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).optional(),
  phone: z.string().max(40).optional(),
});

const shortlistInput = z.object({
  student: studentProfileSchema,
  listings: z
    .array(
      z.object({
        listingRef: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).describe('Your label for the listing, e.g. "L1".'),
        url: httpUrl,
        title: z.string().max(200).optional(),
        companyName: z.string().max(200).optional(),
        applyUrl: httpUrl.optional(),
        accessStatus: z.enum(["accessed", "provided_by_student", "not_accessible"]),
        riskInvestigationId: idOf(ID_PATTERNS.investigation, "investigation").optional(),
        companyInvestigationId: idOf(ID_PATTERNS.investigation, "investigation").optional(),
        eligibilityInvestigationId: idOf(ID_PATTERNS.investigation, "investigation").optional(),
      }),
    )
    .min(1)
    .max(10),
  maxShortlisted: z.number().int().min(1).max(3).optional(),
});

const prepareInput = z.object({
  caseId: idOf(ID_PATTERNS.case, "case"),
  content: z.object({
    coverLetter: z.string().min(100).max(8_000),
    recruiterEmail: z.object({
      to: z.string().max(254).nullable().describe("Only an address that appears in the listing; otherwise null."),
      subject: shortText(200),
      body: z.string().min(20).max(5_000),
    }),
    checklist: z.array(shortText(300)).min(1).max(30),
    cvSuggestions: z.array(shortText(500)).max(30),
    missingInformation: z.array(shortText(300)).max(30),
    skillsReferenced: z.array(shortText(60)).max(60).describe("Every student skill the texts rely on."),
  }),
});

const saveInput = z.object({ packageId: idOf(ID_PATTERNS.package, "package") });

const trackerInput = z.object({
  shortlistId: idOf(ID_PATTERNS.shortlist, "shortlist").optional(),
  applicationId: idOf(ID_PATTERNS.application, "application").optional(),
  status: z.enum(["PREPARED", "AWAITING_APPROVAL", "REJECTED_BY_STUDENT", "READY_TO_SUBMIT", "MANUAL_ACTION_REQUIRED", "SUBMITTED"]).optional(),
});

// Compile-time drift checks against shared/types.ts
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _ExecutionSchemaChecks = [
  Assert<Same<z.infer<typeof shortlistInput>, ShortlistInput>>,
  Assert<Same<z.infer<typeof prepareInput>, PrepareApplicationPackInput>>,
  Assert<Same<z.infer<typeof trackerInput>, TrackerInput>>,
];

// ---- orchestration playbook (MCP prompt) ------------------------------------

export const PLAYBOOK = `You are running InternGuard's internship investigation and application-preparation workflow. Follow these steps exactly.

1. Collect from the student: up to 10 internship URLs, and their name, major, study level, enrolment, skills, experience, availability (dates, hours per week, work modes, locations), work-authorization status and CV text. Use only what the student tells you. Never add skills, projects, experience or achievements.

2. For EACH listing, obtain the listing text. You may use a simple read-only page fetch for public pages. NEVER use browser automation, and never use the student's logged-in sessions (LinkedIn, JobStreet, email or any other account). If a page is empty, needs a login or cannot be opened, do not guess its contents: ask the student to paste the text and use accessStatus "provided_by_student", or mark it "not_accessible". Use the clean URL without tracking parameters (no "?refId=..." part), and use exactly the same URL in every tool call for that listing.

3. For EACH accessible listing call, and keep the investigationId from each result:
   a. check_internship_risk with postingText (the listing text) and postingUrl (the listing URL, exactly as given).
   b. verify_company with the company name and website stated in the listing.
   c. check_student_eligibility with internshipCountry, the student's study level, enrolment and visa/permit status, a "student" object (major, skills, hoursPerWeekAvailable, availableFrom, availableUntil, workModes, locations) and a "requirements" object built ONLY from what the listing states.
   If a tool fails, continue with the other listings and report the failure.

4. Call shortlist_internships ONCE with the student profile and every listing (including inaccessible ones), passing the investigationIds. Do not pass tool results yourself. Report every listing's decision with its reasons, verified facts, assumptions and missing evidence. Never call a listing "safe"; say "no major scam indicators were found" instead.

5. For EACH shortlisted case, write: a tailored cover letter, a recruiter email draft (set "to" to null unless an address appears in the listing), an application checklist, CV improvement suggestions, and the missing information. Then call prepare_application_pack. If it reports blocking problems, fix the text (remove the unsupported claim or link) and call it again.

6. Call open_student_dashboard. It opens the student's browser on their dashboard, where they review and approve or reject each package (fallback if it fails: the student runs "npm run approval"). You cannot approve on their behalf: never open, fetch, browse to or submit anything on 127.0.0.1 or localhost, and never use a browser tool while the approval interface is running.

7. When the student says they have finished reviewing, call save_approved_application for each packageId. Packages without approval will be refused; report that rather than retrying.

8. Call get_application_tracker and report each application's status, the exported files (only those marked verified) and next steps. Tell the student they can open the files and record a submission on the dashboard (call open_student_dashboard again if they need it). Applications in MANUAL_ACTION_REQUIRED have NOT been submitted: the student must submit them at the application link. Never say an application was submitted unless its status is SUBMITTED.`;

// ---- registration ----------------------------------------------------------

export function registerExecutionTools(server: McpServer, h: RegistrationHelpers): void {
  server.registerTool(
    "shortlist_internships",
    {
      title: "Shortlist investigated internships",
      description:
        "Ranks investigated listings and selects up to 3. Pass investigationIds from check_internship_risk, verify_company and check_student_eligibility (never raw results). Rejects high-risk listings, unknown companies and ineligible matches; reports listings without evidence as insufficient_evidence. Returns caseIds for shortlisted listings.",
      inputSchema: shortlistInput.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => h.respond("shortlist_internships", await h.run("shortlist_internships", shortlistInternships, input)),
  );

  server.registerTool(
    "prepare_application_pack",
    {
      title: "Prepare an application package for review",
      description:
        "Stores your cover letter, email draft, checklist, CV suggestions and missing-information list for a shortlisted case as a hashed package awaiting the STUDENT's approval. Refuses content with skills not in the student's profile or contact details/links not in the listing. Returns a reviewUrl for the student. Does not submit or send anything.",
      inputSchema: prepareInput.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => h.respond("prepare_application_pack", await h.run("prepare_application_pack", prepareApplicationPack, input)),
  );

  server.registerTool(
    "save_approved_application",
    {
      title: "Export a student-approved application package",
      description:
        "Exports a package to local files (cover-letter.md, email-draft.md, checklist.md, cv-suggestions.md, application-summary.md) ONLY if the student approved this exact version in the approval interface. Idempotent. Never submits applications or sends email; afterwards the status is MANUAL_ACTION_REQUIRED.",
      inputSchema: saveInput.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => h.respond("save_approved_application", await h.run("save_approved_application", saveApprovedApplication, input)),
  );

  server.registerTool(
    "get_application_tracker",
    {
      title: "Application tracker",
      description:
        "Lists applications with status, approval record, exported files (re-verified on disk), follow-up tasks and history. Filter by shortlistId, applicationId or status.",
      inputSchema: trackerInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => h.respond("get_application_tracker", await h.run("get_application_tracker", getApplicationTracker, input)),
  );

  server.registerTool(
    "open_student_dashboard",
    {
      title: "Open the student's dashboard",
      description:
        "Opens the student's InternGuard dashboard in the student's own browser on this computer, starting it if needed. There the student reviews and approves packages, opens exported files and records submissions. Call it after preparing packages and whenever the student wants to see their applications. You cannot approve anything through it; never open the page yourself.",
      inputSchema: {},
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => h.respond("open_student_dashboard", await h.run("open_student_dashboard", openStudentDashboard, {})),
  );

  // Same playbook as a tool: some MCP clients (e.g. WorkBuddy desktop) may not surface MCP prompts.
  server.registerTool(
    "get_workflow_playbook",
    {
      title: "InternGuard workflow playbook",
      description:
        "Returns the step-by-step InternGuard workflow. Call this FIRST whenever the student asks to investigate internships or prepare applications, then follow it exactly.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      h.respond("get_workflow_playbook", {
        status: "success",
        data: { playbook: PLAYBOOK },
        evidence: [],
        warnings: [],
      }),
  );

  server.registerPrompt(
    "investigate_and_prepare",
    {
      title: "Investigate internships and prepare applications",
      description: "Step-by-step InternGuard workflow: investigate listings, shortlist, prepare packages, get student approval, export and track.",
    },
    () => ({ messages: [{ role: "user", content: { type: "text", text: PLAYBOOK } }] }),
  );
}
