#!/usr/bin/env node
/**
 * InternGuard MCP server (stdio transport).
 *
 * OWNER: Developer 1 (MCP Core & Integration Lead).
 *
 * STDOUT IS RESERVED FOR MCP JSON-RPC MESSAGES. Never write to it.
 * All logging goes to stderr. console.log/info/debug are redirected to
 * stderr below as a safety net for code in other modules.
 *
 * Integration model: at startup this file tries to load each teammate's
 * module (see MODULES). If the file is absent, a clearly marked TEMPORARY
 * STUB is used instead. Teammates never need to edit this file: merging
 * their module and rebuilding is the whole integration step.
 */

// ---- stdout guard --------------------------------------------------------------
// Static imports below are hoisted and evaluate first, but none of them log.
// Teammates' modules are loaded dynamically later, so they are covered.
const redirectToStderr = (...args: unknown[]): void => {
  console.error(...args);
};
console.log = redirectToStderr;
console.info = redirectToStderr;
console.debug = redirectToStderr;

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { closeAllDbs, databaseHealth } from "./execution/db.js";
import { registerExecutionTools } from "./execution/register.js";
import { recordInvestigation } from "./execution/store.js";
import type {
  CheckInternshipRiskHandler,
  CheckInternshipRiskInput,
  CheckStudentEligibilityHandler,
  CheckStudentEligibilityInput,
  FormatReportFn,
  HelloData,
  IntegrationComponent,
  InternGuardToolName,
  InvestigationToolName,
  ModuleSource,
  ToolResult,
  VerifyCompanyHandler,
  VerifyCompanyInput,
} from "./shared/types.js";

export const SERVER_NAME = "internguard-mcp";
export const SERVER_VERSION = "0.1.0"; // keep in sync with package.json

const TOOL_TIMEOUT_MS = parsePositiveInt(process.env.INTERNGUARD_TOOL_TIMEOUT_MS, 30_000);

// ---------------------------------------------------------------------------
// Logging (stderr only)
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLogLevel =
  LOG_LEVELS[(process.env.INTERNGUARD_LOG_LEVEL ?? "info") as LogLevel] ?? LOG_LEVELS.info;

export const log = {
  debug: (msg: string, extra?: unknown) => writeLog("debug", msg, extra),
  info: (msg: string, extra?: unknown) => writeLog("info", msg, extra),
  warn: (msg: string, extra?: unknown) => writeLog("warn", msg, extra),
  error: (msg: string, extra?: unknown) => writeLog("error", msg, extra),
};

