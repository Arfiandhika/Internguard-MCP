/**
 * Local approval interface: the ONLY way a package can be approved, and the
 * only way an application can be marked SUBMITTED.
 * OWNER: Developer 4.
 *
 * Started by the student ("npm run approval"), separate from the MCP server.
 * Protections:
 *   - binds to 127.0.0.1 only; rejects requests whose Host/Origin is not this server
 *   - login needs a random token printed to the student's terminal (never sent over MCP)
 *   - HttpOnly + SameSite=Strict session cookie; per-session CSRF token on every form
 *   - each decision carries the content hash that was displayed, and is refused
 *     if the package has changed since
 * Limitation: a program with unrestricted shell access as the same OS user can
 * still read the terminal or edit the database. Deny the agent shell and
 * localhost access in WorkBuddy permissions (see README).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { ApplicationPackContent, ApplicationStatus, ExportedFile, ListingEvaluation, ReviewFlag } from "../shared/types.js";
import { getDb } from "../execution/db.js";
import { APPROVAL_HOST, getPaths, safeJoin } from "../execution/paths.js";
import {
  ID_PATTERNS,
  StateError,
  getApplication,
  getApproval,
  getCase,
  getPackage,
  deleteApplication,
  recordDecision,
  recordSubmission,
  sha256,
} from "../execution/store.js";
import { removeExportDir } from "../execution/exporter.js";
import { DASHBOARD_CSS, renderDashboardHome } from "./dashboard-view.js";

export { gmailComposeLink, mailtoLink } from "./dashboard-view.js";

export interface ApprovalServer {
  url: string;
  loginUrl: string;
  port: number;
  close: () => Promise<void>;
}

interface Session {
  csrf: string;
  createdAt: number;
}

const SESSION_TTL_MS = 8 * 3600 * 1000;
const MAX_BODY = 16 * 1024;

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch {
    return null;
  }
}

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}



function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · InternGuard</title><style>${DASHBOARD_CSS}</style></head><body><div class="container">${body}</div></body></html>`;
}

function list(items: string[], empty = "None recorded."): string {
  return items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;
}

export interface ApprovalServerOptions {
  port: number;
  /** Reusable startup token (printed by the CLI). Random if omitted. */
  token?: string;
  /** Opens a login URL in the student's browser; return false if it could not. */
  openBrowser?: (url: string) => boolean;
  /** Called after this long without any request (auto-started servers shut down). */
  idleExitMs?: number;
  onIdle?: () => void;
}

/** Identifies this app on /healthz without revealing the database path. */
export function databaseFingerprint(): string {
  return sha256(getPaths().databaseFile).slice(0, 16);
}

const ONE_TIME_TOKEN_TTL_MS = 10 * 60 * 1000;
const OPEN_LOGIN_MIN_INTERVAL_MS = 3_000;

