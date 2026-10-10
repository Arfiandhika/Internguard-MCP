/**
 * Tests for src/tools/scam-check.ts (Developer 2).
 * Run with: npm test   (Node's built-in test runner via tsx)
 */
import { describe, test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import {
  NOT_A_SAFETY_VERDICT,
  SCAM_CHECK_VERSION,
  analyzeText,
  analyzeUrl,
  checkInternshipRisk,
  type ScamAssessment,
  type ScamCheckRequest,
  type ScamRiskData,
} from "../src/tools/scam-check.js";
import type { ToolResult } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ExampleCase {
  id: string;
  kind: "legitimate_looking" | "suspicious" | "inconclusive";
  input: { url: string; jobDescription: string };
  expect: {
    assessment?: ScamAssessment;
    assessmentIn?: ScamAssessment[];
    status?: "success" | "partial" | "error";
    mustInclude?: string[];
    mustNotInclude?: string[];
    observedCodes?: string[];
    heuristicCodes?: string[];
  };
}

const examples = JSON.parse(
  readFileSync(new URL("../examples/scam-cases.json", import.meta.url), "utf8"),
) as { cases: ExampleCase[] };

/** Bypass the static parameter type to test runtime handling of bad input. */
const run = (input: unknown) => checkInternshipRisk(input as ScamCheckRequest);

function codes(result: ToolResult<ScamRiskData>): string[] {
  return result.data?.redFlags.map((f) => f.code) ?? [];
}

/** Every human-facing string in a result. */
function allText(result: ToolResult<ScamRiskData>): string {
  return [
    ...result.warnings,
    ...result.evidence.map((e) => e.description),
    result.data?.recommendation ?? "",
    ...(result.data?.limitations ?? []),
  ].join("\n");
}

const SAFETY_CLAIM = /\b(?:is|looks|appears|seems|are|be)\s+(?:safe|legit|legitimate|genuine|verified|trustworthy)\b/i;
const NEGATION = /\b(?:not|never|no|cannot)\b|n't\b/i;

/** Sentences that assert safety without negating it ("this listing is safe"). */
function unnegatedSafetyClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .filter((sentence) => SAFETY_CLAIM.test(sentence) && !NEGATION.test(sentence));
}

function assertWellFormed(result: ToolResult<ScamRiskData>): void {
  assert.ok(["success", "partial", "error"].includes(result.status));
  assert.ok(Array.isArray(result.evidence) && Array.isArray(result.warnings));
  for (const e of result.evidence) {
    assert.equal(typeof e.source, "string");
    assert.equal(typeof e.description, "string");
  }
  if (result.status === "error") {
    assert.equal(result.data, null);
    assert.ok(result.warnings.length > 0, "error results must explain why");
    return;
  }
  const d = result.data;
  assert.ok(d, "non-error results carry data");
  assert.ok(d.riskScore !== null && d.riskScore >= 0 && d.riskScore <= 100);
  assert.equal(d.analyzerVersion, SCAM_CHECK_VERSION);
  assert.equal(result.evidence.length, d.redFlags.length, "one evidence entry per indicator");
  assert.equal(d.observedCount + d.heuristicCount, d.redFlags.length);
  for (const f of d.redFlags) {
    assert.ok(f.basis === "observed" || f.basis === "heuristic");
    assert.ok(["low", "medium", "high"].includes(f.severity));
    assert.ok(f.matchedText.length > 0 && f.matchedText.length <= 260, `excerpt bounded for ${f.code}`);
  }
  for (const e of result.evidence) assert.match(e.description, /^\[(?:observed|heuristic)\] /);
  assert.ok(d.limitations.includes(NOT_A_SAFETY_VERDICT), "limitations always include the not-a-safety-verdict statement");
}

// ---------------------------------------------------------------------------
// Guard: the module must never touch the network
// ---------------------------------------------------------------------------

const fetchMock = mock.method(globalThis, "fetch", async () => {
  throw new Error("network access is not allowed in scam-check");
});
const httpMock = mock.method(http, "request", () => {
  throw new Error("network access is not allowed in scam-check");
});
const httpsMock = mock.method(https, "request", () => {
  throw new Error("network access is not allowed in scam-check");
});

