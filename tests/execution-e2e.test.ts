/**
 * End-to-end: 7 SIMULATED listings -> 3 shortlisted -> 3 packages ->
 * student approval through the real approval server -> exports -> tracker,
 * plus the failure and attack cases the execution layer must withstand.
 * OWNER: Developer 1.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "internguard-e2e-"));
process.env.INTERNGUARD_DATA_DIR = path.join(ROOT, "data");
process.env.INTERNGUARD_EXPORTS_DIR = path.join(ROOT, "exports");
process.env.INTERNGUARD_LOG_LEVEL = "error";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createInternGuardServer, loadDependencies } = await import("../src/index.js");
const { closeAllDbs, getDb } = await import("../src/execution/db.js");
const { startApprovalServer } = await import("../src/approval/server.js");
const { setDashboardLauncher } = await import("../src/execution/dashboard.js");
/** Login links the dashboard handed to "the browser" (captured instead of opening one). */
const browserOpened: string[] = [];
const flow = await import("../scripts/demo-flow.js");
process.env.INTERNGUARD_SIMULATED_REGISTRY = flow.REGISTRY_FIXTURE;

type ClientT = InstanceType<typeof Client>;
type ApprovalSrv = Awaited<ReturnType<typeof startApprovalServer>>;

async function newClient(): Promise<{ client: ClientT; close: () => Promise<void> }> {
  const server = createInternGuardServer(await loadDependencies());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(ct);
  return { client, close: () => client.close() };
}