function writeLog(level: LogLevel, msg: string, extra?: unknown): void {
  if (LOG_LEVELS[level] < minLogLevel) return;
  let line = `${new Date().toISOString()} [internguard] ${level.toUpperCase()} ${msg}`;
  if (extra !== undefined) {
    line += ` ${extra instanceof Error ? (extra.stack ?? extra.message) : safeStringify(extra)}`;
  }
  process.stderr.write(line + "\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Input schemas (zod). Each is checked at compile time against the
// interfaces in shared/types.ts, so the two can never drift apart.
// ---------------------------------------------------------------------------

const helloInput = z.object({
  name: z.string().max(100).optional().describe("Optional name to greet."),
});

const checkInternshipRiskInput = z.object({
  postingText: z
    .string()
    .min(1)
    .max(20_000)
    .describe("Full text of the internship posting or recruiter message."),
  postingUrl: z.string().max(2_000).optional().describe("Where the posting was found."),
  companyName: z.string().max(200).optional().describe("Company name as claimed in the posting."),
  recruiterContact: z
    .string()
    .max(300)
    .optional()
    .describe("Recruiter email, phone number or messaging handle as given in the posting."),
});

const verifyCompanyInput = z.object({
  companyName: z.string().min(1).max(200).describe("Company name to verify."),
  country: z
    .string()
    .max(100)
    .optional()
    .describe("Country where the company claims to be registered (name or ISO code)."),
  website: z.string().max(2_000).optional().describe("Website claimed by the company or posting."),
  registrationNumber: z.string().max(100).optional().describe("Business registration number, if shown."),
});

const checkStudentEligibilityInput = z.object({
  internshipCountry: z.string().min(1).max(100).describe("Country where the internship takes place."),
  studentNationality: z.string().max(100).optional(),
  visaOrPermitType: z
    .string()
    .max(100)
    .optional()
    .describe('Current visa or permit, e.g. "student pass", or "citizen".'),
  studyLevel: z.enum(["secondary", "diploma", "undergraduate", "postgraduate", "other"]).optional(),
  currentlyEnrolled: z.boolean().optional(),
  age: z.number().int().min(10).max(100).optional(),
  internshipDurationWeeks: z.number().int().min(1).max(104).optional(),
  hoursPerWeek: z.number().min(0).max(168).optional(),
  isPaid: z.boolean().optional(),
  student: z
    .object({
      major: z.string().max(120).optional(),
      skills: z.array(z.string().min(1).max(60)).max(60).optional(),
      hoursPerWeekAvailable: z.number().min(0).max(168).optional(),
      availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      availableUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      workModes: z.array(z.enum(["remote", "hybrid", "on-site"])).max(3).optional(),
      locations: z.array(z.string().max(100)).max(10).optional(),
    })
    .optional()
    .describe("The student's profile, for matching against the listing's requirements."),
  requirements: z
    .object({
      majors: z.array(z.string().max(120)).max(20).optional(),
      studyLevels: z.array(z.enum(["secondary", "diploma", "undergraduate", "postgraduate", "other"])).max(5).optional(),
      requiresEnrollment: z.boolean().optional(),
      requiredSkills: z.array(z.string().min(1).max(60)).max(40).optional(),
      preferredSkills: z.array(z.string().min(1).max(60)).max(40).optional(),
      minHoursPerWeek: z.number().min(0).max(168).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      workMode: z.enum(["remote", "hybrid", "on-site"]).optional(),
      location: z.string().max(100).optional(),
    })
    .optional()
    .describe("Requirements stated in the listing. Only include what the listing actually says."),
});

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Same keys AND same value types. (Assignability alone misses renamed optional keys.) */
type SameShape<A, B> = MutuallyAssignable<keyof A, keyof B> extends true ? MutuallyAssignable<A, B> : false;
type AssertTrue<T extends true> = T;
// If any of these lines fails to compile, a zod schema and its interface in shared/types.ts disagree.
export type _SchemaContractChecks = [
  AssertTrue<SameShape<z.infer<typeof checkInternshipRiskInput>, CheckInternshipRiskInput>>,
  AssertTrue<SameShape<z.infer<typeof verifyCompanyInput>, VerifyCompanyInput>>,
  AssertTrue<
    SameShape<z.infer<typeof checkStudentEligibilityInput>, CheckStudentEligibilityInput>
  >,
];

// ---------------------------------------------------------------------------
// Teammate modules: where they live and what they must export
// ---------------------------------------------------------------------------

interface ModuleSpec {
  /** Path relative to this file, with .js extension (works for dist/ and for tsx on src/). */
  file: string;
  exportName: string;
  owner: string;
}

const MODULES: Record<IntegrationComponent, ModuleSpec> = {
  check_internship_risk: { file: "./tools/scam-check.js", exportName: "checkInternshipRisk", owner: "Developer 2" },
  verify_company: { file: "./tools/company-check.js", exportName: "verifyCompany", owner: "Developer 3" },
  check_student_eligibility: {
    file: "./tools/eligibility.js",
    exportName: "checkStudentEligibility",
    owner: "Developer 3",
  },
  formatter: { file: "./report/formatter.js", exportName: "formatReport", owner: "Developer 4" },
};

export interface InternGuardDeps {
  checkInternshipRisk: CheckInternshipRiskHandler;
  verifyCompany: VerifyCompanyHandler;
  checkStudentEligibility: CheckStudentEligibilityHandler;
  formatReport: FormatReportFn;
  sources: Record<IntegrationComponent, ModuleSource>;
}

// ---- TEMPORARY STUBS -------------------------------------------------------
// Used only while a teammate's module is missing. They perform NO analysis and
// return status "error" so the client model never presents them as a verdict.

function makeStub<I, O>(tool: IntegrationComponent): (input: I) => Promise<ToolResult<O>> {
  const spec = MODULES[tool];
  return async () => ({
    status: "error",
    data: null,
    evidence: [],
    warnings: [
      `TEMPORARY STUB: "${tool}" is not implemented yet (owner: ${spec.owner}, expected file: src${spec.file.slice(1).replace(/\.js$/, ".ts")}). ` +
        "Input was received and validated, but no assessment was performed. Do not present this as a result.",
    ],
  });
}

const stubFormatReport: FormatReportFn = (toolName, result) =>
  `InternGuard: ${toolName} (status: ${result.status})\n\n` +
  "```json\n" +
  JSON.stringify(result, null, 2) +
  "\n```\n\n_[TEMPORARY FORMATTER: raw JSON shown until src/report/formatter.ts is merged]_";

// ---- loader ----------------------------------------------------------------

async function loadExport<F>(
  component: IntegrationComponent,
  fallback: F,
): Promise<{ fn: F; source: ModuleSource }> {
  const spec = MODULES[component];
  const url = new URL(spec.file, import.meta.url);
  try {
    const mod = (await import(url.href)) as Record<string, unknown>;
    const candidate = mod[spec.exportName];
    if (typeof candidate === "function") {
      log.info(`Loaded ${component} from ${spec.file} (export "${spec.exportName}")`);
      return { fn: candidate as F, source: "module" };
    }
    log.error(
      `${spec.file} loaded but has no exported function "${spec.exportName}" (${spec.owner}). Using TEMPORARY STUB.`,
    );
  } catch (err) {
    if (isMissingModule(err, url)) {
      log.info(`${spec.file} not present yet (${spec.owner}). Using TEMPORARY STUB for ${component}.`);
    } else {
      // The file exists but crashed while loading: a real bug, so be loud.
      log.error(`${spec.file} failed to load (${spec.owner}). Using TEMPORARY STUB.`, err);
    }
  }
  return { fn: fallback, source: "stub" };
}

/** True only if the module file itself is missing (not one of its own imports). */
function isMissingModule(err: unknown, url: URL): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  const jsPath = fileURLToPath(url);
  const tsPath = jsPath.replace(/\.js$/, ".ts");
  const firstLine = err.message.split("\n")[0] ?? "";
  // Node: "Cannot find module '<path>' imported from <importer>"
  const missing = /Cannot find module '([^']+)'/.exec(firstLine)?.[1];
  return missing === jsPath || missing === tsPath || missing === url.href;
}