after(() => {
  assert.equal(fetchMock.mock.callCount(), 0, "fetch was called");
  assert.equal(httpMock.mock.callCount(), 0, "http.request was called");
  assert.equal(httpsMock.mock.callCount(), 0, "https.request was called");
  mock.restoreAll();
});

// ---------------------------------------------------------------------------
// Data-driven cases from examples/scam-cases.json
// ---------------------------------------------------------------------------

describe("example cases", () => {
  for (const c of examples.cases) {
    test(`${c.kind}: ${c.id}`, async () => {
      const result = await checkInternshipRisk(c.input);
      assertWellFormed(result);
      const d = result.data;
      assert.ok(d);
      const found = codes(result);
      const ctx = `found: ${found.join(", ") || "(none)"}; assessment: ${d.assessment}`;

      if (c.expect.assessment) assert.equal(d.assessment, c.expect.assessment, ctx);
      if (c.expect.assessmentIn) assert.ok(c.expect.assessmentIn.includes(d.assessment), ctx);
      if (c.expect.status) assert.equal(result.status, c.expect.status, ctx);
      for (const code of c.expect.mustInclude ?? []) assert.ok(found.includes(code), `missing ${code}; ${ctx}`);
      for (const code of c.expect.mustNotInclude ?? []) assert.ok(!found.includes(code), `unexpected ${code}; ${ctx}`);
      for (const code of c.expect.observedCodes ?? []) {
        assert.equal(d.redFlags.find((f) => f.code === code)?.basis, "observed", `${code} should be observed`);
      }
      for (const code of c.expect.heuristicCodes ?? []) {
        assert.equal(d.redFlags.find((f) => f.code === code)?.basis, "heuristic", `${code} should be heuristic`);
      }
    });
  }

  test("covers all three kinds of listing", () => {
    const kinds = new Set(examples.cases.map((c) => c.kind));
    assert.deepEqual([...kinds].sort(), ["inconclusive", "legitimate_looking", "suspicious"]);
  });
});

// ---------------------------------------------------------------------------
// Never claims a listing is safe
// ---------------------------------------------------------------------------

describe("never claims safety", () => {
  test("no output for any example asserts that a listing is safe or legitimate", async () => {
    for (const c of examples.cases) {
      const result = await checkInternshipRisk(c.input);
      assert.deepEqual(unnegatedSafetyClaims(allText(result)), [], `case ${c.id}`);
    }
  });

  test("the claim detector itself catches a positive safety claim", () => {
    assert.deepEqual(unnegatedSafetyClaims("Checked. This listing is safe."), ["This listing is safe."]);
    assert.deepEqual(unnegatedSafetyClaims("This does not mean the listing is safe."), []);
  });

  test("a clean result carries an explicit not-a-safety-verdict warning", async () => {
    const legit = examples.cases.find((c) => c.id === "legit_company_careers_page");
    assert.ok(legit);
    const result = await checkInternshipRisk(legit.input);
    assert.equal(result.data?.assessment, "no_major_indicators_detected");
    assert.ok(result.warnings.includes(NOT_A_SAFETY_VERDICT));
    assert.match(result.data?.recommendation ?? "", /not confirmation/i);
    assert.equal(result.data?.riskLevel, "low");
  });

  test("insufficient evidence maps to riskLevel 'unknown', never 'low'", async () => {
    const result = await run({ url: "", jobDescription: "Intern needed. DM for details." });
    assert.equal(result.data?.assessment, "insufficient_evidence");
    assert.equal(result.data?.riskLevel, "unknown");
  });
});

// ---------------------------------------------------------------------------
// Text rules: negation and false-positive guards
// ---------------------------------------------------------------------------

