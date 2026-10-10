/**
 * Check one company against the REAL sources, without WorkBuddy or MCP.
 * OWNER: Developer 3.
 *
 *   npm run check:company -- "Malayan Banking Berhad" Malaysia
 *   npm run check:company -- "Company Name" Malaysia "registration-no"
 *
 * Uses GLEIF only; the simulated demo registry is ignored here.
 */
import { verifyCompany } from "../src/tools/company-check.js";
import { formatReport } from "../src/report/formatter.js";

const [companyName, country, registrationNumber] = process.argv.slice(2);
if (!companyName) {
  process.stderr.write('usage: npm run check:company -- "Company Name" [Country] [RegistrationNumber]\n');
  process.exit(2);
}
delete process.env.INTERNGUARD_SIMULATED_REGISTRY;
process.env.INTERNGUARD_COMPANY_SOURCES = "gleif";

const result = await verifyCompany({
  companyName,
  ...(country ? { country } : {}),
  ...(registrationNumber ? { registrationNumber } : {}),
});
process.stdout.write(formatReport("verify_company", result));
for (const e of result.evidence) process.stdout.write(`\nEvidence [${e.source}]: ${e.description}\n`);
