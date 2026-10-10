/**
 * Student dashboard view (home page of the local approval server).
 * OWNER: Developer 4. Visual design contributed by a teammate
 * (originally scripts/dashboard.mjs), moved behind the dashboard login.
 *
 * Rendered only for a logged-in student session. No scripts, no external
 * assets (the page CSP allows inline styles only). All database text is
 * escaped. There is no login token anywhere on this page.
 */
import type { ApplicationPackContent, ExportedFile } from "../shared/types.js";
import { getDb } from "../execution/db.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const DASHBOARD_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0d1117;--surface:#161b22;--surface2:#1c2128;--border:#30363d;
  --text:#e6edf3;--muted:#8b949e;--accent:#2f81f7;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--purple:#a371f7;
  --radius:12px;
}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.container{max-width:1280px;margin:0 auto}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font:13px ui-monospace,"SF Mono",Menlo,monospace;background:var(--surface2);padding:2px 6px;border-radius:4px}
.muted{color:var(--muted)}

/* Header */
.dash-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:20px;border-bottom:1px solid var(--border);margin-bottom:24px}
.dash-brand{display:flex;gap:14px;align-items:center}
.dash-logo{font-size:36px}
.dash-header h1{font-size:22px;font-weight:700;letter-spacing:-0.5px}
.dash-header p{color:var(--muted);font-size:13px}
.dash-header-right{display:flex;gap:12px;align-items:center}
.dash-updated{color:var(--muted);font-size:12px}

/* Login banner */

/* Buttons */
.btn{display:inline-block;padding:7px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);transition:all .15s}
.btn:hover{text-decoration:none;filter:brightness(1.15)}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--border)}
.btn-ghost:hover{background:var(--surface2)}

/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:28px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;text-align:center}
.stat-value{font-size:32px;font-weight:800;letter-spacing:-1px}
.stat-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px}

/* Two column */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}
@media(max-width:800px){.two-col{grid-template-columns:1fr}}

/* Chart cards */
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.chart-card h2{font-size:15px;font-weight:600;margin-bottom:16px;color:var(--text)}
.chart-body{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.empty-chart{color:var(--muted);font-style:italic;padding:24px;text-align:center;width:100%}
.chart-legend{flex:1;min-width:140px}
.legend-item{display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0;color:var(--muted)}
.legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}

/* Risk bars */
.risk-bar-row{display:flex;align-items:center;gap:10px;margin:8px 0;width:100%}
.risk-bar-label{font-size:12px;font-weight:700;width:30px;text-align:right;flex-shrink:0}
.risk-bar-track{flex:1;height:10px;background:var(--surface2);border-radius:5px;overflow:hidden}
.risk-bar-fill{height:100%;border-radius:5px;transition:width .3s}
.risk-bar-value{font-size:11px;min-width:70px;flex-shrink:0}
.risk-bar-flags{font-size:10px;color:var(--red);background:#3d1414;padding:1px 6px;border-radius:8px;flex-shrink:0}

/* Section headers */
section{margin-bottom:28px}
section > h2{font-size:16px;font-weight:600;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}

/* Pipeline cards */
.pipeline-grid{display:flex;flex-direction:column;gap:14px}
.app-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;transition:border-color .15s}
.app-card:hover{border-color:var(--accent)}
.app-card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.app-card-title{font-size:15px;font-weight:600}
.listing-ref{display:inline-block;background:var(--surface2);color:var(--accent);font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-right:8px}
.app-card-checks{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.check-pill{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:5px 12px;display:flex;flex-direction:column;align-items:center;min-width:80px}
.check-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px}
.check-value{font-size:12px;font-weight:600}