describe("text rules", () => {
  const textCodes = (t: string) => analyzeText(t).map((i) => i.code);

  test("negated payment and credential statements are not flagged", () => {
    for (const t of [
      "We will never ask you to pay a registration fee or share your OTP.",
      "There is no registration fee.",
      "The company covers the training fee.",
      "Training fee is waived for all interns.",
      "Recruiters will not request your banking password.",
    ]) {
      const found = textCodes(t);
      assert.ok(!found.includes("fee_request") && !found.includes("credential_or_otp_request"), `${t} → ${found}`);
    }
  });

  test("negation does not leak across sentences or from unrelated 'no'", () => {
    assert.ok(textCodes("Do not miss this! Pay the registration fee of RM100 today.").includes("fee_request"));
    assert.ok(textCodes("No experience needed, you need to pay RM50 to register.").includes("payment_instruction"));
  });

  test("normal internship wording is not flagged as payment or chat interview", () => {
    const found = textCodes("Monthly allowance RM1,200. We pay RM60/day for overtime. Interviews via Microsoft Teams or Zoom.");
    assert.deepEqual(found, []);
  });

  test("passport-sized photo is not an identity-document request", () => {
    assert.deepEqual(textCodes("Attach your resume and a passport-sized photo."), []);
    assert.ok(textCodes("Please send your IC and bank statement before the interview.").includes("early_identity_document_request"));
  });

  test("Malay fee wording is detected", () => {
    assert.ok(textCodes("Sila bayar yuran pendaftaran RM100 sebelum mula.").includes("fee_request_malay"));
  });

  test("obfuscated text: full-width letters and zero-width characters", async () => {
    const result = await run({
      url: "https://example.org/jobs/1",
      jobDescription: "Please pay the ｒｅｇｉｓｔｒａｔｉｏｎ fee to start. Contact on What\u200BsApp.",
    });
    const found = codes(result);
    assert.ok(found.includes("fee_request"), found.join(","));
    assert.ok(found.includes("hidden_characters"), found.join(","));
  });

  test("observed vs heuristic basis is assigned per rule", () => {
    const flags = analyzeText("You must pay a registration fee. Urgent hiring, start today!");
    assert.equal(flags.find((f) => f.code === "fee_request")?.basis, "observed");
    assert.equal(flags.find((f) => f.code === "urgency_language")?.basis, "heuristic");
  });
});

// ---------------------------------------------------------------------------
// URL validation (parsing only)
// ---------------------------------------------------------------------------

