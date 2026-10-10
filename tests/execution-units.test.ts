/** Execution-layer units (Developer 4): path safety, hashing, content validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { safeJoin, slugify } from "../src/execution/paths.js";
import { canonicalJson, packageHash } from "../src/execution/store.js";
import { validatePackContent, type CaseEvidence } from "../src/execution/pack.js";
import { escapeHtml, gmailComposeLink, mailtoLink } from "../src/approval/server.js";
import type { ApplicationPackContent } from "../src/shared/types.js";

test("safeJoin refuses traversal and odd segments", () => {
  // Compare with the OS's own path format (on Windows this resolves to C:\x\exports\...).
  assert.equal(safeJoin("/x/exports", "acme-1", "cover-letter.md"), path.resolve("/x/exports", "acme-1", "cover-letter.md"));
  for (const bad of ["..", "../etc", "a/b", "a\\b", "", "x\u0000"]) assert.throws(() => safeJoin("/x/exports", bad), /Unsafe/);
});

test("slugify produces safe folder names", () => {
  assert.equal(slugify("Acme Analytics Sdn. Bhd."), "acme-analytics-sdn-bhd");
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("株式会社"), "application");
});

test("content hash is key-order independent and content sensitive", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  const c: ApplicationPackContent = { coverLetter: "x", recruiterEmail: { to: null, subject: "s", body: "b" }, checklist: [], cvSuggestions: [], missingInformation: [], skillsReferenced: [] };
  assert.equal(packageHash("case_1", c), packageHash("case_1", JSON.parse(JSON.stringify(c)) as ApplicationPackContent));
  assert.notEqual(packageHash("case_1", c), packageHash("case_1", { ...c, coverLetter: "y" }));
  assert.notEqual(packageHash("case_1", c), packageHash("case_2", c));
});

const ev = {
  record: { url: "https://acme.example/job", applyUrl: null, companyName: "Acme", student: { name: "Alex Tan", major: "CS", skills: ["Python"], experience: [], email: "alex@example.com" } },
  listingText: "Email jobs@acme.example. Requires Python and Docker.",
  requirements: { requiredSkills: ["Python", "Docker"] },
  company: null,
} as unknown as CaseEvidence;
const good: ApplicationPackContent = {
  coverLetter: "Dear Acme team, I am Alex Tan and I use Python. Apply at https://acme.example/job.",
  recruiterEmail: { to: "jobs@acme.example", subject: "Application", body: "Reply to alex@example.com" },
  checklist: ["Apply"], cvSuggestions: [], missingInformation: [], skillsReferenced: ["Python"],
};

test("grounded content has no blocking flags", () => {
  assert.deepEqual(validatePackContent(good, ev).filter((f) => f.level === "blocking"), []);
});

test("invented contacts, links and skills are blocking; risky wording is flagged for review", () => {
  const flags = validatePackContent({
    ...good,
    coverLetter: good.coverLetter + " I am experienced with Docker. Call +60 12 999 8888. [Your phone]",
    recruiterEmail: { ...good.recruiterEmail, to: "boss@acme.example", body: "see https://evil.example" },
    skillsReferenced: ["Python", "Go"],
  }, ev);
  const blocking = flags.filter((f) => f.level === "blocking").map((f) => f.message).join("\n");
  assert.match(blocking, /"Go"/);
  assert.match(blocking, /boss@acme\.example/);
  assert.match(blocking, /evil\.example/);
  const review = flags.filter((f) => f.level === "review").map((f) => f.message).join("\n");
  assert.match(review, /Docker/);
  assert.match(review, /Phone number/);
  assert.match(review, /Placeholder/);
});

test("an implied skill may be referenced; an unbacked one is still blocked", () => {
  const cyber = { ...ev, record: { ...ev.record, student: { ...ev.record.student, skills: ["Kali Linux"] } } } as unknown as CaseEvidence;
  const ok = validatePackContent({ ...good, coverLetter: good.coverLetter + " I use Linux daily.", skillsReferenced: ["Linux"] }, cyber);
  assert.deepEqual(ok.filter((f) => f.level === "blocking"), []);
  const bad = validatePackContent({ ...good, skillsReferenced: ["Windows"] }, cyber);
  assert.ok(bad.some((f) => f.level === "blocking" && f.message.includes('"Windows"')));
});

test("mailto link: encoded, only with a valid address, and length-capped", () => {
  const link = mailtoLink("jobs@acme.example", "Application: Intern (Alex)", "Dear team,\nThanks & regards");
  assert.equal(link, "mailto:jobs@acme.example?subject=Application%3A%20Intern%20(Alex)&body=Dear%20team%2C%0D%0AThanks%20%26%20regards");
  assert.equal(mailtoLink(null, "s", "b"), "mailto:?subject=s&body=b", "no recruiter address: empty To for the student to fill");
  assert.equal(mailtoLink("a@b.com?bcc=evil@x.com", "s", "b"), null, "no header injection through the address");
  assert.equal(mailtoLink("jobs@acme.example", "s", "x".repeat(3000)), null);
});

test("Gmail compose link: fields encoded, refused without a safe address", () => {
  const link = gmailComposeLink("jobs@acme.example", "Application: Intern", "Dear team,\nThanks & regards") ?? "";
  const u = new URL(link);
  assert.equal(u.origin + u.pathname, "https://mail.google.com/mail/u/0/");
  assert.equal(u.searchParams.get("tf"), "cm");
  assert.equal(u.searchParams.get("to"), "jobs@acme.example");
  assert.equal(u.searchParams.get("su"), "Application: Intern");
  assert.equal(u.searchParams.get("body"), "Dear team,\nThanks & regards");
  assert.doesNotMatch(link, /\+/, "spaces encoded as %20, not +");
  const noTo = new URL(gmailComposeLink(null, "s", "b") ?? "");
  assert.equal(noTo.searchParams.has("to"), false, "no recruiter address: no invented recipient");
  assert.equal(noTo.searchParams.get("su"), "s");
  assert.equal(gmailComposeLink("a@b.com&bcc=evil@x.com", "s", "b"), null);
});

test("removeExportDir refuses anything but an InternGuard folder inside exports", async () => {
  const { mkdtempSync, mkdirSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { removeExportDir } = await import("../src/execution/exporter.js");
  const root = mkdtempSync(path.join(tmpdir(), "ig-exp-"));
  process.env.INTERNGUARD_EXPORTS_DIR = root;
  const good = path.join(root, "acme-analytics-1a2b3c4d");
  mkdirSync(good);
  assert.equal(removeExportDir(path.join(root, "..")), false);
  assert.equal(removeExportDir(root), false);
  assert.equal(removeExportDir(path.join(root, "notes")), false);
  assert.equal(removeExportDir(path.join(tmpdir(), "acme-analytics-1a2b3c4d")), false, "same name outside exports");
  assert.equal(removeExportDir(good), true);
  assert.equal(existsSync(good), false);
  delete process.env.INTERNGUARD_EXPORTS_DIR;
});

test("HTML escaping for the approval page", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
});
