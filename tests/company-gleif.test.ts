/**
 * verify_company with the real GLEIF source (Developer 3).
 * fetch is mocked with responses shaped like real api.gleif.org JSON:API
 * records, so the tests run offline and deterministically.
 */
import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { countryCode, verifyCompany } from "../src/tools/company-check.js";

const record = (o: { lei: string; name: string; country: string; status?: string; reg?: string | null; regStatus?: string; other?: string[] }) => ({
  type: "lei-records",
  id: o.lei,
  attributes: {
    lei: o.lei,
    entity: {
      legalName: { name: o.name, language: "en" },
      otherNames: (o.other ?? []).map((n) => ({ name: n, language: "en", type: "PREVIOUS_LEGAL_NAME" })),
      legalAddress: { city: "Kuala Lumpur", country: o.country },
      registeredAs: o.reg ?? null,
      jurisdiction: o.country,
      status: o.status ?? "ACTIVE",
    },
    registration: { status: o.regStatus ?? "ISSUED" },
  },
});
const respond = (data: unknown[], status = 200) =>
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/vnd.api+json" } }));

afterEach(() => {
  mock.restoreAll();
  delete process.env.INTERNGUARD_COMPANY_SOURCES;
  delete process.env.INTERNGUARD_SIMULATED_REGISTRY;
});

test("GLEIF is off unless enabled: no network call, inconclusive", async () => {
  const f = respond([]);
  const r = await verifyCompany({ companyName: "Malayan Banking Berhad" });
  assert.equal(f.mock.callCount(), 0);
  assert.equal(r.data?.verificationStatus, "inconclusive");
});

test("request goes only to api.gleif.org with an encoded name and country filter", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  const f = respond([]);
  await verifyCompany({ companyName: "Acme & Sons Sdn Bhd", country: "Malaysia" });
  const url = new URL(String(f.mock.calls[0]?.arguments[0]));
  assert.equal(url.origin, "https://api.gleif.org");
  assert.equal(url.pathname, "/api/v1/lei-records");
  assert.equal(url.searchParams.get("filter[entity.legalName]"), "Acme & Sons Sdn Bhd");
  assert.equal(url.searchParams.get("filter[entity.legalAddress.country]"), "MY");
});

test("exact active match is verified, with the LEI as evidence", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  respond([
    record({ lei: "AAAA00000000000000A1", name: "MALAYAN BANKING EXPORTS", country: "MY" }),
    record({ lei: "549300MLUDYVRQOOXS22", name: "Malayan Banking Berhad", country: "MY", reg: "3813-K" }),
  ]);
  const r = await verifyCompany({ companyName: "MALAYAN BANKING BHD", country: "Malaysia" });
  assert.equal(r.data?.verificationStatus, "verified");
  assert.equal(r.data?.registrationNumber, "3813-K");
  assert.equal(r.data?.registeredCountry, "MY");
  assert.ok(r.evidence.some((e) => e.source.startsWith("GLEIF") && e.description.includes("549300MLUDYVRQOOXS22")));
  assert.ok(!r.warnings.some((w) => w.startsWith("SIMULATED")));
  assert.equal(r.status, "success");
});

test("partial name matches are NOT accepted (GLEIF search is fuzzy)", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  respond([record({ lei: "B1", name: "APPLE IMPRESSION", country: "IN" }), record({ lei: "B2", name: "APPLE FABRICS", country: "IN" })]);
  const r = await verifyCompany({ companyName: "Apple" });
  assert.equal(r.data?.verificationStatus, "inconclusive");
  assert.match(r.data?.findings.join(" ") ?? "", /NOT evidence the company does not exist/);
  assert.match(r.data?.findings.join(" ") ?? "", /Similar names in GLEIF \(not matched\): APPLE IMPRESSION/);
});

test("no result at all is inconclusive, never not_found, and points to SSM for Malaysia", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  respond([]);
  const r = await verifyCompany({ companyName: "Kedai Kopi Kecil Sdn Bhd", country: "Malaysia" });
  assert.equal(r.data?.verificationStatus, "inconclusive");
  assert.ok(r.data?.missingEvidence?.some((m) => m.includes("SSM")));
});

test("inactive entity or a different registration number is unverified", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  respond([record({ lei: "C1", name: "Old Trading Sdn Bhd", country: "MY", status: "INACTIVE" })]);
  assert.equal((await verifyCompany({ companyName: "Old Trading Sdn Bhd" })).data?.verificationStatus, "unverified");
  mock.restoreAll();
  respond([record({ lei: "C2", name: "Real Co Sdn Bhd", country: "MY", reg: "111-A" })]);
  const r = await verifyCompany({ companyName: "Real Co Sdn Bhd", registrationNumber: "999-Z" });
  assert.equal(r.data?.verificationStatus, "unverified");
  assert.match(r.data?.findings.join(" ") ?? "", /differs from the number GLEIF holds \(111-A\)/);
});

test("a lapsed LEI is noted but is not treated as fraud", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  respond([record({ lei: "D1", name: "Steady Co Sdn Bhd", country: "MY", regStatus: "LAPSED" })]);
  const r = await verifyCompany({ companyName: "Steady Co Sdn Bhd" });
  assert.equal(r.data?.verificationStatus, "verified");
  assert.match(r.data?.findings.join(" ") ?? "", /LAPSED \(not renewed\)/);
});

test("matches a previous legal name too", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  respond([record({ lei: "E1", name: "New Name Sdn Bhd", country: "MY", other: ["Old Name Sdn Bhd"] })]);
  assert.equal((await verifyCompany({ companyName: "Old Name Sdn Bhd" })).data?.verificationStatus, "verified");
});

test("network errors and HTTP errors are reported, not hidden", async () => {
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  mock.method(globalThis, "fetch", async () => {
    throw new Error("getaddrinfo ENOTFOUND api.gleif.org");
  });
  const a = await verifyCompany({ companyName: "Any Co" });
  assert.equal(a.data?.verificationStatus, "inconclusive");
  assert.equal(a.status, "partial");
  assert.match(a.warnings.join(" "), /GLEIF lookup failed \(getaddrinfo ENOTFOUND/);
  mock.restoreAll();
  respond([], 503);
  const b = await verifyCompany({ companyName: "Any Co" });
  assert.match(b.warnings.join(" "), /HTTP 503/);
});

test("simulated fixture match wins and GLEIF is not called; fixture miss falls through to GLEIF", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "ig-fx-")), "r.json");
  writeFileSync(file, JSON.stringify({ simulated: true, companies: [{ name: "Demo Co", registrationNumber: "SIM-1", country: "Malaysia", status: "active" }] }));
  process.env.INTERNGUARD_SIMULATED_REGISTRY = file;
  process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";
  const f = respond([record({ lei: "F1", name: "Real Elsewhere Sdn Bhd", country: "MY" })]);
  assert.equal((await verifyCompany({ companyName: "Demo Co" })).data?.verificationStatus, "verified");
  assert.equal(f.mock.callCount(), 0);
  const r = await verifyCompany({ companyName: "Real Elsewhere Sdn Bhd" });
  assert.equal(f.mock.callCount(), 1);
  assert.equal(r.data?.verificationStatus, "verified");
  assert.ok(!r.warnings.some((w) => w.startsWith("SIMULATED")), "a GLEIF match is not labelled SIMULATED");
});

test("country names map to ISO codes", () => {
  assert.equal(countryCode("Malaysia"), "MY");
  assert.equal(countryCode("sg"), "SG");
  assert.equal(countryCode("Atlantis"), null);
});