describe("URL validation", () => {
  const urlCodes = (u: string) => analyzeUrl(u).indicators.map((i) => i.code);

  test("ordinary company and platform URLs produce no indicators", () => {
    for (const u of [
      "https://careers.acme.com.my/jobs/1",
      "https://www.linkedin.com/jobs/view/1",
      "https://my.jobstreet.com/job/1",
      "https://boards.greenhouse.io/acme/jobs/1",
      "https://grabcad.com/library",
    ]) {
      assert.deepEqual(urlCodes(u), [], u);
      assert.equal(analyzeUrl(u).analysis.valid, true, u);
    }
  });

  test("registrable domain handles multi-label suffixes and shared hosting", () => {
    assert.equal(analyzeUrl("https://careers.acme.com.my/x").analysis.registrableDomain, "acme.com.my");
    assert.equal(analyzeUrl("https://jobs.acme.co.uk/x").analysis.registrableDomain, "acme.co.uk");
    assert.equal(analyzeUrl("https://acme.github.io/x").analysis.registrableDomain, "acme.github.io");
  });

  test("missing scheme is assumed https for analysis, with a note", () => {
    const r = analyzeUrl("acme.com/jobs");
    assert.equal(r.analysis.valid, true);
    assert.equal(r.analysis.scheme, "https");
    assert.ok(r.analysis.problems.some((p) => p.includes("assumed https")));
  });

  test("dangerous schemes are observed high-severity and not treated as web URLs", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
      const r = analyzeUrl(u);
      assert.equal(r.analysis.valid, false, u);
      assert.equal(r.analysis.normalized, null, u);
      const f = r.indicators.find((i) => i.code === "dangerous_url_scheme");
      assert.equal(f?.basis, "observed", u);
      assert.equal(f?.severity, "high", u);
    }
  });

  test("credentials before @ are detected and the real host is reported", () => {
    const r = analyzeUrl("https://www.linkedin.com@jobs-portal.top/apply");
    assert.equal(r.analysis.hostname, "jobs-portal.top");
    assert.ok(urlCodes("https://www.linkedin.com@jobs-portal.top/apply").includes("url_embedded_credentials"));
    assert.ok(!(r.analysis.normalized ?? "").includes("linkedin"), "normalized URL drops the userinfo");
  });

  test("disguised and private IP hosts", () => {
    assert.ok(urlCodes("http://2130706433/").includes("obfuscated_ip_host"));
    assert.ok(urlCodes("http://0x7f.0.0.1/").includes("obfuscated_ip_host"));
    assert.ok(urlCodes("http://127.0.0.1/").includes("non_public_ip_host"));
    assert.ok(urlCodes("http://[::1]/").includes("non_public_ip_host"));
    const plain = urlCodes("http://203.0.113.5:8080/job");
    assert.ok(plain.includes("ip_address_host") && plain.includes("non_standard_port") && plain.includes("no_https"));
  });

  test("brand impersonation: substring, homoglyph, typosquat, path", () => {
    assert.ok(urlCodes("https://linkedin-careers-apply.xyz/i").includes("brand_name_in_unrelated_domain"));
    assert.ok(urlCodes("https://linkedincareers.net/").includes("brand_name_in_unrelated_domain"));
    assert.ok(urlCodes("https://linkedin.github.io/x").includes("brand_name_in_unrelated_domain"));
    assert.ok(urlCodes("https://l\u0456nkedin.com/jobs").includes("homoglyph_brand_domain"));
    assert.ok(urlCodes("https://linkedln.com/jobs").includes("typosquat_brand_domain"));
    assert.ok(urlCodes("https://micr0soft-careers.com").includes("typosquat_brand_domain"));
    assert.ok(urlCodes("https://evil.example/linkedin.com/jobs").includes("misleading_domain_in_path"));
  });

  test("hidden destinations and off-platform links", () => {
    assert.ok(urlCodes("https://bit.ly/3xyz").includes("url_shortener"));
    assert.ok(urlCodes("https://wa.me/60123456789").includes("messaging_app_link"));
    assert.ok(urlCodes("https://abc123.ngrok-free.app/apply").includes("tunnel_host"));
    assert.ok(urlCodes("https://docs.google.com/forms/d/e/x/viewform").includes("generic_form_link"));
    assert.ok(urlCodes("https://jobs.example.com/?redirect=https://evil.example").includes("redirect_parameter"));
  });

  test("malformed URLs are rejected without throwing", () => {
    for (const u of ["", "   ", "ht!tp://???", "https://exa mple.com", "https://ex\u0000ample.com", "http://", "x".repeat(5000)]) {
      const r = analyzeUrl(u);
      assert.equal(r.analysis.valid, false, JSON.stringify(u.slice(0, 30)));
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed input handling
// ---------------------------------------------------------------------------

describe("malformed input", () => {
  test("non-object input returns an error result, never throws", async () => {
    for (const bad of [null, undefined, 42, "a string", [], true]) {
      const result = await run(bad);
      assertWellFormed(result);
      assert.equal(result.status, "error");
    }
  });

  test("wrong field types are reported and analysis continues", async () => {
    const result = await run({ url: 123, jobDescription: { text: "x" } });
    assertWellFormed(result);
    assert.equal(result.status, "partial");
    assert.equal(result.data?.assessment, "insufficient_evidence");
    assert.ok(result.warnings.some((w) => w.includes('"url" must be a string')));
    assert.ok(result.warnings.some((w) => w.includes('"jobDescription" must be a string')));
  });

  test("empty object is insufficient evidence, not an error", async () => {
    const result = await run({});
    assertWellFormed(result);
    assert.equal(result.status, "partial");
    assert.equal(result.data?.assessment, "insufficient_evidence");
  });

  test("oversized description is truncated, and evidence is still found", async () => {
    const result = await run({
      url: "https://example.org/jobs",
      jobDescription: "You must pay a registration fee. " + "lorem ipsum ".repeat(10_000),
    });
    assertWellFormed(result);
    assert.equal(result.status, "partial");
    assert.ok(result.warnings.some((w) => w.includes("truncated")));
    assert.ok(codes(result).includes("fee_request"));
  });

  test("pathological inputs finish quickly (ReDoS guard)", async () => {
    const inputs = [
      "a".repeat(20_000),
      "pay ".repeat(5_000),
      "interview ".repeat(2_000) + "!",
      "registration ".repeat(1_500),
      "like like like like ".repeat(1_000),
      "RM".repeat(9_000),
      "@".repeat(20_000),
      "a@".repeat(10_000),
    ];
    const started = performance.now();
    for (const jobDescription of inputs) await run({ url: "https://example.org/" + "a".repeat(1_900), jobDescription });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_000, `took ${Math.round(elapsed)} ms`);
  });
});

// ---------------------------------------------------------------------------
// Compatibility with the shared contract used by src/index.ts
// ---------------------------------------------------------------------------

describe("shared contract", () => {
  test("accepts the server's input shape (postingText, postingUrl, companyName, recruiterContact)", async () => {
    const result = await checkInternshipRisk({
      postingText: "You need to pay a processing fee before your internship starts.",
      postingUrl: "https://acme-careers.example/jobs/1",
      companyName: "Bluewave Logistics Sdn Bhd",
      recruiterContact: "bluewave.hr.team@gmail.com",
    });
    assertWellFormed(result);
    const found = codes(result);
    assert.ok(found.includes("fee_request"), found.join(","));
    assert.ok(found.includes("free_webmail_contact"), found.join(","));
    assert.ok(found.includes("company_domain_mismatch"), found.join(","));
    assert.equal(result.data?.redFlags.find((f) => f.code === "free_webmail_contact")?.location, "recruiter_contact");
    assert.ok(result.evidence.some((e) => e.source === "recruiter_contact"));
  });

  test("company name matching the domain is not a mismatch", async () => {
    const result = await checkInternshipRisk({
      postingText: "Intern role.",
      postingUrl: "https://careers.bluewave.com.my/jobs/1",
      companyName: "Bluewave Logistics Sdn Bhd",
    });
    assert.ok(!codes(result).includes("company_domain_mismatch"));
  });

  test("evidence sources follow the shared convention", async () => {
    const result = await run({ url: "https://bit.ly/x", jobDescription: "You must pay a registration fee." });
    const sources = new Set(result.evidence.map((e) => e.source));
    assert.deepEqual([...sources].sort(), ["posting_text", "posting_url"]);
  });
});

// ---------------------------------------------------------------------------
// Integration: loaded by Developer 1's MCP server (no edits to src/index.ts)
// ---------------------------------------------------------------------------

describe("MCP integration", () => {
  let client: import("@modelcontextprotocol/sdk/client/index.js").Client | undefined;

  before(async () => {
    // The server now persists investigation results; keep them out of the repo's data/ folder.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    process.env.INTERNGUARD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ig-scam-test-"));
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createInternGuardServer, loadDependencies } = await import("../src/index.js");
    const deps = await loadDependencies();
    assert.equal(deps.sources.check_internship_risk, "module", "server loaded this module, not the stub");
    const server = createInternGuardServer(deps);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: "scam-check-test", version: "0" });
    await client.connect(clientT);
  });

  after(async () => {
    await client?.close();
  });

  test("check_internship_risk returns this module's analysis through MCP", async () => {
    assert.ok(client);
    const res = await client.callTool({
      name: "check_internship_risk",
      arguments: { postingText: "Please send us the OTP you receive to finish onboarding.", postingUrl: "https://bit.ly/x" },
    });
    assert.equal(res.isError, false);
    const sc = res.structuredContent as unknown as ToolResult<ScamRiskData>;
    assert.equal(sc.data?.assessment, "high_risk");
    assert.ok(sc.data?.redFlags.some((f) => f.code === "credential_or_otp_request"));
  });
});