export async function loadDependencies(): Promise<InternGuardDeps> {
  const [risk, company, eligibility, formatter] = await Promise.all([
    loadExport<CheckInternshipRiskHandler>("check_internship_risk", makeStub("check_internship_risk")),
    loadExport<VerifyCompanyHandler>("verify_company", makeStub("verify_company")),
    loadExport<CheckStudentEligibilityHandler>("check_student_eligibility", makeStub("check_student_eligibility")),
    loadExport<FormatReportFn>("formatter", stubFormatReport),
  ]);
  return {
    checkInternshipRisk: risk.fn,
    verifyCompany: company.fn,
    checkStudentEligibility: eligibility.fn,
    formatReport: formatter.fn,
    sources: {
      check_internship_risk: risk.source,
      verify_company: company.source,
      check_student_eligibility: eligibility.source,
      formatter: formatter.source,
    },
  };
}

// ---------------------------------------------------------------------------
// Safe execution: timeout, exception capture, result-shape validation
// ---------------------------------------------------------------------------

function errorResult(message: string): ToolResult<never> {
  return { status: "error", data: null, evidence: [], warnings: [message] };
}

function isToolResult(value: unknown): value is ToolResult<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    (r.status === "success" || r.status === "partial" || r.status === "error") &&
    "data" in r &&
    Array.isArray(r.evidence) &&
    r.evidence.every(
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Record<string, unknown>).source === "string" &&
        typeof (e as Record<string, unknown>).description === "string",
    ) &&
    Array.isArray(r.warnings) &&
    r.warnings.every((w: unknown) => typeof w === "string")
  );
}