export async function startApprovalServer(opts: ApprovalServerOptions = { port: 4317 }): Promise<ApprovalServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  /** Startup token (reusable) plus one-time tokens issued via /control/open-login. */
  const loginTokens = new Map<string, { singleUse: boolean; expiresAt: number }>([[token, { singleUse: false, expiresAt: Infinity }]]);
  let lastOpenLogin = 0;
  let lastRequest = Date.now();
  const sessions = new Map<string, Session>();
  let origin = "";
  let allowedHosts = new Set<string>();

  const consumeLoginToken = (given: string): boolean => {
    for (const [t, meta] of loginTokens) {
      if (!sameSecret(given, t)) continue;
      if (meta.expiresAt < Date.now()) {
        loginTokens.delete(t);
        return false;
      }
      if (meta.singleUse) loginTokens.delete(t);
      return true;
    }
    return false;
  };

  const server = http.createServer((req, res) => {
    lastRequest = Date.now();
    handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[approval] error: ${err instanceof Error ? err.stack : String(err)}\n`);
      if (!res.headersSent) send(res, 500, page("Error", "<h1>Something went wrong</h1><p>Check the approval server terminal.</p>"));
    });
  });

  function send(res: http.ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      // "no-referrer" makes browsers send "Origin: null" on form posts; same-origin keeps the real origin.
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(html);
  }

  /**
   * Same-origin check for form posts. Browsers send Sec-Fetch-Site (which pages
   * cannot forge); Origin may be "null" under some referrer policies. Tools
   * without these headers (curl, tests) still need the CSRF token.
   */
  function isSameOriginPost(req: http.IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if (site !== undefined && site !== "same-origin") return false;
    if (origin === undefined) return true;
    if (origin === "null") return site === "same-origin";
    return allowedHosts.has(origin.replace(/^https?:\/\//, ""));
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  function redirect(res: http.ServerResponse, location: string, headers: Record<string, string> = {}): void {
    res.writeHead(303, { Location: location, "Cache-Control": "no-store", ...headers });
    res.end();
  }

  function session(req: http.IncomingMessage): [string, Session] | null {
    const m = /(?:^|;\s*)ig_session=([A-Za-z0-9_-]{20,64})/.exec(req.headers.cookie ?? "");
    if (!m?.[1]) return null;
    const s = sessions.get(m[1]);
    if (!s || Date.now() - s.createdAt > SESSION_TTL_MS) return null;
    return [m[1], s];
  }

  async function readForm(req: http.IncomingMessage): Promise<URLSearchParams | null> {
    if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return null;
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS-rebinding and cross-site defences
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 421, page("Wrong host", "<h1>Wrong host</h1>"));
    const path0 = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path0 === "/healthz") {
      return json(res, 200, { app: "internguard-approval", db: databaseFingerprint() });
    }
    // Lets the MCP server ask for the student's browser to be opened. It never returns
    // a token: the one-time login link goes straight to the browser. Browsers cannot
    // call this cross-site (custom header forces a preflight that is never answered),
    // and requests that carry an Origin header (i.e. from web pages) are refused.
    if (path0 === "/control/open-login") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (req.headers["x-internguard-control"] !== "open-login" || req.headers.origin !== undefined) {
        return json(res, 403, { error: "forbidden" });
      }
      if (Date.now() - lastOpenLogin < OPEN_LOGIN_MIN_INTERVAL_MS) return json(res, 429, { opened: false, error: "try again in a few seconds" });
      lastOpenLogin = Date.now();
      const oneTime = randomBytes(24).toString("base64url");
      loginTokens.set(oneTime, { singleUse: true, expiresAt: Date.now() + ONE_TIME_TOKEN_TTL_MS });
      let opened = false;
      try {
        opened = opts.openBrowser ? opts.openBrowser(`${origin}/login?token=${oneTime}`) : false;
      } catch {
        opened = false;
      }
      if (!opened) loginTokens.delete(oneTime);
      return json(res, 200, { opened });
    }

    if (req.method === "POST" && !isSameOriginPost(req)) {
      return send(res, 403, page("Forbidden", "<h1>Cross-site request refused</h1><p>Submit the form from this approval page itself.</p>"));
    }

    const url = new URL(req.url ?? "/", origin);
    if (req.method === "GET" && url.pathname === "/login") {
      // Tolerate whitespace or line breaks picked up when copying from a narrow terminal.
      const given = (url.searchParams.get("token") ?? "").replace(/[\s%]+/g, "");
      if (!consumeLoginToken(given)) {
        return send(
          res,
          401,
          page(
            "Login",
            "<h1>Invalid login link</h1><p>The login token changes every time the approval server starts.</p><ul><li>Use the <strong>latest</strong> link printed in the terminal where <code>npm run approval</code> is running (not an old link or browser history).</li><li>Make sure only one approval server is running.</li><li>Copy the whole link: in a narrow terminal it may wrap onto two lines.</li><li>Links opened by WorkBuddy work only once: ask WorkBuddy to open the dashboard again.</li></ul>",
          ),
        );
      }
      const sid = randomBytes(24).toString("base64url");
      sessions.set(sid, { csrf: randomBytes(24).toString("base64url"), createdAt: Date.now() });
      return redirect(res, "/", { "Set-Cookie": `ig_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    }

    const s = session(req);
    if (!s) {
      return send(res, 401, page("Login required", "<h1>Login required</h1><p>Open the login link printed in the terminal where you ran <code>npm run approval</code>.</p>"));
    }
    const [, sess] = s;

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, renderIndex(sess));

    const review = /^\/review\/(pkg_[0-9a-f-]{36})$/.exec(url.pathname);
    if (review?.[1] && ID_PATTERNS.package.test(review[1])) {
      if (req.method === "GET") return send(res, 200, renderReview(review[1], sess));
      if (req.method === "POST") {
        const form = await readForm(req);
        if (!form || !sameSecret(form.get("csrf") ?? "", sess.csrf)) return send(res, 403, page("Forbidden", "<h1>Invalid form token</h1><p>Reload the page and try again.</p>"));
        const decision = form.get("decision");
        if (decision !== "approve" && decision !== "reject") return send(res, 400, page("Bad request", "<h1>Choose approve or reject</h1>"));
        if (decision === "approve" && form.get("confirmReviewed") !== "yes") {
          return send(res, 400, page("Confirmation needed", `<h1>Please confirm</h1><p>Tick the box confirming you reviewed every document, then approve.</p><p><a href="/review/${review[1]}">Back</a></p>`));
        }
        try {
          recordDecision({
            packageId: review[1] as `pkg_${string}`,
            contentHash: (form.get("contentHash") ?? "").slice(0, 64),
            decision: decision === "approve" ? "approved" : "rejected",
            decidedVia: "local approval page (student)",
            note: (form.get("note") ?? "").slice(0, 500) || null,
          });
        } catch (err) {
          if (err instanceof StateError) return send(res, 409, page("Not recorded", `<h1>Decision not recorded</h1><p>${escapeHtml(err.message)}</p><p><a href="/">Back</a></p>`));
          throw err;
        }
        return redirect(res, `/review/${review[1]}`);
      }
    }

    const submitted = /^\/applications\/(app_[0-9a-f-]{36})\/submitted$/.exec(url.pathname);
    if (submitted?.[1] && req.method === "POST" && ID_PATTERNS.application.test(submitted[1])) {
      const form = await readForm(req);
      if (!form || !sameSecret(form.get("csrf") ?? "", sess.csrf)) return send(res, 403, page("Forbidden", "<h1>Invalid form token</h1>"));
      const evidence = (form.get("evidence") ?? "").trim();
      if (evidence.length < 3 || evidence.length > 300) {
        return send(res, 400, page("Evidence needed", '<h1>Submission evidence needed</h1><p>Enter the confirmation number, reference or confirmation email subject you received after submitting (3–300 characters).</p><p><a href="/">Back</a></p>'));
      }
      try {
        recordSubmission(submitted[1], evidence);
      } catch (err) {
        if (err instanceof StateError) return send(res, 409, page("Not recorded", `<h1>Not recorded</h1><p>${escapeHtml(err.message)}</p><p><a href="/">Back</a></p>`));
        throw err;
      }
      return redirect(res, "/");
    }

    const del = /^\/applications\/(app_[0-9a-f-]{36})\/delete$/.exec(url.pathname);
    if (del?.[1] && req.method === "POST" && ID_PATTERNS.application.test(del[1])) {
      const form = await readForm(req);
      if (!form || !sameSecret(form.get("csrf") ?? "", sess.csrf)) return send(res, 403, page("Forbidden", "<h1>Invalid form token</h1>"));
      if (form.get("confirmDelete") !== "yes") {
        return send(res, 400, page("Confirmation needed", '<h1>Please confirm</h1><p>Tick the box to confirm you want to delete this application permanently.</p><p><a href="/">Back</a></p>'));
      }
      try {
        const { exportDir } = deleteApplication(del[1]);
        removeExportDir(exportDir);
      } catch (err) {
        if (err instanceof StateError) return send(res, 409, page("Not deleted", `<h1>Not deleted</h1><p>${escapeHtml(err.message)}</p><p><a href="/">Back</a></p>`));
        throw err;
      }
      return redirect(res, "/");
    }

    const file = /^\/files\/(app_[0-9a-f-]{36})\/([a-z-]{1,40}\.md)$/.exec(url.pathname);
    if (file?.[1] && file[2] && req.method === "GET" && ID_PATTERNS.application.test(file[1])) {
      const row = getDb()
        .prepare(
          `SELECT e.files_json FROM applications a JOIN application_packages p ON p.application_id = a.id AND p.superseded_at IS NULL
           JOIN exports e ON e.package_id = p.id WHERE a.id = ?`,
        )
        .get(file[1]) as { files_json: string } | undefined;
      const entry = row ? (JSON.parse(row.files_json) as ExportedFile[]).find((f) => f.name === file[2]) : undefined;
      if (!entry) return send(res, 404, page("Not found", '<h1>File not found</h1><p><a href="/">Home</a></p>'));
      let body: Buffer;
      try {
        body = readFileSync(safeJoin(getPaths().exportsDir, ...entry.relativePath.split("/")));
      } catch {
        return send(res, 404, page("Missing", "<h1>The exported file is missing on disk</h1><p>Ask WorkBuddy to save the application again.</p>"));
      }
      const intact = sha256(body) === entry.sha256;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `inline; filename="${entry.name}"`,
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "X-InternGuard-File-Verified": intact ? "yes" : "no",
      });
      res.end(intact ? body : Buffer.concat([Buffer.from("WARNING: this file was changed after export (checksum mismatch).\n\n"), body]));
      return;
    }

    return send(res, 404, page("Not found", '<h1>Not found</h1><p><a href="/">Home</a></p>'));
  }

  function renderIndex(sess: Session): string {
    return page("Dashboard", renderDashboardHome(sess.csrf));
  }

  function renderReview(packageId: string, sess: Session): string {
    const pkg = getPackage(packageId);
    if (!pkg) return page("Not found", '<h1>Package not found</h1><p><a href="/">Home</a></p>');
    const app = getApplication(pkg.application_id);
    const c = app ? getCase(app.case_id) : null;
    if (!app || !c) return page("Not found", "<h1>Application not found</h1>");
    const content = JSON.parse(pkg.content_json) as ApplicationPackContent;
    const flags = JSON.parse(pkg.review_flags_json) as ReviewFlag[];
    const e: ListingEvaluation = c.evaluation;
    const approval = getApproval(pkg.id);
    const href = safeHref(c.url);
    const name = `${c.title ?? "Internship"}${c.companyName ? ` at ${c.companyName}` : ""}`;

    let decisionBlock: string;
    if (pkg.superseded_at) decisionBlock = '<p class="notice">This version was replaced by a newer one. Go back and review the latest version.</p>';
    else if (approval) decisionBlock = `<p class="notice">You <strong>${escapeHtml(approval.decision)}</strong> this version on ${escapeHtml(approval.decided_at)}.</p>`;
    else if (app.status !== "AWAITING_APPROVAL") decisionBlock = `<p class="notice">Status is ${escapeHtml(app.status)}; no decision is possible.</p>`;
    else {
      decisionBlock = `<form method="post" action="/review/${escapeHtml(pkg.id)}" class="card">
<input type="hidden" name="csrf" value="${escapeHtml(sess.csrf)}"><input type="hidden" name="contentHash" value="${escapeHtml(pkg.content_hash)}">
<p><label><input type="checkbox" name="confirmReviewed" value="yes"> I have read every document above, and everything it says about me is true.</label></p>
<p><label>Note (optional)<br><input name="note" maxlength="500" size="60"></label></p>
<button class="approve" name="decision" value="approve" type="submit">Approve this package</button>
<button class="reject" name="decision" value="reject" type="submit">Reject</button>
<p class="muted">Approving lets InternGuard save these files locally. It does not submit anything or send any email.</p></form>`;
    }

    return page(
      `Review: ${name}`,
      `<p><a href="/">← All applications</a></p>
<h1>Review: ${escapeHtml(name)}</h1>
<p><span class="status">${escapeHtml(app.status)}</span> Package version ${pkg.version}. Content SHA-256 <code>${escapeHtml(pkg.content_hash)}</code></p>
<p>Listing: ${href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(href)}</a>` : escapeHtml(c.url)}</p>
<p class="notice">${escapeHtml("Shortlisting is not a safety verdict. Check the company through official channels yourself.")}</p>
<h2>Review flags</h2>${flags.length ? `<ul>${flags.map((f) => `<li class="flag-${escapeHtml(f.level)}">${escapeHtml(f.message)}</li>`).join("")}</ul>` : '<p class="muted">No flags.</p>'}
<h2>Why this internship was shortlisted</h2>${list(e.reasons)}
<h2>Verified facts</h2>${list(e.verifiedFacts)}
<h2>Assumptions (not verified)</h2>${list(e.assumptions)}
<h2>Missing information or evidence</h2>${list([...new Set([...e.missingEvidence, ...content.missingInformation])])}
<h2>Cover letter</h2><pre>${escapeHtml(content.coverLetter)}</pre>
<h2>Email draft</h2><div class="card"><p><strong>To:</strong> ${escapeHtml(content.recruiterEmail.to ?? "(none: no recruiter email in the listing)")}<br><strong>Subject:</strong> ${escapeHtml(content.recruiterEmail.subject)}</p><pre>${escapeHtml(content.recruiterEmail.body)}</pre></div>
<h2>Checklist</h2>${list(content.checklist)}
<h2>CV suggestions</h2>${list(content.cvSuggestions)}
<h2>Your decision</h2>${decisionBlock}`,
    );
  }

  if (opts.idleExitMs && opts.onIdle) {
    const idleMs = opts.idleExitMs;
    const onIdle = opts.onIdle;
    const timer = setInterval(() => {
      if (Date.now() - lastRequest > idleMs) {
        clearInterval(timer);
        onIdle();
      }
    }, Math.min(60_000, idleMs));
    timer.unref();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, APPROVAL_HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://${APPROVAL_HOST}:${port}`;
  allowedHosts = new Set([`${APPROVAL_HOST}:${port}`, `localhost:${port}`]);
  return {
    url: origin,
    loginUrl: `${origin}/login?token=${token}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
