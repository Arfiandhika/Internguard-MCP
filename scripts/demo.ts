/**
 * InternGuard scripted demo over the real stdio MCP server (dist/index.js).
 * OWNER: Developer 1. Uses SIMULATED fixtures; see fixtures/demo.
 *
 *   npm run demo:prepare   investigate 7 listings, shortlist, prepare packages
 *   (student approves in the approval interface: npm run approval)
 *   npm run demo:execute   export approved packages, then show the tracker
 *   npm run demo:status    tracker only
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureDir, getPaths, PROJECT_ROOT } from "../src/execution/paths.js";
import type { TrackerData } from "../src/shared/types.js";
import { REGISTRY_FIXTURE, callTool, runExecute, runInvestigateAndPrepare, type DemoState } from "./demo-flow.js";

const out = (line = "") => process.stdout.write(line + "\n");

async function connect(): Promise<Client> {
  const serverEntry = path.join(PROJECT_ROOT, "dist", "index.js");
  if (!existsSync(serverEntry)) throw new Error("dist/index.js not found: run npm run build first.");
  const env: Record<string, string> = { ...getDefaultEnvironment(), INTERNGUARD_SIMULATED_REGISTRY: REGISTRY_FIXTURE };
  for (const k of ["INTERNGUARD_DATA_DIR", "INTERNGUARD_EXPORTS_DIR", "INTERNGUARD_APPROVAL_PORT", "INTERNGUARD_LOG_LEVEL"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  env.INTERNGUARD_LOG_LEVEL ??= "warn";
  const client = new Client({ name: "internguard-demo", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "inherit" }));
  return client;
}

function statePath(): string {
  return path.join(getPaths().dataDir, "demo-state.json");
}

function printTracker(t: TrackerData | null, warnings: string[]): void {
  if (!t) {
    out("Tracker unavailable: " + warnings.join(" | "));
    return;
  }
  out(`\nTracker (database: ${t.databasePath})`);
  for (const a of t.applications) {
    const okFiles = a.files.filter((f) => f.verified).length;
    out(`  ${a.status.padEnd(22)} ${a.companyName ?? a.title ?? a.url}`);
    out(`    approval: ${a.approval ? `${a.approval.decision} at ${a.approval.decidedAt} (hash matches current package: ${a.approval.matchesCurrentPackage})` : "none yet"}`);
    out(`    files: ${okFiles}/${a.files.length} verified on disk${a.files[0] ? ` in ${path.dirname(path.join(t.exportsRoot, a.files[0].relativePath))}` : ""}`);
    if (a.applyUrl) out(`    apply at: ${a.applyUrl}`);
    for (const f of a.followUps.filter((x) => x.status === "open")) out(`    todo: ${f.description}`);
  }
  out(`  counts: ${JSON.stringify(t.counts)}`);
  for (const w of warnings) out(`  note: ${w}`);
}

async function prepare(client: Client): Promise<void> {
  const hello = await callTool<{ message: string; execution?: { database: string; detail: string } }>(client, "hello_internguard", {});
  out(hello.result.data?.message ?? "hello failed");
  out(`Database: ${hello.result.data?.execution?.database} (${hello.result.data?.execution?.detail})`);
  out("\n[SIMULATED fixtures] Investigating 7 listings...");
  const state = await runInvestigateAndPrepare(client, (l) => out("  " + l));

  out("\nShortlist decisions:");
  for (const e of state.evaluations) {
    out(`  ${e.listingRef} ${e.decision.toUpperCase()}${e.rank ? ` #${e.rank}` : ""}${e.score !== null ? ` (score ${e.score})` : ""}`);
    for (const r of e.reasons.slice(0, 2)) out(`      - ${r}`);
  }
  for (const f of state.toolFailures) out(`  tool failure: ${f}`);

  out("\nPackages awaiting YOUR approval:");
  for (const p of state.prepared) {
    if (p.reviewUrl) out(`  ${p.listingRef}: ${p.reviewUrl}${p.reviewFlags.length ? `  (${p.reviewFlags.length} review flag(s))` : ""}`);
    else out(`  ${p.listingRef}: NOT prepared: ${p.problems.join(" | ")}`);
  }
  ensureDir(getPaths().dataDir);
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
  out(`\nNext: run "npm run approval" in another terminal, open the login link it prints,`);
  out(`approve or reject each package, then run "npm run demo:execute".`);
}

async function execute(client: Client): Promise<void> {
  if (!existsSync(statePath())) throw new Error('No demo state found: run "npm run demo:prepare" first.');
  const state = JSON.parse(readFileSync(statePath(), "utf8")) as DemoState;
  const outcome = await runExecute(client, state);
  out("Export results:");
  for (const s of outcome.saves) {
    if (s.ok && s.data) out(`  ${s.listingRef}: exported ${s.data.files.length} files${s.data.alreadyExported ? " (already exported, nothing duplicated)" : ""}, status ${s.data.status}`);
    else out(`  ${s.listingRef}: REFUSED: ${s.warnings[0] ?? "unknown"}`);
  }
  printTracker(outcome.tracker, outcome.trackerWarnings);
}

async function status(client: Client): Promise<void> {
  const shortlistId = existsSync(statePath()) ? (JSON.parse(readFileSync(statePath(), "utf8")) as DemoState).shortlistId : undefined;
  const t = await callTool<TrackerData>(client, "get_application_tracker", shortlistId ? { shortlistId } : {});
  printTracker(t.result.data, t.result.warnings);
}

const mode = process.argv[2];
const actions: Record<string, (c: Client) => Promise<void>> = { prepare, execute, status };
const action = mode ? actions[mode] : undefined;
if (!action) {
  process.stderr.write("usage: tsx scripts/demo.ts <prepare|execute|status>\n");
  process.exit(2);
}
const client = await connect();
try {
  await action(client);
} finally {
  await client.close();
}