async function runSafely<I>(
  tool: InternGuardToolName,
  handler: (input: I) => Promise<ToolResult<unknown>>,
  input: I,
): Promise<ToolResult<unknown>> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${TOOL_TIMEOUT_MS} ms`)), TOOL_TIMEOUT_MS);
    });
    const result: unknown = await Promise.race([handler(input), timeout]);
    if (!isToolResult(result)) {
      log.error(`${tool} returned a value that does not match ToolResult<T>`, result);
      return errorResult(`Internal error: ${tool} returned a malformed result.`);
    }
    log.info(`${tool} finished: status=${result.status} in ${Date.now() - started} ms`);
    return result;
  } catch (err) {
    log.error(`${tool} threw`, err);
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Internal error while running ${tool}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

function toCallToolResult(
  tool: InternGuardToolName,
  result: ToolResult<unknown>,
  formatReport: FormatReportFn,
): CallToolResult {
  let text: string;
  try {
    const formatted: unknown = formatReport(tool, result);
    text = typeof formatted === "string" ? formatted : stubFormatReport(tool, result);
  } catch (err) {
    log.error(`formatReport threw for ${tool}; falling back to raw JSON`, err);
    text = stubFormatReport(tool, result);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...result },
    isError: result.status === "error",
  };
}

/**
 * Persist an investigation result and expose its id. If persistence fails the
 * result is still returned, with a warning that it cannot be shortlisted.
 */
function withInvestigationRecord(
  tool: InvestigationToolName,
  input: unknown,
  result: ToolResult<unknown>,
  formatReport: FormatReportFn,
): CallToolResult {
  let investigationId: string | null = null;
  let annotated = result;
  try {
    investigationId = recordInvestigation(tool, input, result);
  } catch (err) {
    log.error(`Could not persist ${tool} result`, err);
    annotated = {
      ...result,
      warnings: [...result.warnings, "This result could not be saved, so it cannot be used by shortlist_internships."],
    };
  }
  const call = toCallToolResult(tool, annotated, formatReport);
  const text = call.content[0];
  if (investigationId && text?.type === "text") text.text = `investigationId: ${investigationId}\n\n${text.text}`;
  return { ...call, structuredContent: { ...annotated, investigationId } };
}

// ---------------------------------------------------------------------------
// Server construction (exported so tests can use an in-memory transport)
// ---------------------------------------------------------------------------

export function createInternGuardServer(deps: InternGuardDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "hello_internguard",
    {
      title: "InternGuard connection test",
      description:
        "Connection test. Confirms the InternGuard MCP server is reachable and reports which checks are live and which are still temporary stubs.",
      inputSchema: helloInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const result: ToolResult<HelloData> = {
        status: "success",
        data: {
          message: `Hello${name ? `, ${name}` : ""}! InternGuard MCP server is connected and responding.`,
          server: { name: SERVER_NAME, version: SERVER_VERSION },
          timestamp: new Date().toISOString(),
          modules: deps.sources,
          execution: databaseHealth(),
        },
        evidence: [],
        warnings: Object.entries(deps.sources)
          .filter(([, source]) => source === "stub")
          .map(([component]) => `${component} is using a TEMPORARY STUB.`),
      };
      return toCallToolResult("hello_internguard", result, deps.formatReport);
    },
  );

  server.registerTool(
    "check_internship_risk",
    {
      title: "Check internship posting for scam risk",
      description:
        "Analyses an internship posting or recruiter message for scam and safety red flags (for example upfront fees, requests for sensitive documents, unrealistic pay, off-platform contact). Returns a risk level, red flags with evidence, advice for the student, and an investigationId for shortlist_internships. Pass postingUrl so the result can be linked to the listing.",
      inputSchema: checkInternshipRiskInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      withInvestigationRecord(
        "check_internship_risk",
        input,
        await runSafely("check_internship_risk", deps.checkInternshipRisk, input),
        deps.formatReport,
      ),
  );

  server.registerTool(
    "verify_company",
    {
      title: "Verify a company",
      description:
        "Checks whether a company offering an internship appears to be a real, registered business, and reports what could and could not be confirmed, with sources. Returns an investigationId for shortlist_internships.",
      inputSchema: verifyCompanyInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      withInvestigationRecord("verify_company", input, await runSafely("verify_company", deps.verifyCompany, input), deps.formatReport),
  );

  server.registerTool(
    "check_student_eligibility",
    {
      title: "Check student internship eligibility",
      description:
        "Gives an informational assessment of whether a student is likely allowed to take an internship in a given country, based on visa or permit, study level, enrolment, hours and pay. Optionally matches the student profile against the listing requirements. Lists unmet or unknown requirements and missing information. Returns an investigationId. Not legal or immigration advice.",
      inputSchema: checkStudentEligibilityInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      withInvestigationRecord(
        "check_student_eligibility",
        input,
        await runSafely("check_student_eligibility", deps.checkStudentEligibility, input),
        deps.formatReport,
      ),
  );

  registerExecutionTools(server, {
    run: runSafely,
    respond: (tool, result) => toCallToolResult(tool, result, deps.formatReport),
  });

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info(`Starting ${SERVER_NAME} v${SERVER_VERSION} (node ${process.version})`);
  const deps = await loadDependencies();
  const server = createInternGuardServer(deps);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${reason})`);
    try {
      await server.close();
      closeAllDbs();
    } catch (err) {
      log.warn("Error during shutdown", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin closed by client"));

  await server.connect(transport);
  log.info("Ready: listening for MCP messages on stdio");
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

process.on("unhandledRejection", (reason) => log.error("Unhandled promise rejection", reason));

if (isEntryPoint()) {
  main().catch((err) => {
    log.error("Fatal startup error", err);
    process.exit(1);
  });
}