/** Acts as the student in the browser: log in, read the page, submit the form. */
class Student {
  private cookie = "";
  constructor(private srv: ApprovalSrv) {}
  async login(): Promise<void> {
    const res = await fetch(this.srv.loginUrl, { redirect: "manual" });
    assert.equal(res.status, 303);
    this.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  async page(p: string): Promise<{ status: number; html: string }> {
    const res = await fetch(`${this.srv.url}${p}`, { headers: { cookie: this.cookie }, redirect: "manual" });
    return { status: res.status, html: await res.text() };
  }
  get cookieHeader(): string {
    return this.cookie;
  }
  async rawForm(p: string, fields: Record<string, string>, headers: Record<string, string>): Promise<number> {
    const res = await fetch(`${this.srv.url}${p}`, {
      method: "POST",
      headers: { cookie: this.cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
    await res.text();
    return res.status;
  }
  async form(p: string, fields: Record<string, string>): Promise<number> {
    const res = await fetch(`${this.srv.url}${p}`, {
      method: "POST",
      headers: { cookie: this.cookie, "content-type": "application/x-www-form-urlencoded", origin: this.srv.url },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
    await res.text();
    return res.status;
  }
  async decide(packageId: string, decision: "approve" | "reject", confirm = true): Promise<number> {
    const { html } = await this.page(`/review/${packageId}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const contentHash = /name="contentHash" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return this.form(`/review/${packageId}`, { csrf, contentHash, decision, ...(confirm ? { confirmReviewed: "yes" } : {}) });
  }
  async csrf(): Promise<string> {
    const { html } = await this.page("/");
    return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  }
}

let mcp: Awaited<ReturnType<typeof newClient>>;
let approval: ApprovalSrv;
let student: Student;
let state: Awaited<ReturnType<typeof flow.runInvestigateAndPrepare>>;

before(async () => {
  mcp = await newClient();
  approval = await startApprovalServer({
    port: 0,
    token: "test-token-known-only-to-the-test-student",
    openBrowser: (u) => {
      browserOpened.push(u);
      return true;
    },
  });
  process.env.INTERNGUARD_APPROVAL_PORT = String(approval.port);
  student = new Student(approval);
  await student.login();
  state = await flow.runInvestigateAndPrepare(mcp.client);
});

after(async () => {
  await mcp?.close();
  await approval?.close();
  closeAllDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("investigation and shortlist (7 listings)", () => {
  test("expected decisions for every listing, with no tool failures", () => {
    const d = Object.fromEntries(state.evaluations.map((e) => [e.listingRef, e.decision]));
    assert.deepEqual(d, {
      L1: "shortlisted", L2: "shortlisted", L3: "shortlisted",
      L4: "rejected", L5: "rejected", L6: "rejected", L7: "insufficient_evidence",
    });
    assert.deepEqual(state.toolFailures, []);
  });

  test("inaccessible listing is reported, not guessed", () => {
    const l7 = state.evaluations.find((e) => e.listingRef === "L7");
    assert.match(l7?.reasons.join(" ") ?? "", /could not be accessed/);
  });

  test("three packages awaiting approval, each with a review URL", () => {
    assert.equal(state.prepared.length, 3);
    for (const p of state.prepared) {
      assert.ok(p.packageId && p.reviewUrl?.includes(`/review/${p.packageId}`), JSON.stringify(p));
      assert.deepEqual(p.problems, []);
    }
  });

  test("investigation attached to the wrong listing is ignored, not trusted", async () => {
    const fx = flow.loadFixtures();
    const risk = await flow.callTool(mcp.client, "check_internship_risk", { postingText: fx.listings[0]?.text ?? "", postingUrl: fx.listings[0]?.url ?? "" });
    const r = await flow.callTool<{ evaluations: Array<{ decision: string; missingEvidence: string[] }> }>(mcp.client, "shortlist_internships", {
      student: fx.student,
      listings: [{ listingRef: "X", url: "https://global-intern-hub.example/apply", accessStatus: "accessed", riskInvestigationId: risk.result.investigationId }],
    });
    const e = r.result.data?.evaluations[0];
    assert.equal(e?.decision, "insufficient_evidence");
    assert.match(e?.missingEvidence.join(" ") ?? "", /not for this listing/);
  });

  test("ids not issued by the server are rejected by input validation", async () => {
    const r = await flow.callTool(mcp.client, "save_approved_application", { packageId: "../../etc/passwd" });
    assert.equal(r.isError, true);
  });

  test("identical shortlist request is reused, not duplicated", async () => {
    const before = (getDb().prepare("SELECT COUNT(*) n FROM shortlists").get() as { n: number }).n;
    const fx = flow.loadFixtures();
    const listings = [{ listingRef: "Z", url: "https://example.org/z", accessStatus: "not_accessible" }];
    await flow.callTool(mcp.client, "shortlist_internships", { student: fx.student, listings });
    const again = await flow.callTool<{ reused: boolean }>(mcp.client, "shortlist_internships", { student: fx.student, listings });
    assert.equal(again.result.data?.reused, true);
    assert.equal((getDb().prepare("SELECT COUNT(*) n FROM shortlists").get() as { n: number }).n, before + 1);
  });
});

describe("anti-fabrication", () => {
  test("invented email, unknown skill and foreign link block the package; nothing is stored", async () => {
    const caseId = state.prepared[0]?.caseId ?? "";
    const fx = flow.loadFixtures();
    const base = fx.packs.L1;
    assert.ok(base);
    const count = () => (getDb().prepare("SELECT COUNT(*) n FROM application_packages").get() as { n: number }).n;
    const n0 = count();
    const bad = {
      ...base,
      coverLetter: base.coverLetter + "\nSee my portfolio at https://my-portfolio.example and contact hr.boss@acme-hr.example.",
      recruiterEmail: { ...base.recruiterEmail, to: "ceo@acmeanalytics.com.my" },
      skillsReferenced: [...base.skillsReferenced, "Kubernetes"],
    };
    const r = await flow.callTool(mcp.client, "prepare_application_pack", { caseId, content: bad });
    assert.equal(r.result.status, "error");
    const w = r.result.warnings.join("\n");
    assert.match(w, /Kubernetes/);
    assert.match(w, /hr\.boss@acme-hr\.example/);
    assert.match(w, /ceo@acmeanalytics\.com\.my/);
    assert.match(w, /my-portfolio\.example/);
    assert.equal(count(), n0, "no package stored");
  });

  test("packages cannot be prepared for non-shortlisted cases", async () => {
    const rows = getDb().prepare("SELECT id FROM internship_cases WHERE decision = 'rejected' LIMIT 1").get() as { id: string };
    const fx = flow.loadFixtures();
    const r = await flow.callTool(mcp.client, "prepare_application_pack", { caseId: rows.id, content: fx.packs.L1 });
    assert.match(r.result.warnings.join(" "), /not shortlisted/);
  });
});

describe("student dashboard opens without a command prompt", () => {
  test("opens the student's browser with a one-time login; the agent never sees a token", async () => {
    browserOpened.length = 0;
    const r = await mcp.client.callTool({ name: "open_student_dashboard", arguments: {} });
    const sc = r.structuredContent as { data: { browserOpened: boolean; started: boolean; dashboardUrl: string } };
    assert.equal(sc.data.browserOpened, true);
    assert.equal(sc.data.started, false, "it reused the running dashboard");
    assert.equal(sc.data.dashboardUrl, approval.url);
    assert.doesNotMatch(JSON.stringify(r), /token=/, "no login token in anything the agent receives");
    assert.equal(browserOpened.length, 1);
    const link = browserOpened[0] ?? "";
    assert.match(link, /\/login\?token=[A-Za-z0-9_-]{20,}$/);
    assert.equal((await fetch(link, { redirect: "manual" })).status, 303, "first use logs in");
    assert.equal((await fetch(link, { redirect: "manual" })).status, 401, "the link works only once");
  });

  test("opens a specific package or application, and the login lands exactly there", async () => {
    const pkg = state.prepared[0]?.packageId ?? "";
    await new Promise((r) => setTimeout(r, 3100)); // open-login rate limit
    browserOpened.length = 0;
    const r = await mcp.client.callTool({ name: "open_student_dashboard", arguments: { packageId: pkg } });
    assert.equal((r.structuredContent as { data: { page: string } }).data.page, `/review/${pkg}`);
    const link = browserOpened[0] ?? "";
    assert.match(link, new RegExp(`&next=%2Freview%2F${pkg}$`));
    const login = await fetch(link, { redirect: "manual" });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), `/review/${pkg}`);
    // the login link can never redirect elsewhere
    const { sanitizeNext } = await import("../src/approval/server.js");
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "/review/../../x", "/files/app_x/cover-letter.md", "javascript:alert(1)"]) {
      assert.equal(sanitizeNext(bad), "/", bad);
    }
    assert.equal(sanitizeNext("/#app_123e4567-e89b-42d3-a456-426614174000"), "/#app_123e4567-e89b-42d3-a456-426614174000");
    const bogus = await mcp.client.callTool({ name: "open_student_dashboard", arguments: { packageId: "../../etc" } });
    assert.equal(bogus.isError, true, "ids are validated");
  });

  test("the control endpoint refuses web pages and requests without its header", async () => {
    const plain = await fetch(`${approval.url}/control/open-login`, { method: "POST" });
    assert.equal(plain.status, 403);
    const fromPage = await fetch(`${approval.url}/control/open-login`, { method: "POST", headers: { "x-internguard-control": "open-login", origin: "https://evil.example" } });
    assert.equal(fromPage.status, 403);
    const health = (await (await fetch(`${approval.url}/healthz`)).json()) as { app: string; db: string };
    assert.equal(health.app, "internguard-approval");
    assert.doesNotMatch(JSON.stringify(health), /internguard\.db|[\\/]/, "health reveals no paths");
  });

  test("starts the dashboard automatically when it is not running", async () => {
    const probe = await startApprovalServer({ port: 0 });
    const freePort = probe.port;
    await probe.close();
    process.env.INTERNGUARD_APPROVAL_PORT = String(freePort);
    let spawned: Awaited<ReturnType<typeof startApprovalServer>> | undefined;
    setDashboardLauncher(() => {
      void startApprovalServer({ port: freePort, openBrowser: () => true }).then((s) => (spawned = s));
    });
    try {
      const r = await mcp.client.callTool({ name: "open_student_dashboard", arguments: {} });
      const sc = r.structuredContent as { data: { started: boolean; browserOpened: boolean } };
      assert.equal(sc.data.started, true);
      assert.equal(sc.data.browserOpened, true);
    } finally {
      setDashboardLauncher(null);
      process.env.INTERNGUARD_APPROVAL_PORT = String(approval.port);
      await spawned?.close();
    }
  });
});

describe("approval is required and bound to content", () => {
  test("no MCP tool can approve", async () => {
    const { tools } = await mcp.client.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      assert.ok(!props.some((p) => /approv|decision|consent/i.test(p)), `${t.name} has an approval-like input: ${props.join(",")}`);
    }
  });

  test("export is refused until the student approves", async () => {
    const outcome = await flow.runExecute(mcp.client, state);
    assert.ok(outcome.saves.every((s) => !s.ok));
    assert.match(outcome.saves[0]?.warnings[0] ?? "", /No student approval/);
    const dir = process.env.INTERNGUARD_EXPORTS_DIR ?? "";
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0, "no files exported");
  });

  test("approval server refuses unauthenticated, forged and unconfirmed decisions", async () => {
    const pkg = state.prepared[0]?.packageId ?? "";
    const anon = await fetch(`${approval.url}/review/${pkg}`);
    assert.equal(anon.status, 401);
    // fetch() ignores a custom Host header, so use node:http to simulate DNS rebinding.
    const wrongHost = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: approval.port, path: "/", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(wrongHost, 421);
    assert.equal(await student.form(`/review/${pkg}`, { csrf: "forged", contentHash: "x", decision: "approve", confirmReviewed: "yes" }), 403);
    assert.equal(await student.decide(pkg, "approve", false), 400);
    const { html } = await student.page(`/review/${pkg}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.equal(await student.form(`/review/${pkg}`, { csrf, contentHash: "0".repeat(64), decision: "approve", confirmReviewed: "yes" }), 409);
  });

  test("real-browser headers: same-origin form posts pass, cross-site posts are refused", async () => {
    const pkg = state.prepared[0]?.packageId ?? "";
    // A decision that would be accepted by the CSRF check but is missing the checkbox -> 400 proves the origin check passed.
    const { html } = await student.page(`/review/${pkg}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const contentHash = /name="contentHash" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const post = (headers: Record<string, string>) =>
      student.rawForm(`/review/${pkg}`, { csrf, contentHash, decision: "approve" }, headers);
    assert.equal(await post({ origin: "null", "sec-fetch-site": "same-origin" }), 400, "Chrome/Firefox with Origin: null");
    assert.equal(await post({ origin: approval.url, "sec-fetch-site": "same-origin" }), 400, "browser with real origin");
    assert.equal(await post({ origin: "null", "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await post({ origin: "null" }), 403, "opaque origin without fetch metadata");
    assert.equal(await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }), 403);
    const res = await fetch(`${approval.url}/`, { headers: { cookie: student.cookieHeader } });
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
  });

  test("review page escapes content and shows the hash being approved", async () => {
    const { html } = await student.page(`/review/${state.prepared[0]?.packageId}`);
    assert.match(html, /Content SHA-256/);
    assert.doesNotMatch(html, /<script/i);
  });

  test("student approves all three; export writes 5 verified files each", async () => {
    for (const p of state.prepared) assert.equal(await student.decide(p.packageId ?? "", "approve"), 303);
    const outcome = await flow.runExecute(mcp.client, state);
    for (const s of outcome.saves) {
      assert.ok(s.ok, s.warnings.join(" "));
      assert.equal(s.data?.status, "MANUAL_ACTION_REQUIRED");
      assert.deepEqual(s.data?.files.map((f) => f.name).sort(), ["application-summary.md", "checklist.md", "cover-letter.md", "cv-suggestions.md", "email-draft.md"]);
    }
    const t = outcome.tracker;
    assert.ok(t);
    assert.equal(t.applications.length, 3);
    assert.deepEqual(t.counts, { MANUAL_ACTION_REQUIRED: 3 });
    for (const a of t.applications) {
      assert.ok(a.files.length === 5 && a.files.every((f) => f.verified));
      assert.equal(a.approval?.matchesCurrentPackage, true);
      assert.equal(a.submission, null, "nothing is marked submitted");
    }
  });

  test("repeating the export does not duplicate applications or files", async () => {
    const dirs = () => readdirSync(process.env.INTERNGUARD_EXPORTS_DIR ?? "");
    const before = dirs().length;
    const outcome = await flow.runExecute(mcp.client, state);
    assert.ok(outcome.saves.every((s) => s.data?.alreadyExported));
    assert.equal(dirs().length, before);
    assert.equal((getDb().prepare("SELECT COUNT(*) n FROM applications").get() as { n: number }).n, 3);
    assert.equal((getDb().prepare("SELECT COUNT(*) n FROM exports").get() as { n: number }).n, 3);
  });

  test("a package changed after approval needs approval again", async () => {
    const p = state.prepared[1];
    assert.ok(p?.packageId);
    const fx = flow.loadFixtures();
    const changed = { ...fx.packs.L2, coverLetter: (fx.packs.L2?.coverLetter ?? "") + "\nP.S. I am also happy to join on-site days if needed." };
    const v2 = await flow.callTool<{ packageId: string; version: number; status: string }>(mcp.client, "prepare_application_pack", { caseId: p.caseId, content: changed });
    assert.equal(v2.result.data?.version, 2);
    assert.equal(v2.result.data?.status, "AWAITING_APPROVAL");
    const oldSave = await flow.callTool(mcp.client, "save_approved_application", { packageId: p.packageId });
    assert.match(oldSave.result.warnings[0] ?? "", /replaced by a newer version/);
    const newSave = await flow.callTool(mcp.client, "save_approved_application", { packageId: v2.result.data?.packageId ?? "" });
    assert.match(newSave.result.warnings[0] ?? "", /No student approval/);
    assert.equal(await student.decide(v2.result.data?.packageId ?? "", "approve"), 303);
    const ok = await flow.callTool<{ status: string }>(mcp.client, "save_approved_application", { packageId: v2.result.data?.packageId ?? "" });
    assert.equal(ok.result.data?.status, "MANUAL_ACTION_REQUIRED");
  });

  test("database tampering after approval is detected and nothing is exported", async () => {
    const fx = flow.loadFixtures();
    const p = state.prepared[2];
    assert.ok(p);
    const v2 = await flow.callTool<{ packageId: string }>(mcp.client, "prepare_application_pack", {
      caseId: p.caseId, content: { ...fx.packs.L3, checklist: [...(fx.packs.L3?.checklist ?? []), "Re-read the listing"] },
    });
    const pkgId = v2.result.data?.packageId ?? "";
    assert.equal(await student.decide(pkgId, "approve"), 303);
    const row = getDb().prepare("SELECT content_json FROM application_packages WHERE id = ?").get(pkgId) as { content_json: string };
    const tampered = JSON.parse(row.content_json) as { coverLetter: string };
    tampered.coverLetter += "\nI have five years of industry experience.";
    getDb().prepare("UPDATE application_packages SET content_json = ? WHERE id = ?").run(JSON.stringify(tampered), pkgId);
    const r = await flow.callTool(mcp.client, "save_approved_application", { packageId: pkgId });
    assert.match(r.result.warnings[0] ?? "", /Integrity check failed/);
  });
});

describe("tracking and persistence", () => {
  test("the dashboard shows exported files, and only a logged-in student can open them", async () => {
    const appId = (getDb().prepare("SELECT id FROM applications WHERE status = 'MANUAL_ACTION_REQUIRED' LIMIT 1").get() as { id: string }).id;
    const home = await student.page("/");
    assert.match(home.html, /Internship Safety &amp; Eligibility Dashboard/);
    assert.match(home.html, /Application pipeline/);
    assert.match(home.html, /no major indicators/, "honest risk label, never 'low' or 'safe'");
    assert.doesNotMatch(home.html, /token=/, "no login token anywhere on the dashboard");
    assert.match(home.html, new RegExp(`/files/${appId}/cover-letter\\.md`));
    // Acme's listing publishes a recruiter address: one-click email; Northwind's does not.
    assert.match(home.html, /href="mailto:internships@acmeanalytics\.com\.my\?subject=Application%3A%20Data%20Analytics%20Intern/);
    assert.match(home.html, /Open in my email app/);
    assert.match(home.html, /href="https:\/\/mail\.google\.com\/mail\/u\/0\/\?tf=cm&amp;fs=1&amp;to=internships%40acmeanalytics\.com\.my&amp;su=Application/);
    // Northwind's listing has no recruiter address: Gmail opens with subject and body, and an empty To field
    assert.match(home.html, /Open in Gmail \(add the recipient yourself\)/);
    assert.match(home.html, /Show email text/);
    assert.doesNotMatch(home.html, /mailto:[^"?]*northwind/i, "no invented Northwind address");
    const file = await fetch(`${approval.url}/files/${appId}/cover-letter.md`, { headers: { cookie: student.cookieHeader } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("x-internguard-file-verified"), "yes");
    assert.match(await file.text(), /Dear /);
    assert.equal((await fetch(`${approval.url}/files/${appId}/cover-letter.md`)).status, 401);
    assert.equal((await student.page(`/files/${appId}/secrets.md`)).status, 404);
    assert.equal((await student.page(`/files/${appId}/..%2F..%2Fdata%2Finternguard.db`)).status, 404);
  });

  test("a modified export file is reported, and re-saving repairs it", async () => {
    const t1 = await flow.callTool<{ applications: Array<{ status: string; files: Array<{ relativePath: string; verified: boolean }>; currentPackage: { packageId: string } }> }>(
      mcp.client, "get_application_tracker", { shortlistId: state.shortlistId, status: "MANUAL_ACTION_REQUIRED" },
    );
    const app = t1.result.data?.applications[0];
    assert.ok(app);
    writeFileSync(path.join(process.env.INTERNGUARD_EXPORTS_DIR ?? "", app.files[0]?.relativePath ?? ""), "edited by hand\n");
    const t2 = await flow.callTool<{ applications: Array<{ files: Array<{ verified: boolean }> }> }>(mcp.client, "get_application_tracker", { shortlistId: state.shortlistId });
    assert.equal(t2.result.status, "partial");
    assert.match(t2.result.warnings.join(" "), /missing or modified/);
    const fixed = await flow.callTool<{ alreadyExported: boolean }>(mcp.client, "save_approved_application", { packageId: app.currentPackage.packageId });
    assert.equal(fixed.result.data?.alreadyExported, false);
  });

  test("SUBMITTED only via the student's approval page, with evidence", async () => {
    const appId = (getDb().prepare("SELECT id FROM applications WHERE status = 'MANUAL_ACTION_REQUIRED' LIMIT 1").get() as { id: string }).id;
    const csrf = await student.csrf();
    assert.equal(await student.form(`/applications/${appId}/submitted`, { csrf, evidence: "" }), 400);
    assert.equal(await student.form(`/applications/${appId}/submitted`, { csrf, evidence: "Greenhouse confirmation #GH-55120" }), 303);
    const t = await flow.callTool<{ applications: Array<{ status: string; submission: { evidence: string } | null; followUps: Array<{ kind: string; status: string }> }> }>(
      mcp.client, "get_application_tracker", { applicationId: appId },
    );
    const a = t.result.data?.applications[0];
    assert.equal(a?.status, "SUBMITTED");
    assert.equal(a?.submission?.evidence, "Greenhouse confirmation #GH-55120");
    assert.ok(a?.followUps.some((f) => f.kind === "follow_up" && f.status === "open"));
    assert.ok(a?.followUps.some((f) => f.kind === "submit_application" && f.status === "done"));
  });

  test("records survive a full server restart", async () => {
    const before = await flow.callTool<{ applications: unknown[] }>(mcp.client, "get_application_tracker", { shortlistId: state.shortlistId });
    await mcp.close();
    closeAllDbs();
    mcp = await newClient();
    const afterRestart = await flow.callTool<{ applications: Array<{ files: Array<{ verified: boolean }> }>; counts: Record<string, number> }>(
      mcp.client, "get_application_tracker", { shortlistId: state.shortlistId },
    );
    assert.equal(afterRestart.result.data?.applications.length, before.result.data?.applications.length);
    assert.ok(afterRestart.result.data?.applications.every((a) => a.files.every((f) => f.verified)));
    assert.equal(afterRestart.result.data?.counts.SUBMITTED, 1);
  });

  test("MCP App: tracker tool points to a ui:// resource and returns email links only for exported applications", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "show_application_tracker");
    assert.ok(tool, "tool registered");
    const meta = tool._meta as { ui?: { resourceUri?: string }; "ui/resourceUri"?: string };
    assert.equal(meta.ui?.resourceUri, "ui://internguard/tracker.html");
    assert.equal(meta["ui/resourceUri"], "ui://internguard/tracker.html");
    const res = await mcp.client.readResource({ uri: "ui://internguard/tracker.html" });
    const html = res.contents[0] as { mimeType?: string; text?: string };
    assert.equal(html.mimeType, "text/html;profile=mcp-app");
    assert.match(html.text ?? "", /ui\/initialize/);
    assert.match(html.text ?? "", /ui\/open-link/);
    assert.doesNotMatch(html.text ?? "", /<script[^>]+src=|<link[^>]+href=/, "self-contained: no external scripts or styles");
    assert.doesNotMatch(html.text ?? "", /\/review\/|\/delete|\/submitted|approve_package|record_submission/, "no decision is made inside the chat");
    assert.match(html.text ?? "", /Review &amp; approve|Review & approve/);
    assert.match(html.text ?? "", /callTool\("open_student_dashboard", args\)/, "actions only open the browser dashboard");

    const r = await mcp.client.callTool({ name: "show_application_tracker", arguments: { shortlistId: state.shortlistId } });
    assert.equal(r.isError, false);
    assert.match((r.content as Array<{ text: string }>)[0]?.text ?? "", /Application tracker/, "text fallback for clients without MCP Apps");
    const sc = r.structuredContent as { data: { applications: Array<{ applicationId: string; status: string }>; emails: Record<string, { to: string; gmailUrl: string | null; mailtoUrl: string | null }> } };
    const exported = sc.data.applications.filter((a) => a.status === "MANUAL_ACTION_REQUIRED").map((a) => a.applicationId);
    for (const id of Object.keys(sc.data.emails)) assert.ok(exported.includes(id), "email links only for exported applications");
    const links = Object.values(sc.data.emails);
    assert.ok(links.length > 0, "at least one exported application has a recruiter address");
    const listingText = flow.loadFixtures().listings.map((l) => l.text ?? "").join("\n");
    for (const e of links) {
      assert.ok(listingText.includes(e.to), `${e.to} comes from a listing, not invented`);
      const g = new URL(e.gmailUrl ?? "");
      assert.equal(g.origin, "https://mail.google.com");
      assert.equal(g.searchParams.get("to"), e.to);
      assert.ok((g.searchParams.get("body") ?? "").length > 20, "approved email body is prefilled");
      assert.match(e.mailtoUrl ?? "", new RegExp(`^mailto:${e.to.replace(/[.]/g, "\\.")}\\?subject=`));
    }
    assert.doesNotMatch(JSON.stringify(r), /token=/);
  });

  test("the student can delete one application from the dashboard; the listing stays usable", async () => {
    const row = getDb()
      .prepare("SELECT a.id, a.case_id, a.export_dir, c.listing_ref FROM applications a JOIN internship_cases c ON c.id = a.case_id WHERE a.status = 'SUBMITTED' LIMIT 1")
      .get() as { id: string; case_id: string; export_dir: string; listing_ref: string };
    assert.ok(existsSync(row.export_dir), "export folder exists before deletion");
    const home = await student.page("/");
    assert.match(home.html, /Delete application/);
    assert.match(home.html, /does not withdraw the application from the employer/);
    const csrf = await student.csrf();
    assert.equal(await student.form(`/applications/${row.id}/delete`, { csrf: "forged", confirmDelete: "yes" }), 403);
    assert.equal(await student.form(`/applications/${row.id}/delete`, { csrf }), 400, "needs the confirmation box");
    assert.equal(await student.form(`/applications/${row.id}/delete`, { csrf, confirmDelete: "yes" }), 303);
    for (const [table, col] of [["applications", "id"], ["application_packages", "application_id"], ["follow_up_tasks", "application_id"], ["events", "application_id"]] as const) {
      assert.equal((getDb().prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(row.id) as { n: number }).n, 0, table);
    }
    assert.equal(existsSync(row.export_dir), false, "export folder removed");
    assert.ok(getDb().prepare("SELECT id FROM internship_cases WHERE id = ?").get(row.case_id), "case kept");
    assert.equal(await student.form(`/applications/${row.id}/delete`, { csrf, confirmDelete: "yes" }), 409, "already deleted");
    const fx = flow.loadFixtures();
    const again = await flow.callTool<{ status: string; version: number }>(mcp.client, "prepare_application_pack", { caseId: row.case_id, content: fx.packs[row.listing_ref] });
    assert.equal(again.result.data?.status, "AWAITING_APPROVAL");
    assert.equal(again.result.data?.version, 1, "a fresh application");
    const { tools } = await mcp.client.listTools();
    assert.ok(!tools.some((t) => /delete|remove/i.test(t.name)), "no MCP tool can delete");
  });

  test("hello_internguard reports the database and all modules as live", async () => {
    const h = await flow.callTool<{ execution: { database: string }; modules: Record<string, string> }>(mcp.client, "hello_internguard", {});
    assert.equal(h.result.data?.execution.database, "ok");
    assert.equal(h.result.data?.modules.check_internship_risk, "module");
    assert.equal(h.result.data?.modules.verify_company, "module");
    assert.equal(h.result.data?.modules.check_student_eligibility, "module");
    assert.equal(h.result.data?.modules.formatter, "module");
  });

  test("the playbook is also available as a tool, identical to the prompt", async () => {
    const { tools } = await mcp.client.listTools();
    assert.ok(tools.some((t) => t.name === "get_workflow_playbook"));
    const r = await mcp.client.callTool({ name: "get_workflow_playbook", arguments: {} });
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? "";
    const p = await mcp.client.getPrompt({ name: "investigate_and_prepare" });
    const promptText = p.messages[0]?.content.type === "text" ? p.messages[0].content.text : "";
    assert.ok(promptText.length > 500 && text.includes(promptText), "tool returns the full playbook");
    assert.equal(r.isError, false);
  });

  test("the orchestration playbook is exposed as an MCP prompt", async () => {
    const { prompts } = await mcp.client.listPrompts();
    assert.ok(prompts.some((p) => p.name === "investigate_and_prepare"));
    const p = await mcp.client.getPrompt({ name: "investigate_and_prepare" });
    const text = p.messages[0]?.content.type === "text" ? p.messages[0].content.text : "";
    assert.match(text, /cannot approve/);
    assert.match(text, /NEVER use browser automation/);
    assert.match(text, /never open, fetch, browse to or submit anything on 127\.0\.0\.1 or localhost/);
  });
});
