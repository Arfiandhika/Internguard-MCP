/**
 * verify_company: evidence-based company verification.
 * OWNER: Developer 3.
 *
 * Sources, in order:
 *   1. SIMULATED registry fixture: only if INTERNGUARD_SIMULATED_REGISTRY is set
 *      (demo data). Matches are labelled SIMULATED.
 *   2. GLEIF LEI register (real, free, no API key): only if
 *      INTERNGUARD_COMPANY_SOURCES includes "gleif". The server calls one
 *      fixed host (api.gleif.org) with the company name as a query
 *      parameter; it never fetches a user-supplied URL.
 *   3. Consistency checks between the claimed name and website.
 *
 * Honesty rules:
 *   - A miss in either source is "inconclusive", never "not_found": the demo
 *     fixture holds only a few companies, and most small companies have no
 *     LEI. Absence from these sources is not evidence the company is fake.
 *   - GLEIF name search returns partial matches ("APPLE FABRICS" for "Apple"),
 *     so only an exact normalised name match counts as a match.
 *   - The official Malaysian register (SSM) has no free public API; the
 *     student is pointed to it as a manual check.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CompanyVerificationData, ToolResult, VerifyCompanyHandler, VerifyCompanyInput } from "../shared/types.js";

export const SIMULATED_SOURCE = "SIMULATED_REGISTRY_FIXTURE (demo data, not an official registry)";
export const GLEIF_SOURCE = "GLEIF LEI register (api.gleif.org)";
const GLEIF_ENDPOINT = "https://api.gleif.org/api/v1/lei-records";
const GLEIF_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;

type Evidence = ToolResult<CompanyVerificationData>["evidence"];
type Status = CompanyVerificationData["verificationStatus"];

const LEGAL_SUFFIXES = /\b(sdn\.?\s*bhd\.?|berhad|bhd|ltd|limited|inc|incorporated|llc|pte|plc|gmbh|corp(?:oration)?|co)\b\.?/gi;

export function normalizeCompanyName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(LEGAL_SUFFIXES, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

const COUNTRY_CODES: Record<string, string> = {
  malaysia: "MY", singapore: "SG", indonesia: "ID", philippines: "PH", thailand: "TH", vietnam: "VN", "viet nam": "VN",
  brunei: "BN", india: "IN", china: "CN", "hong kong": "HK", japan: "JP", "south korea": "KR", korea: "KR",
  australia: "AU", "new zealand": "NZ", "united kingdom": "GB", uk: "GB", "united states": "US", usa: "US",
  germany: "DE", france: "FR", netherlands: "NL", canada: "CA", "united arab emirates": "AE", uae: "AE",
};

export function countryCode(country: string | undefined): string | null {
  if (!country) return null;
  const c = country.trim();
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  return COUNTRY_CODES[c.toLowerCase()] ?? null;
}

function hostOf(website: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function enabledSources(): Set<string> {
  return new Set(
    (process.env.INTERNGUARD_COMPANY_SOURCES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** What a single source concluded. */
interface SourceOutcome {
  matched: boolean;
  status: Status;
  registrationNumber?: string | null;
  registeredCountry?: string | null;
  officialWebsite?: string | null;
  findings: string[];
  evidence: Evidence;
  warnings: string[];
  failed?: boolean;
}

// ---------------------------------------------------------------------------
// Source 1: simulated fixture (demo only)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name: string;
  registrationNumber: string;
  country: string;
  website?: string;
  status: "active" | "dissolved" | "struck_off";
}