/* Red flags */
.red-flags{margin:10px 0}
.red-flag{font-size:12px;padding:6px 10px;border-radius:6px;margin:4px 0}
.flag-high{background:#3d1414;color:#f85149;border-left:3px solid #f85149}
.flag-medium{background:#2d2400;color:#d29922;border-left:3px solid #d29922}
.flag-low{background:#21262d;color:#8b949e;border-left:3px solid #8b949e}

/* Reasons */
.reasons{margin:8px 0}
.reason{font-size:12px;color:var(--muted);margin:2px 0}

/* Pipeline */
.pipeline{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:12px 0;padding:10px;background:var(--surface2);border-radius:8px}
.pipe-step{font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.3px}
.pipe-step.done{background:#143f1a;color:#3fb950}
.pipe-step.current{background:#2d2400;color:#d29922;animation:pulse 2s infinite}
.pipe-step.skipped{background:#21262d;color:#485159;text-decoration:line-through}
.pipe-step.rejected{background:#3d1414;color:#f85149}
.pipe-arrow{color:#485159;font-size:11px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}

/* Card footer */
.app-card-footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.export-badge{font-size:11px;color:var(--accent);background:#0d2d5e;padding:3px 8px;border-radius:6px}

/* Table */
.table-wrap{overflow-x:auto}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{text-align:left;padding:10px 12px;background:var(--surface2);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid var(--border)}
.data-table td{padding:10px 12px;border-bottom:1px solid var(--border)}
.data-table tr:hover td{background:var(--surface2)}
.badge-sm{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;text-transform:capitalize}
.empty-row{text-align:center;color:var(--muted);padding:24px}

/* Events */
.event-list{max-height:300px;overflow-y:auto}
.event-item{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px}
.event-time{color:var(--muted);white-space:nowrap;min-width:140px}
.event-listing{font-weight:700;color:var(--accent);min-width:30px}
.event-text{color:var(--text)}

/* Tasks */
.task-list{max-height:300px;overflow-y:auto}
.task-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px}
.task-item.done{opacity:0.5}
.task-status{font-size:16px}
.task-listing{font-weight:700;color:var(--accent);min-width:30px}
.task-desc{flex:1}
.task-due{color:var(--yellow);font-size:11px}

/* Footer */
.dash-footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--border);text-align:center;color:var(--muted);font-size:12px}
.dash-footer p{margin:2px 0}

/* Error */
.error-box{background:var(--surface);border:1px solid var(--red);border-radius:var(--radius);padding:24px;text-align:center}
.error-box h1{color:var(--red);font-size:20px;margin-bottom:12px}

/* Shared pages (review, forms) in the same dark theme */
.container h1{font-size:22px;font-weight:700;margin:4px 0 14px}
.container > h2,.container form h2{font-size:16px;font-weight:600;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.container p{margin:6px 0}
.container ul{margin:6px 0 6px 22px}
.container li{margin:3px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;margin:12px 0}
.notice{background:#2d2400;border:1px solid #6b5200;color:#f0d78c;border-radius:8px;padding:10px 14px;margin:10px 0}
.status{display:inline-block;padding:2px 10px;border-radius:10px;background:var(--surface2);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.3px}
pre{white-space:pre-wrap;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;font:13px/1.5 ui-monospace,"SF Mono",Menlo,monospace;color:var(--text)}
.flag-blocking{color:var(--red)}.flag-review{color:var(--yellow)}
button{font:inherit;font-size:13px;font-weight:600;padding:7px 16px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;margin-right:8px}
button.approve{background:var(--green);border-color:var(--green);color:#0d1117}
button.reject{background:transparent;border-color:var(--red);color:var(--red)}
input[type=text],input:not([type]),input[name=evidence],input[name=note]{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 10px;font:inherit}
a.button{display:inline-block;padding:7px 16px;border-radius:8px;background:var(--green);color:#0d1117;font-size:13px;font-weight:700;margin:2px 6px 2px 0}
a.button:hover{text-decoration:none;filter:brightness(1.1)}
a.button.secondary{background:transparent;color:var(--green);border:1px solid var(--green)}
details{margin:8px 0}
details summary{cursor:pointer;color:var(--muted);font-size:12px}
details.danger summary{color:var(--red)}
.actions{margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.files a{margin-right:10px;font-size:12px}
.safety-note{color:var(--muted);font-size:12px;margin:-6px 0 20px}
`;

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

// ---------------------------------------------------------------------------
// Email links (the student presses Send; InternGuard never sends email)
// ---------------------------------------------------------------------------

const SAFE_ADDRESS = /^[^\s@<>"?&#%,;:]+@[^\s@<>"?&#%,;:]+\.[^\s@<>"?&#%,;:]+$/;

/**
 * mailto: link for the approved email draft. `to` may be null (the listing has
 * no recruiter address): the mail app opens with an empty To field for the
 * student to fill in. Returns null for an unsafe address or a too-long link.
 */
export function mailtoLink(to: string | null, subject: string, body: string): string | null {
  if (to && !SAFE_ADDRESS.test(to)) return null;
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
  const link = `mailto:${to ?? ""}?subject=${enc(subject)}&body=${enc(body)}`;
  return link.length <= 1900 ? link : null;
}

/**
 * Gmail web compose link, opened in the student's own browser session.
 * Format: mail.google.com/mail/u/0/?tf=cm&to=&su=&body= (widely used, not an
 * officially documented Google API). `to` may be null: empty To field.
 */
export function gmailComposeLink(to: string | null, subject: string, body: string): string | null {
  if (to && !SAFE_ADDRESS.test(to)) return null;
  const q = new URLSearchParams({ tf: "cm", fs: "1" });
  if (to) q.set("to", to);
  q.set("su", subject);
  q.set("body", body);
  const link = `https://mail.google.com/mail/u/0/?${q.toString().replace(/\+/g, "%20")}`;
  return link.length <= 7500 ? link : null;
}

// ---------------------------------------------------------------------------
// Labels and colours
// ---------------------------------------------------------------------------

const C = { green: "#3fb950", yellow: "#d29922", red: "#f85149", blue: "#2f81f7", purple: "#a371f7", grey: "#8b949e" };
const BG = { green: "#143f1a", yellow: "#2d2400", red: "#3d1414", blue: "#0d2d5e", grey: "#21262d" };

function statusColor(status: string | null): { fg: string; bg: string } {
  const map: Record<string, { fg: string; bg: string }> = {
    PREPARED: { fg: C.grey, bg: BG.grey },
    AWAITING_APPROVAL: { fg: C.yellow, bg: BG.yellow },
    REJECTED_BY_STUDENT: { fg: C.red, bg: BG.red },
    READY_TO_SUBMIT: { fg: C.green, bg: BG.green },
    MANUAL_ACTION_REQUIRED: { fg: C.blue, bg: BG.blue },
    SUBMITTED: { fg: C.purple, bg: "#2a1a4a" },
  };
  return map[status ?? ""] ?? { fg: C.grey, bg: BG.grey };
}

function decisionColor(decision: string): { fg: string; bg: string; label: string } {
  const map: Record<string, { fg: string; bg: string; label: string }> = {
    shortlisted: { fg: C.green, bg: BG.green, label: "Shortlisted" },
    rejected: { fg: C.red, bg: BG.red, label: "Rejected" },
    not_selected: { fg: C.grey, bg: BG.grey, label: "Not selected" },
    insufficient_evidence: { fg: C.yellow, bg: BG.yellow, label: "Insufficient evidence" },
  };
  return map[decision] ?? { fg: C.grey, bg: BG.grey, label: decision };
}

/** Scam-check assessment. "No major indicators" is never shown as "low" or "safe". */
function riskInfo(assessment: string | null): { label: string; fg: string; bg: string; pct: number } {
  switch (assessment) {
    case "high_risk":
      return { label: "high risk", fg: C.red, bg: BG.red, pct: 100 };
    case "medium_risk":
      return { label: "medium risk", fg: C.yellow, bg: BG.yellow, pct: 60 };
    case "no_major_indicators_detected":
      return { label: "no major indicators", fg: C.green, bg: BG.green, pct: 20 };
    case "insufficient_evidence":
      return { label: "insufficient evidence", fg: C.yellow, bg: BG.yellow, pct: 8 };
    default:
      return { label: "not checked", fg: C.grey, bg: BG.grey, pct: 4 };
  }
}

function companyColor(status: string): string {
  if (status === "verified") return C.green;
  if (status === "unverified" || status === "inconclusive") return C.yellow;
  if (status === "not_found") return C.red;
  return C.grey;
}

function eligibilityColor(outcome: string): string {
  if (outcome === "eligible") return C.green;
  if (outcome === "conditionally_eligible") return C.yellow;
  if (outcome === "not_eligible") return C.red;
  return C.grey;
}

const pretty = (s: string) => s.replace(/_/g, " ");

// ---------------------------------------------------------------------------
// Charts (inline SVG / CSS, no scripts)
// ---------------------------------------------------------------------------

function donutChart(data: { label: string; value: number; color: string }[]): string {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return '<div class="empty-chart">No applications yet</div>';
  const cx = 80, cy = 80, r = 60, r2 = 38;
  let angle = -Math.PI / 2;
  const slices: string[] = [];
  for (const d of data) {
    if (d.value === 0) continue;
    const portion = d.value / total;
    if (portion >= 0.9999) {
      slices.push(`<circle cx="${cx}" cy="${cy}" r="${(r + r2) / 2}" fill="none" stroke="${d.color}" stroke-width="${r - r2}"/>`);
      break;
    }
    const a2 = angle + portion * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const x3 = cx + r2 * Math.cos(a2), y3 = cy + r2 * Math.sin(a2);
    const x4 = cx + r2 * Math.cos(angle), y4 = cy + r2 * Math.sin(angle);
    const large = portion > 0.5 ? 1 : 0;
    slices.push(`<path d="M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r2},${r2} 0 ${large} 0 ${x4},${y4} Z" fill="${d.color}" stroke="#0d1117" stroke-width="2"/>`);
    angle = a2;
  }
  return `<svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="${total} applications by status">${slices.join("")}<text x="80" y="76" text-anchor="middle" fill="#e6edf3" font-size="28" font-weight="700">${total}</text><text x="80" y="94" text-anchor="middle" fill="#8b949e" font-size="11">applications</text></svg>`;
}

function riskBars(cases: Row[]): string {
  const rows = cases.map((c) => {
    const ri = riskInfo(c.ev.riskAssessment ?? null);
    const flags = c.redFlags.length as number;
    return `<div class="risk-bar-row"><span class="risk-bar-label">${esc(c.listing_ref)}</span>
<div class="risk-bar-track"><div class="risk-bar-fill" style="width:${ri.pct}%;background:${ri.fg}"></div></div>
<span class="risk-bar-value" style="color:${ri.fg}">${esc(ri.label)}</span>${flags > 0 ? `<span class="risk-bar-flags">${flags} flag${flags > 1 ? "s" : ""}</span>` : ""}</div>`;
  });
  return rows.join("") || '<div class="empty-chart">No listings investigated</div>';
}

function statCard(label: string, value: number, color: string): string {
  return `<div class="stat-card" style="border-top:3px solid ${color}"><div class="stat-value" style="color:${color}">${value}</div><div class="stat-label">${esc(label)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function loadDashboardData(): { cases: Row[]; events: Row[]; tasks: Row[] } {
  const db = getDb();
  const cases = db
    .prepare(
      `SELECT c.id AS case_id, c.listing_ref, c.url, c.title, c.company_name, c.decision, c.rank, c.score, c.evaluation_json,
              c.risk_investigation_id, c.created_at AS case_created,
              a.id AS app_id, a.status, a.apply_url, a.submitted_at, a.submission_evidence,
              p.id AS pkg_id, p.version, p.content_json,
              ap.decision AS approval_decision, ap.decided_at,
              e.files_json
       FROM internship_cases c
       LEFT JOIN applications a ON a.case_id = c.id
       LEFT JOIN application_packages p ON p.application_id = a.id AND p.superseded_at IS NULL
       LEFT JOIN approvals ap ON ap.package_id = p.id
       LEFT JOIN exports e ON e.package_id = p.id
       ORDER BY c.created_at DESC, c.rank IS NULL, c.rank, c.listing_ref`,
    )
    .all() as Row[];
  // Show only the latest shortlist run per listing URL, so re-runs don't duplicate cards.
  const seen = new Set<string>();
  const latest = cases.filter((c) => {
    const key = `${c.url}`;
    if (seen.has(key) && !c.app_id) return false;
    seen.add(key);
    return true;
  });
  const riskStmt = db.prepare("SELECT result_json FROM investigations WHERE id = ?");
  for (const c of latest) {
    c.ev = parse<Row>(c.evaluation_json, {});
    const risk = c.risk_investigation_id ? (riskStmt.get(c.risk_investigation_id) as Row | undefined) : undefined;
    c.redFlags = (parse<Row>(risk?.result_json, {}).data?.redFlags ?? []) as Row[];
  }
  latest.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || String(a.listing_ref).localeCompare(String(b.listing_ref)));
  const events = db
    .prepare(
      `SELECT ev.event, ev.from_status, ev.to_status, ev.created_at, c.listing_ref
       FROM events ev JOIN applications a ON a.id = ev.application_id JOIN internship_cases c ON c.id = a.case_id
       ORDER BY ev.id DESC LIMIT 15`,
    )
    .all() as Row[];
  const tasks = db
    .prepare(
      `SELECT t.description, t.due_date, t.status, c.listing_ref, t.application_id
       FROM follow_up_tasks t JOIN applications a ON a.id = t.application_id JOIN internship_cases c ON c.id = a.case_id
       ORDER BY t.status DESC, t.due_date`,
    )
    .all() as Row[];
  return { cases: latest, events, tasks };
}

// ---------------------------------------------------------------------------
// Per-card actions (approve, files, email, submitted, delete)
// ---------------------------------------------------------------------------

function cardActions(c: Row, csrf: string): string {
  if (!c.app_id) return "";
  const parts: string[] = [];
  const buttons: string[] = [];
  if (c.pkg_id && c.status === "AWAITING_APPROVAL") buttons.push(`<a href="/review/${esc(c.pkg_id)}" class="btn btn-primary">Review &amp; approve &rarr;</a>`);
  else if (c.pkg_id) buttons.push(`<a href="/review/${esc(c.pkg_id)}" class="btn btn-ghost">View package v${esc(c.version)}</a>`);
  const apply = safeHref(c.apply_url);
  if (apply) buttons.push(`<a href="${esc(apply)}" class="btn btn-ghost" target="_blank" rel="noopener noreferrer">Apply link</a>`);
  if (buttons.length) parts.push(`<div class="app-card-footer">${buttons.join("")}</div>`);

  if (c.approval_decision) parts.push(`<p class="muted">You ${esc(c.approval_decision)} version ${esc(c.version)} on ${esc(new Date(c.decided_at).toLocaleString())}.</p>`);
  if (c.files_json) {
    const files = parse<ExportedFile[]>(c.files_json, []);
    parts.push(`<p class="files"><strong>Exported files:</strong> ${files.map((f) => `<a href="/files/${esc(c.app_id)}/${esc(f.name)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join("")}</p>`);
  }
  if (c.status === "SUBMITTED") parts.push(`<p>Submitted ${esc(new Date(c.submitted_at).toLocaleString())}. Evidence: ${esc(c.submission_evidence)}</p>`);

  // Email buttons appear as soon as the student has approved this exact package.
  if ((c.status === "READY_TO_SUBMIT" || c.status === "MANUAL_ACTION_REQUIRED") && c.approval_decision === "approved" && c.content_json) {
    const email = parse<ApplicationPackContent | null>(c.content_json, null)?.recruiterEmail;
    if (email) {
      const link = mailtoLink(email.to, email.subject, email.body);
      const gmail = gmailComposeLink(email.to, email.subject, email.body);
      if (link || gmail) {
        const b = [
          gmail ? `<a class="button" href="${esc(gmail)}" target="_blank" rel="noopener noreferrer">✉ Open in Gmail${email.to ? "" : " (add the recipient yourself)"}</a>` : "",
          link ? `<a class="button secondary" href="${esc(link)}">Open in my email app</a>` : "",
        ].filter(Boolean).join(" ");
        const toLine = email.to
          ? `To ${esc(email.to)} (from the listing).`
          : "The listing gives no recruiter email address: type the address from the company's official careers or contact page into the To field.";
        parts.push(`<p>${b}</p><p class="muted">${toLine} Attach your CV, check the text, then press Send yourself.</p>
<details><summary>Show email text (to copy manually)</summary><p><strong>To:</strong> ${esc(email.to ?? "(add it yourself)")}<br><strong>Subject:</strong> ${esc(email.subject)}</p><pre>${esc(email.body)}</pre></details>`);
      } else {
        parts.push(`<p class="muted">The email is too long for a one-click link: copy it from the "Show email text" section or <a href="/files/${esc(c.app_id)}/email-draft.md" target="_blank" rel="noopener">email-draft.md</a>.</p>
<details><summary>Show email text (to copy manually)</summary><p><strong>Subject:</strong> ${esc(email.subject)}</p><pre>${esc(email.body)}</pre></details>`);
      }
    }
  }
  if (c.status === "MANUAL_ACTION_REQUIRED") {
    parts.push(`<p>Submit the application yourself${apply ? ` at <a href="${esc(apply)}" rel="noopener noreferrer" target="_blank">${esc(apply)}</a>` : ""}, then record it:</p>
<form method="post" action="/applications/${esc(c.app_id)}/submitted"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input name="evidence" required minlength="3" maxlength="300" size="36" placeholder="Confirmation number or reference">
<button type="submit">I submitted it</button></form>`);
  }

  parts.push(`<details class="danger"><summary>Delete application</summary>
<form method="post" action="/applications/${esc(c.app_id)}/delete"><input type="hidden" name="csrf" value="${esc(csrf)}">
<p>This permanently removes this application's packages, approval, tracker history and exported files from InternGuard. You can prepare a new package for the listing afterwards.${c.status === "SUBMITTED" ? " <strong>It does not withdraw the application from the employer.</strong>" : ""}</p>
<p><label><input type="checkbox" name="confirmDelete" value="yes"> Yes, delete this application permanently</label></p>
<button class="reject" type="submit">Delete permanently</button></form></details>`);
  return `<div class="actions">${parts.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function renderDashboardHome(csrf: string): string {
  const { cases, events, tasks } = loadDashboardData();
  const count = (f: (c: Row) => boolean) => cases.filter(f).length;
  const awaiting = count((c) => c.status === "AWAITING_APPROVAL");
  const approved = count((c) => c.approval_decision === "approved");
  const rejectedByStudent = count((c) => c.approval_decision === "rejected");
  const exported = count((c) => Boolean(c.files_json));
  const submitted = count((c) => c.status === "SUBMITTED");
  const donut = [
    { label: "Awaiting approval", value: awaiting, color: C.yellow },
    { label: "Approved, not exported", value: count((c) => c.status === "READY_TO_SUBMIT"), color: C.green },
    { label: "Exported, submit yourself", value: count((c) => c.status === "MANUAL_ACTION_REQUIRED"), color: C.blue },
    { label: "Submitted", value: submitted, color: C.purple },
    { label: "Rejected by you", value: rejectedByStudent, color: C.red },
  ];

  const cards = cases.map((c) => {
    const ri = riskInfo(c.ev.riskAssessment ?? null);
    const company = String(c.ev.companyVerificationStatus ?? "not checked");
    const elig = String(c.ev.eligibilityOutcome ?? "not checked");
    const dc = decisionColor(c.decision);
    const sc = statusColor(c.status);
    const reasons = (c.ev.reasons ?? []) as string[];
    const steps = ['<span class="pipe-step done">Investigate</span>'];
    if (c.decision === "shortlisted") {
      steps.push('<span class="pipe-step done">Shortlist</span>');
      steps.push(`<span class="pipe-step ${c.pkg_id ? "done" : "current"}">Prepare</span>`);
      if (c.pkg_id) {
        if (c.approval_decision === "approved") {
          steps.push('<span class="pipe-step done">Approve</span>');
          steps.push(`<span class="pipe-step ${c.files_json ? "done" : "current"}">Export</span>`);
          if (c.files_json) steps.push(`<span class="pipe-step ${c.status === "SUBMITTED" ? "done" : "current"}">Submit</span>`);
        } else if (c.approval_decision === "rejected") steps.push('<span class="pipe-step rejected">Rejected</span>');
        else steps.push('<span class="pipe-step current">Approve</span>');
      }
    } else steps.push(`<span class="pipe-step skipped">Shortlist</span>`);

    return `<div class="app-card"${c.app_id ? ` id="${esc(c.app_id)}"` : ""}>
  <div class="app-card-header">
    <div class="app-card-title"><span class="listing-ref">${esc(c.listing_ref)}</span>${esc(c.title || "Internship")}${c.company_name ? ` <span class="muted">at ${esc(c.company_name)}</span>` : ""}</div>
    <div><span class="badge-sm" style="color:${dc.fg};background:${dc.bg}">${esc(dc.label)}</span>${c.status ? ` <span class="badge-sm" style="color:${sc.fg};background:${sc.bg}">${esc(pretty(c.status))}</span>` : ""}</div>
  </div>
  <div class="app-card-checks">
    <div class="check-pill"><span class="check-label">Scam check</span><span class="check-value" style="color:${ri.fg}">${esc(ri.label)}</span></div>
    <div class="check-pill"><span class="check-label">Company</span><span class="check-value" style="color:${companyColor(company)}">${esc(pretty(company))}</span></div>
    <div class="check-pill"><span class="check-label">Eligibility</span><span class="check-value" style="color:${eligibilityColor(elig)}">${esc(pretty(elig))}</span></div>
    ${c.score != null ? `<div class="check-pill"><span class="check-label">Score</span><span class="check-value">${esc(c.score)}</span></div>` : ""}
  </div>
  ${c.redFlags.length ? `<div class="red-flags">${(c.redFlags as Row[]).slice(0, 4).map((f) => `<div class="red-flag ${f.severity === "high" ? "flag-high" : f.severity === "medium" ? "flag-medium" : "flag-low"}"><strong>${esc(pretty(String(f.code)))}</strong> (${esc(f.basis)}) &mdash; ${esc(f.description)}</div>`).join("")}</div>` : ""}
  ${reasons.length ? `<div class="reasons">${reasons.slice(0, 3).map((r) => `<div class="reason">&bull; ${esc(r)}</div>`).join("")}</div>` : ""}
  <div class="pipeline">${steps.join('<span class="pipe-arrow">&rarr;</span>')}</div>
  ${cardActions(c, csrf)}
</div>`;
  });

  const tableRows = cases.map((c) => {
    const ri = riskInfo(c.ev.riskAssessment ?? null);
    const company = String(c.ev.companyVerificationStatus ?? "not checked");
    const elig = String(c.ev.eligibilityOutcome ?? "not checked");
    const dc = decisionColor(c.decision);
    return `<tr><td><strong>${esc(c.listing_ref)}</strong></td><td>${esc(c.company_name || "Unknown")}</td>
<td><span class="badge-sm" style="color:${ri.fg};background:${ri.bg}">${esc(ri.label)}</span></td>
<td><span class="badge-sm" style="color:${companyColor(company)}">${esc(pretty(company))}</span></td>
<td><span class="badge-sm" style="color:${eligibilityColor(elig)}">${esc(pretty(elig))}</span></td>
<td><span class="badge-sm" style="color:${dc.fg};background:${dc.bg}">${esc(dc.label)}</span></td><td>${c.score != null ? esc(c.score) : "&mdash;"}</td></tr>`;
  });

  const eventItems = events.map((ev) => `<div class="event-item"><span class="event-time">${esc(new Date(ev.created_at).toLocaleString())}</span><span class="event-listing">${esc(ev.listing_ref)}</span><span class="event-text">${esc(pretty(String(ev.event)))}${ev.from_status && ev.to_status ? ` (${esc(pretty(ev.from_status))} &rarr; ${esc(pretty(ev.to_status))})` : ""}</span></div>`);
  const taskItems = tasks.map((t) => `<div class="task-item ${esc(t.status)}"><span class="task-status">${t.status === "done" ? "&#10003;" : "&#9744;"}</span><span class="task-listing">${esc(t.listing_ref)}</span><span class="task-desc">${esc(t.description)}</span>${t.due_date ? `<span class="task-due">due ${esc(t.due_date)}</span>` : ""}</div>`);

  return `
<header class="dash-header">
  <div class="dash-brand"><span class="dash-logo">&#128737;</span><div><h1>InternGuard</h1><p>Internship Safety &amp; Eligibility Dashboard</p></div></div>
  <div class="dash-header-right"><span class="dash-updated">Updated ${esc(new Date().toLocaleTimeString())}</span><a href="/" class="btn btn-ghost">Refresh</a></div>
</header>
<p class="safety-note">InternGuard never submits applications or sends email. Shortlisting is not a safety verdict: check each company through official channels yourself.</p>
<section class="stats-grid">
  ${statCard("Listings", cases.length, C.grey)}${statCard("Shortlisted", count((c) => c.decision === "shortlisted"), C.green)}${statCard("Rejected", count((c) => c.decision === "rejected"), C.red)}${statCard("Insufficient", count((c) => c.decision === "insufficient_evidence"), C.yellow)}
  ${statCard("Awaiting you", awaiting, C.yellow)}${statCard("Approved", approved, C.green)}${statCard("Exported", exported, C.blue)}${statCard("Submitted", submitted, C.purple)}
</section>
<section class="two-col">
  <div class="chart-card"><h2>Application status</h2><div class="chart-body">${donutChart(donut)}<div class="chart-legend">${donut.map((d) => `<div class="legend-item"><span class="legend-dot" style="background:${d.color}"></span>${esc(d.label)} (${d.value})</div>`).join("")}</div></div></div>
  <div class="chart-card"><h2>Scam check by listing</h2><div class="chart-body">${riskBars(cases)}</div></div>
</section>
<section><h2>Application pipeline</h2><div class="pipeline-grid">${cards.join("") || '<div class="empty-chart">No listings yet. Ask WorkBuddy to investigate some internships.</div>'}</div></section>
<section><h2>Investigation results</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Listing</th><th>Company</th><th>Scam check</th><th>Verification</th><th>Eligibility</th><th>Decision</th><th>Score</th></tr></thead><tbody>${tableRows.join("") || '<tr><td colspan="7" class="empty-row">No data</td></tr>'}</tbody></table></div></section>
<section class="two-col">
  <div class="chart-card"><h2>Recent activity</h2><div class="event-list">${eventItems.join("") || '<div class="empty-chart">No activity yet</div>'}</div></div>
  <div class="chart-card"><h2>Follow-up tasks</h2><div class="task-list">${taskItems.join("") || '<div class="empty-chart">No tasks</div>'}</div></div>
</section>
<footer class="dash-footer"><p>InternGuard &mdash; informational only. Not legal, immigration or employment advice.</p></footer>`;
}
