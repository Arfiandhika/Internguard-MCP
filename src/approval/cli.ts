#!/usr/bin/env node
/**
 * Start the student dashboard (approval interface).
 * OWNER: Developer 4.
 *
 *   npm run approval                 started by the student
 *   (or automatically)               started in the background by the MCP tool
 *                                    open_student_dashboard, with INTERNGUARD_APPROVAL_AUTO=1
 *
 * The login link goes straight to the student's browser. When started
 * automatically, nothing is printed anywhere the agent could read, and the
 * server stops itself after 2 hours without use.
 */
import { closeAllDbs, getDb } from "../execution/db.js";
import { getPaths } from "../execution/paths.js";
import { openInBrowser } from "./browser.js";
import { startApprovalServer } from "./server.js";

const AUTO = process.env.INTERNGUARD_APPROVAL_AUTO === "1";
const IDLE_EXIT_MS = 2 * 3600 * 1000;

async function main(): Promise<void> {
  const paths = getPaths();
  getDb(); // fail fast if SQLite is unavailable

  let srv: Awaited<ReturnType<typeof startApprovalServer>>;
  const stop = () => {
    void srv.close().then(() => {
      closeAllDbs();
      process.exit(0);
    });
  };
  try {
    srv = await startApprovalServer({
      port: paths.approvalPort,
      openBrowser: openInBrowser,
      ...(AUTO ? { idleExitMs: IDLE_EXIT_MS, onIdle: () => stop() } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Port ${paths.approvalPort} is already in use: the dashboard is probably already running (maybe started by WorkBuddy). Ask WorkBuddy to open the dashboard, or stop the other one first.`,
      );
    }
    throw err;
  }

  if (!AUTO) {
    process.stderr.write(
      [
        "",
        "InternGuard student dashboard (local only)",
        `  Database: ${paths.databaseFile}`,
        `  Exports:  ${paths.exportsDir}`,
        "",
        "  Open this link in your browser to log in (do not share it):",
        `  ${srv.loginUrl}`,
        "",
        "  Press Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
  }
  if (process.env.INTERNGUARD_NO_BROWSER !== "1") {
    const opened = openInBrowser(srv.loginUrl);
    if (!AUTO) process.stderr.write(opened ? "  Opening the login link in your browser...\n\n" : "  (Could not open a browser automatically; open the link above manually.)\n\n");
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  if (!AUTO) process.stderr.write(`Dashboard failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
