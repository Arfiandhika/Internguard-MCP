/**
 * open_student_dashboard: start the student dashboard if needed and open it
 * in the student's browser. No command prompt step for the student.
 * OWNER: Developer 4.
 *
 * Security: the MCP server never sees a login token. It asks the dashboard
 * (POST /control/open-login) to open the browser; the dashboard creates a
 * one-time token and hands it straight to the browser. The agent only learns
 * whether a browser was opened, so it still cannot approve anything.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DashboardData, ToolResult } from "../shared/types.js";
import { getPaths, PROJECT_ROOT } from "./paths.js";
import { sha256 } from "./store.js";

type Health = "ours" | "other-database" | "something-else" | "down";
export type DashboardLauncher = () => void;

const STARTUP_WAIT_MS = 8_000;

function defaultLauncher(): void {
  const js = fileURLToPath(new URL("../approval/cli.js", import.meta.url));
  const ts = js.replace(/\.js$/, ".ts");
  const args = existsSync(js) ? [js] : ["--import", "tsx", ts]; // dist build, or running from source with tsx
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore", // the startup login link must not reach any log the agent can read
    windowsHide: true,
    env: { ...process.env, INTERNGUARD_APPROVAL_AUTO: "1" },
  });
  child.on("error", () => undefined);
  child.unref();
}

let launcher: DashboardLauncher = defaultLauncher;

/** Tests replace the launcher; pass null to restore the default. */
export function setDashboardLauncher(fn: DashboardLauncher | null): void {
  launcher = fn ?? defaultLauncher;
}

async function health(base: string): Promise<Health> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1_500), redirect: "error" });
    const body = (await res.json()) as { app?: string; db?: string };
    if (body.app !== "internguard-approval") return "something-else";
    return body.db === sha256(getPaths().databaseFile).slice(0, 16) ? "ours" : "other-database";
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return code === "ECONNREFUSED" || code === "ECONNRESET" || code === undefined ? "down" : "something-else";
  }
}

async function requestBrowser(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/control/open-login`, {
      method: "POST",
      headers: { "x-internguard-control": "open-login" },
      signal: AbortSignal.timeout(3_000),
      redirect: "error",
    });
    const body = (await res.json()) as { opened?: boolean };
    return body.opened === true;
  } catch {
    return false;
  }
}

export async function openStudentDashboard(): Promise<ToolResult<DashboardData>> {
  const { approvalBaseUrl: base, approvalPort } = getPaths();
  const fail = (message: string): ToolResult<DashboardData> => ({ status: "error", data: null, evidence: [], warnings: [message] });

  let state = await health(base);
  if (state === "other-database") {
    return fail(`A dashboard for a different InternGuard data folder is already running on port ${approvalPort}. Close it, or give this one another INTERNGUARD_APPROVAL_PORT.`);
  }
  if (state === "something-else") return fail(`Port ${approvalPort} is used by another program. Set INTERNGUARD_APPROVAL_PORT to a free port.`);

  let started = false;
  if (state === "down") {
    launcher();
    started = true;
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      state = await health(base);
      if (state === "ours") break;
    }
    if (state !== "ours") {
      return fail('The student dashboard could not be started automatically. Ask the student to run "npm run approval" in the project folder.');
    }
  }

  // A freshly started dashboard opens the browser itself; an already running one is asked to.
  const browserOpened = started ? true : await requestBrowser(base);
  return {
    status: browserOpened ? "success" : "partial",
    data: { dashboardUrl: base, started, browserOpened },
    evidence: [],
    warnings: browserOpened
      ? ["The student's browser was opened on the dashboard. The student reviews and approves there; you cannot approve on their behalf."]
      : [`The dashboard is running at ${base}, but no browser could be opened. Ask the student to open it; if it asks for a login, they can run "npm run approval".`],
  };
}