function checkSimulatedRegistry(input: VerifyCompanyInput, file: string): SourceOutcome {
  const out: SourceOutcome = { matched: false, status: "inconclusive", findings: [], evidence: [], warnings: [] };
  let entries: RegistryEntry[];
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(file), "utf8")) as { simulated?: unknown; companies?: unknown };
    if (parsed.simulated !== true || !Array.isArray(parsed.companies)) throw new Error('fixture must contain "simulated": true and a "companies" array');
    entries = parsed.companies as RegistryEntry[];
  } catch (err) {
    out.failed = true;
    out.warnings.push(`Simulated registry could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  const name = normalizeCompanyName(input.companyName);
  const match =
    entries.find((e) => normalizeCompanyName(e.name) === name) ??
    (input.registrationNumber ? entries.find((e) => e.registrationNumber.toLowerCase() === input.registrationNumber?.trim().toLowerCase()) : undefined);
  if (!match) {
    out.findings.push(`Not in the simulated demo registry (which holds only ${entries.length} fictional companies).`);
    return out;
  }
  out.matched = true;
  out.registrationNumber = match.registrationNumber;
  out.registeredCountry = match.country;
  out.officialWebsite = match.website ?? null;
  out.warnings.push("SIMULATED: this registry result comes from a local demo fixture, not an official business registry.");
  out.evidence.push({ source: SIMULATED_SOURCE, description: `Entry "${match.name}" (${match.registrationNumber}, ${match.country}), status ${match.status}.` });
  const numberConflict = input.registrationNumber && match.registrationNumber.toLowerCase() !== input.registrationNumber.trim().toLowerCase();
  if (match.status !== "active") {
    out.status = "unverified";
    out.findings.push(`Registry entry status is "${match.status}", not active.`);
  } else if (numberConflict) {
    out.status = "unverified";
    out.findings.push(`The registration number given (${input.registrationNumber}) differs from the registry entry (${match.registrationNumber}).`);
  } else {
    out.status = "verified";
    out.findings.push("Matched an active entry in the SIMULATED registry fixture.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 2: GLEIF (real data)
// ---------------------------------------------------------------------------

interface GleifRecord {
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      otherNames?: Array<{ name?: string }>;
      legalAddress?: { country?: string; city?: string };
      registeredAs?: string | null;
      jurisdiction?: string | null;
      status?: string;
    };
    registration?: { status?: string };
  };
}

export async function checkGleif(input: VerifyCompanyInput): Promise<SourceOutcome> {
  const out: SourceOutcome = { matched: false, status: "inconclusive", findings: [], evidence: [], warnings: [] };
  const params = new URLSearchParams();
  params.set("filter[entity.legalName]", input.companyName.trim().slice(0, 200));
  const cc = countryCode(input.country);
  if (cc) params.set("filter[entity.legalAddress.country]", cc);
  params.set("page[size]", "50");
  const url = `${GLEIF_ENDPOINT}?${params.toString()}`;

  let records: GleifRecord[];
  try {
    const res = await fetch(url, { headers: { accept: "application/vnd.api+json" }, signal: AbortSignal.timeout(GLEIF_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("response too large");
    const body = JSON.parse(text) as { data?: unknown };
    records = Array.isArray(body.data) ? (body.data as GleifRecord[]) : [];
  } catch (err) {
    out.failed = true;
    out.warnings.push(`GLEIF lookup failed (${err instanceof Error ? err.message : String(err)}); company registration could not be checked online.`);
    return out;
  }

  const target = normalizeCompanyName(input.companyName);
  const nameOf = (r: GleifRecord) => r.attributes?.entity?.legalName?.name ?? "";
  const exact = records.filter((r) => {
    const names = [nameOf(r), ...(r.attributes?.entity?.otherNames ?? []).map((n) => n.name ?? "")];
    return names.some((n) => n && normalizeCompanyName(n) === target);
  });

  if (exact.length === 0) {
    out.findings.push(
      `No exact match in the GLEIF LEI register${cc ? ` for ${cc}` : ""}. Most small companies have no LEI, so this is NOT evidence the company does not exist.`,
    );
    const similar = [...new Set(records.map(nameOf).filter(Boolean))].slice(0, 3);
    if (similar.length > 0) out.findings.push(`Similar names in GLEIF (not matched): ${similar.join("; ")}.`);
    out.evidence.push({ source: GLEIF_SOURCE, description: `Searched legal names${cc ? ` in ${cc}` : ""}: ${records.length} partial result(s), no exact match.` });
    return out;
  }

  // Prefer an active entity; then one whose registration number matches.
  const wantedNo = input.registrationNumber?.trim().toLowerCase();
  const pick =
    exact.find((r) => wantedNo && r.attributes?.entity?.registeredAs?.toLowerCase() === wantedNo) ??
    exact.find((r) => r.attributes?.entity?.status === "ACTIVE") ??
    exact[0];
  const a = pick?.attributes;
  const e = a?.entity;
  const lei = a?.lei ?? "?";
  out.matched = true;
  out.registrationNumber = e?.registeredAs ?? null;
  out.registeredCountry = e?.legalAddress?.country ?? e?.jurisdiction ?? null;
  out.evidence.push({
    source: GLEIF_SOURCE,
    description: `LEI ${lei}: "${nameOf(pick as GleifRecord)}", ${e?.legalAddress?.city ? `${e.legalAddress.city}, ` : ""}${out.registeredCountry ?? "?"}; entity status ${e?.status ?? "?"}; LEI registration ${a?.registration?.status ?? "?"}. Record: https://search.gleif.org/#/record/${lei}`,
  });
  if (exact.length > 1) out.findings.push(`${exact.length} GLEIF entities share this exact name; the best match was used. Confirm with the registration number.`);

  if (e?.status !== "ACTIVE") {
    out.status = "unverified";
    out.findings.push(`GLEIF lists this legal entity as ${e?.status ?? "unknown status"}, not ACTIVE.`);
  } else if (wantedNo && e.registeredAs && e.registeredAs.toLowerCase() !== wantedNo) {
    out.status = "unverified";
    out.findings.push(`The registration number given (${input.registrationNumber}) differs from the number GLEIF holds (${e.registeredAs}).`);
  } else {
    out.status = "verified";
    out.findings.push(`Matched an ACTIVE legal entity in the GLEIF LEI register (LEI ${lei}).`);
  }
  if (a?.registration?.status && a.registration.status !== "ISSUED") {
    out.findings.push(`Its LEI registration is ${a.registration.status} (not renewed). This alone is not a sign of fraud.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const verifyCompany: VerifyCompanyHandler = async (input: VerifyCompanyInput) => {
  if (typeof input?.companyName !== "string" || input.companyName.trim().length === 0) {
    return { status: "error", data: null, evidence: [], warnings: ["companyName is required."] };
  }
  const name = input.companyName.trim();
  const warnings: string[] = [];
  const evidence: Evidence = [];
  const findings: string[] = [];
  const missingEvidence: string[] = [];
  let status: Status = "inconclusive";
  let registrationNumber: string | null = null;
  let registeredCountry: string | null = null;
  let officialWebsite: string | null = null;
  let anySourceRan = false;
  let anySourceFailed = false;

  const outcomes: SourceOutcome[] = [];
  const fixture = process.env.INTERNGUARD_SIMULATED_REGISTRY;
  if (fixture) outcomes.push(checkSimulatedRegistry({ ...input, companyName: name }, fixture));
  if (!outcomes.some((o) => o.matched) && enabledSources().has("gleif")) outcomes.push(await checkGleif({ ...input, companyName: name }));

  for (const o of outcomes) {
    anySourceRan = anySourceRan || !o.failed;
    anySourceFailed = anySourceFailed || o.failed === true;
    findings.push(...o.findings);
    evidence.push(...o.evidence);
    warnings.push(...o.warnings);
    if (o.matched) {
      status = o.status;
      registrationNumber = o.registrationNumber ?? null;
      registeredCountry = o.registeredCountry ?? null;
      officialWebsite = o.officialWebsite ?? null;
    }
  }
  if (outcomes.length === 0) {
    findings.push("No company registry source is enabled, so registration could not be checked.");
  }

  // Website consistency
  const claimedHost = input.website ? hostOf(input.website) : null;
  if (!input.website) missingEvidence.push("The company's official website.");
  else if (!claimedHost) findings.push(`The website "${input.website}" is not a valid address.`);
  else {
    const registryHost = officialWebsite ? hostOf(officialWebsite) : null;
    if (registryHost && claimedHost !== registryHost && !claimedHost.endsWith(`.${registryHost}`)) {
      if (status === "verified") status = "unverified";
      findings.push(`The website given (${claimedHost}) differs from the registry's website (${registryHost}).`);
    } else if (registryHost) {
      findings.push(`The website given matches the registry's website (${registryHost}).`);
    }
    const tokens = normalizeCompanyName(name).split(" ").filter((t) => t.length >= 3);
    if (tokens.length > 0 && !tokens.some((t) => claimedHost.includes(t))) {
      findings.push(`The website domain (${claimedHost}) does not contain the company name; this can be normal, but confirm it is the company's own site.`);
    }
  }

  if (status !== "verified") {
    const cc = countryCode(input.country ?? registeredCountry ?? undefined);
    if (cc === "MY") {
      missingEvidence.push(
        "Check the company in the official SSM register (SSM e-Info, MyDATA SSM or SSM Search; paid, account required) using its registration number.",
      );
    } else {
      missingEvidence.push(`A record from the official business registry${input.country ? ` of ${input.country}` : ""}.`);
    }
  }
  missingEvidence.push("Independent confirmation of the role through the company's official careers page or HR contact.");

  return {
    status: anySourceRan && !anySourceFailed ? "success" : "partial",
    data: { companyName: name, verificationStatus: status, registrationNumber, registeredCountry, officialWebsite, findings, missingEvidence },
    evidence,
    warnings,
  };
};
