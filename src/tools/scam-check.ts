/**
 * InternGuard: scam detection and URL analysis for `check_internship_risk`.
 *
 * OWNER: Developer 2 (Scam Detection & URL Analysis).
 * Loaded automatically by src/index.ts (export name `checkInternshipRisk`).
 *
 * WHAT THIS MODULE DOES
 *   Static, offline analysis of a job description and a listing URL using
 *   pattern rules. It never touches the network: no fetch, no DNS lookup, no
 *   reputation or blocklist query. The URL is parsed as text with the WHATWG
 *   URL parser built into Node.
 *
 * WHAT THIS MODULE DOES NOT DO (and must never claim to do)
 *   - It does not verify that a company exists (that is verify_company).
 *   - It does not consult any reputation database.
 *   - It cannot conclude that a listing is safe. "No indicators detected"
 *     only means these rules did not match the text provided.
 *
 * OBSERVED vs HEURISTIC
 *   Every indicator carries the excerpt of input that triggered it, plus:
 *   - basis "observed":  the input itself directly shows a known scam
 *     behaviour (it asks for a fee, an OTP or banking login, or the URL is
 *     structured to disguise its real destination). No inference is needed.
 *   - basis "heuristic": a pattern statistically associated with scams that
 *     also has innocent explanations (urgency, high pay, free webmail,
 *     URL shorteners, brand names in unrelated domains, and so on).
 *
 * SECURITY NOTES
 *   - Inputs are length-capped before analysis; all regular expressions use
 *     bounded quantifiers and are never built from user input (ReDoS).
 *   - Excerpts in the output are untrusted user content. Downstream code must
 *     treat them as data, not instructions.
 *
 * REMOTE FETCHING: deliberately NOT implemented. If page fetching is ever
 * wanted, it must stay behind a disabled-by-default flag until a security
 * review covers the SSRF controls below:
 *   1. http/https only, ports 80/443 only, URL credentials rejected.
 *   2. Resolve DNS once (all addresses); reject loopback, private, link-local
 *      (incl. 169.254.169.254 metadata), CGNAT, multicast, reserved and
 *      IPv4-mapped IPv6 forms of these, using net.BlockList.
 *   3. Connect to the vetted IP itself (custom `lookup` on the agent) to
 *      defeat DNS rebinding; send the original Host header / SNI.
 *   4. Follow redirects manually (max 3), re-running checks 1–3 on each hop.
 *   5. Hard limits: 5 s total timeout, 1 MB body, text/html only, no cookies,
 *      no auth headers, no JavaScript execution.
 *   6. Run in an egress-restricted sandbox/process with per-user rate limits
 *      and audit logging.
 */

import { BlockList, isIP } from "node:net";
import { domainToUnicode } from "node:url";
import type {
  CheckInternshipRiskHandler,
  CheckInternshipRiskInput,
  InternshipRiskData,
  RedFlag,
  RiskLevel,
  Severity,
  ToolResult,
} from "../shared/types.js";

// ===========================================================================
// Types (exported for Developer 1, Developer 4 and tests)
// ===========================================================================

export const SCAM_CHECK_VERSION = "scam-check/1.0.0";

/** Input shape requested in Developer 2's spec. */
export interface ScamCheckInput {
  url: string;
  jobDescription: string;
}

/**
 * Accepted by checkInternshipRisk: the Developer 2 spec shape, or the shared
 * shape that src/index.ts actually passes (postingText, postingUrl, ...).
 * Malformed values are also handled at runtime; the function never throws.
 */
export type ScamCheckRequest = ScamCheckInput | CheckInternshipRiskInput;

export type ScamAssessment =
  | "high_risk"
  | "medium_risk"
  /** Enough information was analysed and no strong signals matched. NOT a safety verdict. */
  | "no_major_indicators_detected"
  /** Too little information to assess; nothing strong was found either. */
  | "insufficient_evidence";

export type EvidenceBasis = "observed" | "heuristic";

export type IndicatorCategory =
  | "upfront_payment"
  | "credential_request"
  | "account_misuse"
  | "personal_data_request"
  | "pressure_tactic"
  | "unrealistic_promise"
  | "off_platform_contact"
  | "url_structure"
  | "domain_mismatch"
  | "text_obfuscation";

export type InputLocation = "job_description" | "url" | "recruiter_contact" | "company_name";

export interface ScamIndicator extends RedFlag {
  category: IndicatorCategory;
  basis: EvidenceBasis;
  location: InputLocation;
  /** Excerpt of the input that triggered this indicator (untrusted user content). */
  matchedText: string;
  /** How many times this rule matched. */
  occurrences: number;
}

export type PlatformKind =
  | "job_board"
  | "applicant_tracking_system"
  | "form_builder"
  | "url_shortener"
  | "messaging_app"
  | "free_hosting"
  | "tunnel_service";

export interface KnownPlatform {
  name: string;
  kind: PlatformKind;
}

export interface UrlAnalysis {
  provided: boolean;
  /** Parsed successfully as an http(s) URL with a usable hostname. */
  valid: boolean;
  /** Reconstructed URL without any embedded credentials; null if not a web URL. */
  normalized: string | null;
  scheme: string | null;
  hostname: string | null;
  /** Approximate registrable domain (no Public Suffix List; see limitations). */
  registrableDomain: string | null;
  isIpAddress: boolean;
  isInternationalized: boolean;
  knownPlatform: KnownPlatform | null;
  problems: string[];
}

export interface InformationSufficiency {
  sufficient: boolean;
  wordCount: number;
  /** Kinds of information a genuine listing normally contains that were not found. */
  missing: string[];
}

/** Extends the shared InternshipRiskData, so it is assignable to it. */
export interface ScamRiskData extends InternshipRiskData {
  assessment: ScamAssessment;
  redFlags: ScamIndicator[];
  observedCount: number;
  heuristicCount: number;
  url: UrlAnalysis;
  information: InformationSufficiency;
  /** What this analysis did not check. Always present; surface it to the user. */
  limitations: string[];
  analyzerVersion: string;
}

// ===========================================================================
// Limits and fixed wording
// ===========================================================================

const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_URL_CHARS = 2_048;
const MAX_SHORT_FIELD_CHARS = 300;
const MAX_MATCHES_PER_RULE = 20;
const EXCERPT_RADIUS = 50;

export const NOT_A_SAFETY_VERDICT =
  "The absence of detected indicators does not mean this listing is safe or legitimate.";

const BASE_LIMITATIONS: readonly string[] = [
  "The URL was analysed as text only. The page was not fetched, so its content, redirects and hosting were not inspected.",
  "No domain reputation, blocklist, WHOIS or domain-age lookup was performed.",
  "The company's existence and registration were not verified (use verify_company).",
  "Pattern rules can miss scams written in unexpected wording or other languages, and can flag legitimate listings.",
  NOT_A_SAFETY_VERDICT,
];

const RECOMMENDATIONS: Record<ScamAssessment, string> = {
  high_risk:
    "Strong scam indicators were found. Do not pay any fee, share passwords, OTPs or banking details, or move to a private chat. Verify the company through its official channels and report the listing to the platform.",
  medium_risk:
    "Some warning signs were found. Verify the company independently (official website and business registry) and confirm the role through official contact details before sharing personal information or documents.",
  no_major_indicators_detected:
    "No major scam indicators were detected in the information provided, but this is not confirmation that the listing is safe or legitimate. Verify the company independently, and never pay to get a job or share passwords or OTPs.",
  insufficient_evidence:
    "There is not enough information to assess this listing. Ask for the full job description, the company's official website and a company email address, and verify the company before proceeding.",
};

// ===========================================================================
// Reference data (static, offline; not a reputation database)
// ===========================================================================

/** Multi-label public suffixes and shared-hosting suffixes for approximate registrable-domain extraction. */
const MULTI_LABEL_SUFFIXES = new Set([
  "com.my", "net.my", "org.my", "edu.my", "gov.my", "name.my",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.sg", "edu.sg", "gov.sg", "org.sg", "net.sg",
  "co.id", "or.id", "ac.id", "go.id", "web.id",
  "com.ph", "edu.ph", "gov.ph", "co.in", "net.in", "org.in", "ac.in",
  "co.jp", "ne.jp", "ac.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn",
  "com.hk", "org.hk", "com.tw", "org.tw", "co.nz", "org.nz", "com.br", "co.za",
  "com.vn", "edu.vn", "co.th", "in.th", "ac.th", "com.mx", "com.tr", "com.pk", "com.bd",
  // shared hosting: each subdomain belongs to a different owner
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "web.app", "firebaseapp.com",
  "pages.dev", "workers.dev", "herokuapp.com", "azurewebsites.net", "appspot.com",
  "blogspot.com", "wixsite.com", "weebly.com", "wordpress.com", "carrd.co", "glitch.me",
  "myshopify.com", "s3.amazonaws.com", "cloudfront.net", "ngrok.io", "ngrok-free.app",
  "ngrok.app", "trycloudflare.com", "loca.lt", "repl.co",
]);

const PLATFORMS: ReadonlyArray<{ domains: string[]; name: string; kind: PlatformKind }> = [
  { name: "LinkedIn", kind: "job_board", domains: ["linkedin.com", "lnkd.in"] },
  { name: "Indeed", kind: "job_board", domains: ["indeed.com", "indeed.com.my", "indeed.com.sg", "indeed.co.uk", "indeed.co.in", "indeed.com.au", "indeed.ca"] },
  { name: "JobStreet", kind: "job_board", domains: ["jobstreet.com", "jobstreet.com.my", "jobstreet.com.sg", "jobstreet.com.ph", "jobstreet.co.id"] },
  { name: "Glassdoor", kind: "job_board", domains: ["glassdoor.com", "glassdoor.co.uk", "glassdoor.sg", "glassdoor.com.au", "glassdoor.ca"] },
  { name: "JobsDB", kind: "job_board", domains: ["jobsdb.com"] },
  { name: "Hiredly", kind: "job_board", domains: ["hiredly.com"] },
  { name: "Handshake", kind: "job_board", domains: ["joinhandshake.com"] },
  { name: "Wellfound", kind: "job_board", domains: ["wellfound.com"] },
  { name: "Prosple", kind: "job_board", domains: ["prosple.com"] },
  { name: "Greenhouse", kind: "applicant_tracking_system", domains: ["greenhouse.io"] },
  { name: "Lever", kind: "applicant_tracking_system", domains: ["lever.co"] },
  { name: "Workday", kind: "applicant_tracking_system", domains: ["myworkdayjobs.com", "workday.com"] },
  { name: "Workable", kind: "applicant_tracking_system", domains: ["workable.com"] },
  { name: "SmartRecruiters", kind: "applicant_tracking_system", domains: ["smartrecruiters.com"] },
  { name: "Ashby", kind: "applicant_tracking_system", domains: ["ashbyhq.com"] },
  { name: "BambooHR", kind: "applicant_tracking_system", domains: ["bamboohr.com"] },
  { name: "iCIMS", kind: "applicant_tracking_system", domains: ["icims.com"] },
  { name: "SAP SuccessFactors", kind: "applicant_tracking_system", domains: ["successfactors.com", "successfactors.eu"] },
  { name: "Taleo", kind: "applicant_tracking_system", domains: ["taleo.net"] },
  { name: "Recruitee", kind: "applicant_tracking_system", domains: ["recruitee.com"] },
  { name: "Teamtailor", kind: "applicant_tracking_system", domains: ["teamtailor.com"] },
  { name: "Personio", kind: "applicant_tracking_system", domains: ["personio.de", "personio.com"] },
  { name: "Google Forms", kind: "form_builder", domains: ["forms.gle"] },
  { name: "Microsoft Forms", kind: "form_builder", domains: ["forms.office.com"] },
  { name: "Typeform", kind: "form_builder", domains: ["typeform.com"] },
  { name: "Jotform", kind: "form_builder", domains: ["jotform.com"] },
  { name: "Tally", kind: "form_builder", domains: ["tally.so"] },
  { name: "SurveyMonkey", kind: "form_builder", domains: ["surveymonkey.com"] },
  { name: "URL shortener", kind: "url_shortener", domains: ["bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at", "s.id", "rb.gy", "tiny.cc", "v.gd", "t.ly", "shorte.st", "adf.ly"] },
  { name: "WhatsApp", kind: "messaging_app", domains: ["wa.me", "whatsapp.com"] },
  { name: "Telegram", kind: "messaging_app", domains: ["t.me", "telegram.me", "telegram.org"] },
  { name: "LINE", kind: "messaging_app", domains: ["line.me"] },
  { name: "free website host", kind: "free_hosting", domains: ["github.io", "gitlab.io", "netlify.app", "vercel.app", "web.app", "firebaseapp.com", "pages.dev", "workers.dev", "herokuapp.com", "blogspot.com", "wixsite.com", "weebly.com", "wordpress.com", "carrd.co", "glitch.me", "linktr.ee", "repl.co", "sites.google.com"] },
  { name: "temporary tunnel", kind: "tunnel_service", domains: ["ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "loca.lt"] },
];

/** Brands commonly impersonated in job scams, with their official registrable domains. */
const BRANDS: ReadonlyArray<{ token: string; official: string[] }> = [
  { token: "linkedin", official: ["linkedin.com", "lnkd.in"] },
  { token: "indeed", official: ["indeed.com", "indeed.com.my", "indeed.com.sg", "indeed.co.uk", "indeed.co.in", "indeed.com.au", "indeed.ca"] },
  { token: "jobstreet", official: ["jobstreet.com", "jobstreet.com.my", "jobstreet.com.sg", "jobstreet.com.ph", "jobstreet.co.id"] },
  { token: "glassdoor", official: ["glassdoor.com", "glassdoor.co.uk", "glassdoor.sg", "glassdoor.com.au", "glassdoor.ca"] },
  { token: "jobsdb", official: ["jobsdb.com"] },
  { token: "google", official: ["google.com", "google.com.my", "google.com.sg", "withgoogle.com"] },
  { token: "microsoft", official: ["microsoft.com"] },
  { token: "amazon", official: ["amazon.com", "amazon.jobs", "amazon.co.uk", "amazon.sg"] },
  { token: "apple", official: ["apple.com"] },
  { token: "meta", official: ["meta.com", "metacareers.com"] },
  { token: "facebook", official: ["facebook.com", "fb.com"] },
  { token: "tiktok", official: ["tiktok.com", "lifeattiktok.com"] },
  { token: "bytedance", official: ["bytedance.com"] },
  { token: "shopee", official: ["shopee.com", "shopee.com.my", "shopee.sg", "shopee.co.id", "shopee.ph"] },
  { token: "lazada", official: ["lazada.com", "lazada.com.my", "lazada.sg"] },
  { token: "grab", official: ["grab.com", "grab.careers"] },
  { token: "petronas", official: ["petronas.com"] },
  { token: "maybank", official: ["maybank.com", "maybank2u.com.my"] },
  { token: "deloitte", official: ["deloitte.com"] },
  { token: "pwc", official: ["pwc.com"] },
  { token: "kpmg", official: ["kpmg.com"] },
  { token: "accenture", official: ["accenture.com"] },
];

const FREE_WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.com.my", "yahoo.co.uk", "ymail.com",
  "hotmail.com", "hotmail.my", "outlook.com", "outlook.my", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com",
  "yandex.com", "zoho.com", "qq.com", "163.com", "126.com",
]);

/** TLDs frequently abused in phishing (low-weight heuristic only). */
const SUSPICIOUS_TLDS = new Set([
  "xyz", "top", "click", "loan", "work", "icu", "buzz", "rest", "cfd", "sbs", "cyou",
  "monster", "quest", "bond", "zip", "mov", "gq", "ml", "cf", "tk", "ga", "country", "support",
]);

const REDIRECT_PARAMS = new Set([
  "url", "redirect", "redirect_url", "redirect_uri", "next", "target", "dest",
  "destination", "goto", "return", "returnurl", "return_url", "u", "r", "link",
]);

const PHISHING_HOST_WORDS = ["login", "signin", "verify", "verification", "secure", "account", "wallet", "payment", "update", "confirm"];

const NON_PUBLIC_RANGES = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  return list;
})();

// ===========================================================================
// Text rules
// ===========================================================================

interface TextRule {
  code: string;
  category: IndicatorCategory;
  severity: Severity;
  basis: EvidenceBasis;
  description: string;
  /** Must use the g flag and bounded quantifiers only. */
  pattern: RegExp;
  /** Skip matches preceded by a negation ("we never ask for...", "no registration fee"). */
  negatable?: boolean;
}

const MSG_APP = String.raw`(?:whats\s?app|whatsap|watsapp|wasap|telegram|telegrm|wechat|signal|line app|line id|kik|viber)`;
const CREDENTIAL = String.raw`(?:otp|one[- ]time (?:password|pin|code)|verification code|tac(?: code| number)?|6[- ]digit code|security code|2fa code|authenticat(?:ion|or) code|pin(?: number| code)?|passwords?|log ?in (?:details|credentials)|banking (?:login|credentials|password|username|details)|online banking|internet banking|cvv|cvc|card (?:number|details|pin))`;

const TEXT_RULES: readonly TextRule[] = [
  // ---- upfront payment (observed) ----
  {
    code: "fee_request",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Mentions a fee for registration, training, placement or similar. Genuine employers do not charge applicants to get a job or internship.",
    pattern: /\b(?:registration|application|processing|admin(?:istration|istrative)?|training|onboarding|enrol?ment|placement|joining|activation|membership|certification|verification|background[- ]check|visa processing|interview|starter kit|uniform)\s+(?:fees?|charges?|costs?|payments?)\b/gi,
  },
  {
    code: "deposit_request",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Mentions a deposit or advance payment from the applicant.",
    pattern: /\b(?:refundable|security|safety|upfront|up-front|advance|good[- ]faith|commitment)\s+(?:deposits?|payments?|fees?)\b/gi,
  },
  {
    code: "payment_instruction",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Instructs the applicant to pay, transfer or top up money.",
    pattern: /\b(?:you(?:'ll| will)?\s+(?:need|have|are required)\s+to|you must|must|required to|need to|have to|kindly|please)\s+(?:first\s+)?(?:pay|transfer|send money|deposit|top[- ]?up|make (?:a|the) payment)\b/gi,
  },
  {
    code: "purchase_requirement",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Requires the applicant to buy equipment, materials or a package.",
    pattern: /\b(?:must|required to|need to|have to|you will)\s+(?:buy|purchase)\b|\b(?:buy|purchase)\s+(?:the|a|our)\s+(?:starter kit|kit|package|training materials?|course|license|licence)\s+(?:from us|through us|from our)\b/gi,
  },
  {
    code: "untraceable_payment_method",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Asks for payment by gift card, cryptocurrency or wire service, which are hard to trace or reverse.",
    pattern: /\b(?:pay|payment|paid|send|transfer|deposit)\w{0,4}\s+(?:\w+\s+){0,4}?(?:via|in|with|using|through|by)\s+(?:gift\s?cards?|itunes|google play|steam|bitcoin|btc|usdt|crypto\w{0,8}|western union|moneygram)\b/gi,
  },
  {
    code: "overpayment_refund_request",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    description: "Describes depositing a cheque or payment and sending part of it back: a common fake-cheque scam.",
    pattern: /\b(?:cheque|money order)\b[^.!?\n]{0,100}\b(?:send|wire|transfer|return)\s+(?:back|the (?:remaining|difference|balance|excess|rest))\b/gi,
  },
  {
    code: "fee_request_malay",
    category: "upfront_payment",
    severity: "high",
    basis: "observed",
    description: "Mentions a registration, processing, training or advance fee (Malay wording).",
    pattern: /\b(?:yuran|bayaran)\s+(?:pendaftaran|pemprosesan|proses|latihan|pendahuluan|deposit)\b/gi,
  },

  // ---- credentials and account misuse (observed) ----
  {
    code: "credential_or_otp_request",
    category: "credential_request",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Asks the applicant to share a password, OTP/verification code, PIN or banking login. No genuine employer needs these.",
    pattern: new RegExp(String.raw`\b(?:send|share|give|provide|forward|tell|submit|reply with|read out|screenshot|key in|need|require|ask for|request)\b[^.!?\n]{0,60}\b${CREDENTIAL}\b`, "gi"),
  },
  {
    code: "bank_account_use_request",
    category: "account_misuse",
    severity: "high",
    basis: "observed",
    negatable: true,
    description: "Asks the applicant to use, open or lend a bank account or e-wallet to receive or move money. This is how money-mule schemes recruit students.",
    pattern: /\b(?:use|lend|rent|borrow|open|register)\s+(?:your|a new|a)\s+(?:own\s+)?(?:personal\s+)?(?:bank account|bank card|atm card|e-?wallet|account)\b[^.!?\n]{0,60}\b(?:receive|transfer|process|move|collect|forward)\w{0,3}\b|\b(?:receive|process|handle|collect)\s+(?:client\s+|customer\s+|company\s+)?(?:payments|funds|transfers|money)\s+(?:into|through|via|using)\s+your\s+(?:own\s+|personal\s+)?(?:bank\s+)?account\b/gi,
  },

  // ---- personal data (heuristic) ----
  {
    code: "early_identity_document_request",
    category: "personal_data_request",
    severity: "medium",
    basis: "heuristic",
    negatable: true,
    description: "Asks for identity or bank documents. This is normal after a formal offer, but a warning sign before any interview.",
    pattern: /\b(?:send|provide|submit|upload|share|whatsapp|attach)\b[^.!?\n]{0,50}\b(?:ic|nric|mykad|passport(?![- ]?(?:sized?|photo))|identity card|id card|ssn|social security(?: number)?|bank (?:account|statement)s?|bank details|birth certificate)\b/gi,
  },

  // ---- pressure tactics (heuristic) ----
  {
    code: "deadline_pressure",
    category: "pressure_tactic",
    severity: "medium",
    basis: "heuristic",
    description: "Uses short deadlines or 'act now' pressure to rush the applicant.",
    pattern: /\b(?:within|in the next)\s+\d{1,3}\s*(?:hours?|hrs?|minutes?|mins?)\b|\b(?:today only|act now|reply (?:now|immediately|asap)|respond immediately|offer (?:expires|valid) (?:today|tonight|in)|last chance|don'?t miss (?:out|this)|before (?:it'?s too late|slots? run out))\b/gi,
  },
  {
    code: "scarcity_pressure",
    category: "pressure_tactic",
    severity: "medium",
    basis: "heuristic",
    description: "Claims very limited slots to create urgency.",
    pattern: /\b(?:only|just)\s+\d{1,3}\s+(?:slots?|seats?|spots?|places?|positions?|vacanc(?:y|ies))\s+(?:left|remaining|available)\b|\blimited\s+(?:slots?|seats?|spots?)\b|\bfirst come,? first serve[ds]?\b/gi,
  },
  {
    code: "secrecy_request",
    category: "pressure_tactic",
    severity: "medium",
    basis: "heuristic",
    description: "Asks the applicant to keep the offer secret.",
    pattern: /\b(?:keep (?:this|it) (?:confidential|secret|private|between us)|don'?t tell (?:anyone|your)|do not (?:tell|inform) (?:anyone|your))\b/gi,
  },
  {
    code: "urgency_language",
    category: "pressure_tactic",
    severity: "low",
    basis: "heuristic",
    description: "Uses urgent-hiring language. Common in genuine listings too.",
    pattern: /\b(?:urgent(?:ly)?\s+(?:hiring|needed|required|vacancy|vacancies)|hiring immediately|immediate(?:ly)?\s+(?:start|hiring|join)|start (?:today|immediately|tomorrow))\b/gi,
  },

  // ---- unrealistic promises (heuristic) ----
  {
    code: "task_scam_pattern",
    category: "unrealistic_promise",
    severity: "high",
    basis: "heuristic",
    description: "Describes being paid to like, review, rate or 'boost' items, or to complete tasks: the pattern of task scams that later demand deposits.",
    pattern: /\b(?:like|rate|review|boost|click|watch|follow)\w{0,4}\s+(?:\w+\s+){0,2}?(?:products?|videos?|ads|apps?|hotels?|movies?|posts?|orders?|ratings?)\b[^.!?\n]{0,60}\b(?:earn|commissions?|paid|income|rm|usd)\b|\b(?:task[- ]based|daily tasks?|complete tasks?|order (?:grabbing|boosting)|prepaid tasks?)\b[^.!?\n]{0,60}\b(?:earn|commissions?|paid|income)\b/gi,
  },
  {
    code: "guaranteed_outcome",
    category: "unrealistic_promise",
    severity: "medium",
    basis: "heuristic",
    description: "Guarantees income, a job or a placement.",
    pattern: /\bguarantee[ds]?\s+(?:\w+\s+){0,2}?(?:income|earnings|salary|job|placement|offer|employment|returns?|profits?|commissions?|pay)\b/gi,
  },
  {
    code: "no_interview_hiring",
    category: "unrealistic_promise",
    severity: "medium",
    basis: "heuristic",
    description: "Offers hiring without an interview.",
    pattern: /\b(?:no interviews?(?: required| needed)?|without (?:an )?interview|hired (?:on the spot|instantly|immediately)|instant (?:hire|hiring|approval|offer))\b/gi,
  },
  {
    code: "easy_money_language",
    category: "unrealistic_promise",
    severity: "medium",
    basis: "heuristic",
    description: "Uses easy-money or get-rich language.",
    pattern: /\b(?:easy money|quick money|fast cash|passive income|earn (?:big|fast|quick|extra) (?:money|cash)|unlimited (?:income|earnings|earning potential)|be your own boss|financial freedom|get rich)\b/gi,
  },
  {
    code: "recruitment_scheme",
    category: "unrealistic_promise",
    severity: "medium",
    basis: "heuristic",
    description: "Pays for recruiting others, a sign of a pyramid or multi-level marketing scheme.",
    pattern: /\b(?:recruit|invite|refer|bring in)\s+(?:\d{1,3}\s+|your\s+|more\s+)?(?:friends|family|members|people|others)\b[^.!?\n]{0,60}\b(?:earn|commissions?|bonus|unlock|upgrade)\b|\b(?:downline|upline|multi[- ]level marketing|mlm|pyramid scheme)\b/gi,
  },
  {
    code: "no_experience_needed",
    category: "unrealistic_promise",
    severity: "low",
    basis: "heuristic",
    description: "States that no experience is needed. Normal for internships; weak signal on its own.",
    pattern: /\bno (?:experience|qualifications?|skills?)\s+(?:is\s+)?(?:needed|required|necessary)\b/gi,
  },

  // ---- off-platform contact (heuristic) ----
  {
    code: "chat_based_interview",
    category: "off_platform_contact",
    severity: "high",
    basis: "heuristic",
    description: "Holds the interview, onboarding or training over a chat app or text. Text-only 'interviews' are a hallmark of recruitment scams.",
    pattern: new RegExp(String.raw`\b(?:interview(?:s|ed)?|onboarding|training|orientation)\b[^.!?\n]{0,40}\b(?:via|on|over|through|using)\s+(?:${MSG_APP}|text(?: messages?)?|chat|sms)\b`, "gi"),
  },
  {
    code: "move_to_private_chat",
    category: "off_platform_contact",
    severity: "medium",
    basis: "heuristic",
    description: "Asks the applicant to continue on a private messaging app instead of an official channel.",
    pattern: new RegExp(String.raw`\b(?:contact|message|text|add|reach|dm|pm|chat with|talk to|apply)\s+(?:me|us|our (?:hr|recruiter|manager|team)|the (?:hr|recruiter|manager))?\s*(?:directly\s+|only\s+)?(?:on|via|at|through|using)\s+${MSG_APP}\b|\b(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|t\.me|telegram\.me)\/[^\s]{1,60}`, "gi"),
  },
  {
    code: "platform_bypass",
    category: "off_platform_contact",
    severity: "medium",
    basis: "heuristic",
    description: "Tells the applicant not to apply or reply through the platform.",
    pattern: /\b(?:do not|don'?t)\s+(?:apply|reply|respond)\s+(?:on|through|via|here|on this (?:site|platform|website))\b/gi,
  },
  {
    code: "messaging_app_mention",
    category: "off_platform_contact",
    severity: "low",
    basis: "heuristic",
    description: "Mentions a private messaging app. Common for small employers; weak signal on its own.",
    pattern: /\b(?:whats\s?app|whatsap|watsapp|wasap|telegram|wechat|viber)\b/gi,
  },
];

/** Words that cancel a match when they appear shortly before it in the same sentence. */
const NEGATION_BEFORE =
  /(?:\b(?:never|not|cannot|no one|nobody|without|free of)\b|n't\b|\bno(?:\s+\w+){0,2}\s*$|\b(?:we|the company|our company|employer|they)\s+(?:will\s+)?(?:cover|covers|pay|pays|sponsor|sponsors|reimburse|reimburses|provide|provides)\b)/i;
/** Phrases right after a match that cancel it ("training fee is waived"). */
const NEGATION_AFTER =
  /^[^.!?\n]{0,30}\b(?:free of charge|is free|are free|waived|not required|fully sponsored|covered by (?:us|the company)|paid by (?:us|the company))\b/i;

// ===========================================================================
// Public entry point
// ===========================================================================

/**
 * Analyse an internship listing for scam indicators. Never throws, never
 * touches the network. See the module header for the meaning of results.
 */
export async function checkInternshipRisk(input: ScamCheckRequest): Promise<ToolResult<ScamRiskData>> {
  try {
    return analyzeListing(input as unknown);
  } catch (err) {
    // Defensive: a bug here must not crash the MCP server or fake a verdict.
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", data: null, evidence: [], warnings: [`Scam analysis failed unexpectedly: ${reason}`] };
  }
}

// Compile-time proof that Developer 1's server can call this function as-is.
checkInternshipRisk satisfies CheckInternshipRiskHandler;

// ===========================================================================
// Orchestration
// ===========================================================================

interface NormalizedInput {
  description: string | null;
  url: string | null;
  companyName: string | null;
  recruiterContact: string | null;
  hiddenCharCount: number;
  warnings: string[];
  incomplete: boolean;
}

function analyzeListing(raw: unknown): ToolResult<ScamRiskData> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      status: "error",
      data: null,
      evidence: [],
      warnings: [
        `Invalid input: expected an object with "url" and "jobDescription" (or "postingText"), got ${describeType(raw)}. No analysis was performed.`,
      ],
    };
  }

  const input = normalizeInput(raw as Record<string, unknown>);
  const indicators: ScamIndicator[] = [];

  const urlResult = input.url === null ? emptyUrlAnalysis() : analyzeUrl(input.url);
  indicators.push(...urlResult.indicators);
  if (input.url !== null && !urlResult.analysis.valid) input.incomplete = true;
  for (const problem of urlResult.analysis.problems) input.warnings.push(`URL: ${problem}`);

  if (input.description !== null) indicators.push(...analyzeText(input.description, "job_description"));
  if (input.recruiterContact !== null) indicators.push(...analyzeText(input.recruiterContact, "recruiter_contact"));
  if (input.hiddenCharCount > 0) {
    indicators.push({
      code: "hidden_characters",
      category: "text_obfuscation",
      severity: "low",
      basis: "heuristic",
      location: "job_description",
      description: "The text contains invisible characters, which are sometimes inserted to evade scam filters.",
      matchedText: `${input.hiddenCharCount} zero-width character(s)`,
      occurrences: input.hiddenCharCount,
    });
  }
  indicators.push(...analyzeContactDomains(input, urlResult.analysis));

  const finalIndicators = dropRedundant(indicators);
  const information = assessInformation(input.description, input.url !== null);
  const riskScore = scoreIndicators(finalIndicators);
  const assessment = decideAssessment(finalIndicators, riskScore, information);

  const warnings = [...input.warnings];
  if (assessment === "no_major_indicators_detected") warnings.push(NOT_A_SAFETY_VERDICT);
  if (assessment === "insufficient_evidence") {
    warnings.push("Not enough information to assess this listing; see data.information.missing.");
  }
  if (!information.sufficient && (assessment === "high_risk" || assessment === "medium_risk")) {
    warnings.push("The listing contains little detail; indicators were found, but other risks may not be visible.");
  }

  const limitations = [...BASE_LIMITATIONS];
  if (urlResult.analysis.knownPlatform?.kind === "job_board" || urlResult.analysis.knownPlatform?.kind === "applicant_tracking_system") {
    limitations.push(
      `The listing is hosted on ${urlResult.analysis.knownPlatform.name}. Being hosted on a job platform does not mean the platform verified the employer.`,
    );
  }
  if (urlResult.analysis.registrableDomain !== null) {
    limitations.push("Registrable domains are approximated without the Public Suffix List and may be wrong for unusual domains.");
  }

  const data: ScamRiskData = {
    assessment,
    riskLevel: toRiskLevel(assessment),
    riskScore,
    redFlags: finalIndicators,
    recommendation: RECOMMENDATIONS[assessment],
    observedCount: finalIndicators.filter((i) => i.basis === "observed").length,
    heuristicCount: finalIndicators.filter((i) => i.basis === "heuristic").length,
    url: urlResult.analysis,
    information,
    limitations,
    analyzerVersion: SCAM_CHECK_VERSION,
  };

  return {
    status: input.incomplete ? "partial" : "success",
    data,
    evidence: finalIndicators.map((ind) => ({
      source: ind.location === "url" ? "posting_url" : ind.location === "recruiter_contact" ? "recruiter_contact" : "posting_text",
      description: `[${ind.basis}] ${ind.description} Excerpt: "${ind.matchedText}"`,
    })),
    warnings,
  };
}

function normalizeInput(obj: Record<string, unknown>): NormalizedInput {
  const out: NormalizedInput = {
    description: null,
    url: null,
    companyName: null,
    recruiterContact: null,
    hiddenCharCount: 0,
    warnings: [],
    incomplete: false,
  };

  const desc = readString(obj, ["jobDescription", "postingText"], MAX_DESCRIPTION_CHARS, out);
  if (desc !== null) {
    const zeroWidth = desc.match(/[\u200B-\u200D\u2060\uFEFF]/g);
    out.hiddenCharCount = zeroWidth?.length ?? 0;
    const cleaned = cleanText(desc);
    out.description = cleaned.length > 0 ? cleaned : null;
  }
  if (out.description === null) {
    out.incomplete = true;
    out.warnings.push("No job description was provided; text checks were skipped.");
  }

  const url = readString(obj, ["url", "postingUrl"], MAX_URL_CHARS, out, { truncate: false });
  if (url !== null && url.trim().length > 0) {
    out.url = url.trim();
  } else {
    out.incomplete = true;
    out.warnings.push("No URL was provided; URL checks were skipped.");
  }

  const company = readString(obj, ["companyName"], MAX_SHORT_FIELD_CHARS, out);
  if (company !== null && cleanText(company).length > 0) out.companyName = cleanText(company);
  const contact = readString(obj, ["recruiterContact"], MAX_SHORT_FIELD_CHARS, out);
  if (contact !== null && cleanText(contact).length > 0) out.recruiterContact = cleanText(contact);

  return out;
}

function readString(
  obj: Record<string, unknown>,
  keys: string[],
  maxLen: number,
  out: NormalizedInput,
  opts: { truncate: boolean } = { truncate: true },
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      out.incomplete = true;
      out.warnings.push(`"${key}" must be a string but was ${describeType(value)}; it was ignored.`);
      return null;
    }
    if (value.length > maxLen) {
      out.incomplete = true;
      if (!opts.truncate) {
        out.warnings.push(`"${key}" is longer than ${maxLen} characters; it was ignored.`);
        return null;
      }
      out.warnings.push(`"${key}" was truncated to ${maxLen} characters for analysis.`);
      return value.slice(0, maxLen);
    }
    return value;
  }
  return null;
}

/** NFKC folds look-alike forms (full-width letters etc.); strips zero-width and control characters. */
function cleanText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

// ===========================================================================
// Text analysis
// ===========================================================================

/** Run all text rules over `text`. Exported for unit tests. */
export function analyzeText(text: string, location: InputLocation = "job_description"): ScamIndicator[] {
  const bounded = text.slice(0, MAX_DESCRIPTION_CHARS);
  const found: ScamIndicator[] = [];

  for (const rule of TEXT_RULES) {
    let first: string | null = null;
    let count = 0;
    rule.pattern.lastIndex = 0;
    for (const m of bounded.matchAll(rule.pattern)) {
      if (count >= MAX_MATCHES_PER_RULE) break;
      const start = m.index ?? 0;
      if (rule.negatable && isNegated(bounded, start, m[0].length)) continue;
      count += 1;
      first ??= excerpt(bounded, start, m[0].length);
    }
    if (first !== null) {
      found.push({
        code: rule.code,
        category: rule.category,
        severity: rule.severity,
        basis: rule.basis,
        location,
        description: rule.description,
        matchedText: first,
        occurrences: count,
      });
    }
  }

  const pay = findUnrealisticPay(bounded, location);
  if (pay) found.push(pay);
  return found;
}

function isNegated(text: string, start: number, length: number): boolean {
  const before = text.slice(Math.max(0, start - 60), start);
  const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"), before.lastIndexOf(";"));
  const clause = before.slice(sentenceStart + 1);
  if (NEGATION_BEFORE.test(clause)) return true;
  return NEGATION_AFTER.test(text.slice(start + length, start + length + 60));
}

const PAY_PATTERN =
  /(?:\b(?:RM|MYR|USD|SGD|AUD|EUR|GBP)|US\$|S\$|\$|€|£)\s?(\d{1,3}(?:,\d{3}){1,3}|\d{1,7})(?:\.\d{1,2})?\s?(?:\/|per\s|a\s|an\s|each\s|every\s)\s?(hour|hr|day|task|order|week)s?\b/gi;
const PAY_THRESHOLDS: Record<string, number> = { hour: 50, hr: 50, day: 300, task: 20, order: 20, week: 1500 };

function findUnrealisticPay(text: string, location: InputLocation): ScamIndicator | null {
  let first: string | null = null;
  let count = 0;
  for (const m of text.matchAll(PAY_PATTERN)) {
    const amount = Number((m[1] ?? "").replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    const threshold = PAY_THRESHOLDS[unit];
    if (threshold !== undefined && amount >= threshold) {
      count += 1;
      first ??= excerpt(text, m.index ?? 0, m[0].length);
    }
  }
  if (first === null) return null;
  return {
    code: "unrealistic_pay",
    category: "unrealistic_promise",
    severity: "medium",
    basis: "heuristic",
    location,
    description: "Promises pay per hour, day, week or task that is unusually high for an internship (rough, currency-agnostic threshold).",
    matchedText: first,
    occurrences: count,
  };
}

function excerpt(text: string, start: number, length: number): string {
  const from = Math.max(0, start - EXCERPT_RADIUS);
  const to = Math.min(text.length, start + length + EXCERPT_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

// ===========================================================================
// URL analysis (parsing only; never fetched or resolved)
// ===========================================================================

function emptyUrlAnalysis(): { analysis: UrlAnalysis; indicators: ScamIndicator[] } {
  return {
    analysis: {
      provided: false, valid: false, normalized: null, scheme: null, hostname: null,
      registrableDomain: null, isIpAddress: false, isInternationalized: false, knownPlatform: null, problems: [],
    },
    indicators: [],
  };
}

/** Parse and assess a listing URL as text. Exported for unit tests. */
export function analyzeUrl(rawInput: string): { analysis: UrlAnalysis; indicators: ScamIndicator[] } {
  const result = emptyUrlAnalysis();
  const a = result.analysis;
  const ind = result.indicators;
  a.provided = true;
  const raw = rawInput.trim();
  const shown = truncateForDisplay(raw);

  const add = (code: string, category: IndicatorCategory, severity: Severity, basis: EvidenceBasis, description: string, matched = shown) =>
    ind.push({ code, category, severity, basis, location: "url", description, matchedText: matched, occurrences: 1 });

  if (raw.length === 0) {
    a.problems.push("empty");
    return result;
  }
  if (raw.length > MAX_URL_CHARS) {
    a.problems.push(`longer than ${MAX_URL_CHARS} characters`);
    return result;
  }
  if (/[\s\u0000-\u001F\u007F]/.test(raw)) {
    a.problems.push("contains spaces or control characters; not a valid URL");
    return result;
  }

  let candidate = raw;
  const schemeMatch = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(raw);
  const looksLikeHost = /^[^/:?#@]+\.[a-z]{2,}(?::\d{1,5})?(?:[/?#]|$)/i.test(raw);
  if (!schemeMatch || (looksLikeHost && !raw.includes("://") && !/^(?:javascript|data|vbscript|file|mailto|tel):/i.test(raw))) {
    if (looksLikeHost) {
      candidate = `https://${raw}`;
      a.problems.push("no scheme given; assumed https:// for analysis only");
    } else {
      a.problems.push("not a recognisable URL");
      return result;
    }
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    a.problems.push("could not be parsed as a URL");
    return result;
  }

  a.scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (a.scheme !== "http" && a.scheme !== "https") {
    if (["javascript", "data", "vbscript", "file", "blob"].includes(a.scheme)) {
      add("dangerous_url_scheme", "url_structure", "high", "observed",
        `Uses the "${a.scheme}:" scheme, which can run code or hide content and is never used for genuine job links.`);
    } else {
      add("non_web_url_scheme", "url_structure", "medium", "heuristic", `Uses the "${a.scheme}:" scheme instead of a web address.`);
    }
    a.problems.push(`scheme "${a.scheme}" is not http or https`);
    return result;
  }

  // userinfo trick: https://www.linkedin.com@evil.example/
  if (url.username !== "" || url.password !== "") {
    add("url_embedded_credentials", "url_structure", "high", "observed",
      `Contains text before an "@" sign, which browsers ignore: the real destination is "${url.hostname}", not what appears first.`);
  }

  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  a.hostname = host;
  if (host.length === 0) {
    a.problems.push("has no hostname");
    return result;
  }
  a.normalized = `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  a.valid = true;

  // ---- IP-literal hosts ----
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ipVersion = isIP(bare);
  if (ipVersion !== 0) {
    a.isIpAddress = true;
    const rawHost = extractRawHost(candidate);
    if (ipVersion === 4 && rawHost !== null && rawHost !== bare) {
      add("obfuscated_ip_host", "url_structure", "high", "observed",
        `Writes an IP address in a disguised form ("${truncateForDisplay(rawHost, 60)}" is ${bare}).`);
    } else {
      add("ip_address_host", "url_structure", "medium", "heuristic", "Points to a raw IP address instead of a company domain name.");
    }
    if (NON_PUBLIC_RANGES.check(bare, ipVersion === 4 ? "ipv4" : "ipv6")) {
      add("non_public_ip_host", "url_structure", "low", "heuristic", `Points to a private, loopback or reserved address (${bare}), which cannot be a public job listing.`);
    }
  } else {
    analyzeDomainHost(url, host, raw, a, ind, add);
  }

  // ---- generic structure ----
  if (a.scheme === "http") add("no_https", "url_structure", "low", "heuristic", "Uses unencrypted http:// rather than https://.");
  if (url.port !== "") add("non_standard_port", "url_structure", "low", "heuristic", `Uses a non-standard port (${url.port}).`);

  for (const [key, value] of url.searchParams) {
    if (REDIRECT_PARAMS.has(key.toLowerCase()) && /^(?:https?:)?\/\//i.test(value)) {
      add("redirect_parameter", "url_structure", "low", "heuristic", `Carries another web address in its "${key}" parameter, which can be used to redirect visitors elsewhere.`);
      break;
    }
  }
  return result;
}

function analyzeDomainHost(
  url: URL,
  host: string,
  raw: string,
  a: UrlAnalysis,
  ind: ScamIndicator[],
  add: (code: string, category: IndicatorCategory, severity: Severity, basis: EvidenceBasis, description: string, matched?: string) => void,
): void {
  const labels = host.split(".");
  if (labels.length < 2) {
    a.problems.push("hostname has no domain suffix");
    add("unqualified_hostname", "url_structure", "low", "heuristic", "Hostname has no domain suffix, so it cannot be a public website.");
    return;
  }

  a.registrableDomain = registrableDomain(host);
  const reg = a.registrableDomain;
  const tld = labels[labels.length - 1] ?? "";

  const rawHost = extractRawHost(raw.includes("://") ? raw : `https://${raw}`) ?? "";
  a.isInternationalized = /[^\x00-\x7F]/.test(rawHost) || labels.some((l) => l.startsWith("xn--"));
  if (a.isInternationalized) {
    add("internationalized_domain", "url_structure", "medium", "heuristic",
      `Uses non-Latin or look-alike characters in the domain (encoded as "${host}"), a technique used to imitate real domains.`);
  }

  a.knownPlatform = findPlatform(host, url.pathname);
  switch (a.knownPlatform?.kind) {
    case "url_shortener":
      add("url_shortener", "url_structure", "medium", "heuristic", "Uses a link shortener, which hides the real destination.");
      break;
    case "messaging_app":
      add("messaging_app_link", "off_platform_contact", "medium", "heuristic",
        `The listing link opens ${a.knownPlatform.name} instead of a job page or company website.`);
      break;
    case "form_builder":
      add("generic_form_link", "url_structure", "low", "heuristic",
        `Applications go to a generic ${a.knownPlatform.name} form rather than a company or job-platform page.`);
      break;
    case "free_hosting":
      add("free_hosting_domain", "url_structure", "low", "heuristic", "Hosted on a free website service rather than a company domain.");
      break;
    case "tunnel_service":
      add("tunnel_host", "url_structure", "medium", "heuristic", "Hosted on a temporary tunnel service, which genuine employers do not use for job listings.");
      break;
    default:
      break;
  }

  // brand name used in a domain the brand does not own
  for (const brand of BRANDS) {
    if (reg !== null && brand.official.includes(reg)) continue;
    if (labels.some((label) => labelContainsBrand(label, brand.token))) {
      add("brand_name_in_unrelated_domain", "domain_mismatch", "high", "heuristic",
        `Uses the name "${brand.token}" in a domain it does not officially use (${reg ?? host}).`);
      break;
    }
  }

  // look-alike spelling of a brand: Cyrillic/Greek homoglyphs or digit/letter swaps
  if (!ind.some((i) => i.code === "brand_name_in_unrelated_domain")) {
    const lookalike = findLookalikeBrand(labels, reg);
    if (lookalike !== null) {
      if (lookalike.nonAscii) {
        add("homoglyph_brand_domain", "domain_mismatch", "high", "observed",
          `The domain "${lookalike.display}" uses look-alike characters so that it reads as "${lookalike.brand}", but it is a different domain.`);
      } else {
        add("typosquat_brand_domain", "domain_mismatch", "high", "heuristic",
          `The domain "${lookalike.display}" is a near-spelling of "${lookalike.brand}" (letters or digits swapped).`);
      }
    }
  }

  // official domain of a brand placed in the path to mislead (evil.example/linkedin.com/jobs)
  const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase();
  for (const brand of BRANDS) {
    if (reg !== null && brand.official.includes(reg)) continue;
    const hit = brand.official.find((d) => pathAndQuery.includes(d));
    if (hit) {
      add("misleading_domain_in_path", "domain_mismatch", "medium", "heuristic", `Shows "${hit}" in the path, but the site is actually ${reg ?? host}.`);
      break;
    }
  }

  if (SUSPICIOUS_TLDS.has(tld)) {
    add("suspicious_tld", "url_structure", "low", "heuristic", `Uses the ".${tld}" domain ending, which is frequently used in phishing (also used legitimately).`);
  }
  const subLabels = reg === null ? labels : labels.slice(0, labels.length - reg.split(".").length);
  const regLabel = reg?.split(".")[0] ?? "";
  if (subLabels.length >= 4 || host.length > 60 || (regLabel.replace(/^xn--/, "").match(/-/g)?.length ?? 0) >= 3) {
    add("unusual_hostname_structure", "url_structure", "low", "heuristic", "Has an unusually long or deeply nested hostname.");
  }
  if (a.knownPlatform === null) {
    const word = PHISHING_HOST_WORDS.find((w) => labels.some((l) => l.includes(w)));
    if (word) add("phishing_keyword_in_host", "url_structure", "low", "heuristic", `Contains "${word}" in the hostname, a word often used in phishing domains.`);
  }
}

/** Confusable characters folded to the Latin letter they imitate (small, common subset). */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
  "ԁ": "d", "һ": "h", "ӏ": "l", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "ո": "n", "ս": "u",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "ɡ": "g", "ɩ": "i",
};

/** Reduce a label to a "skeleton" so that visually similar spellings compare equal. */
function skeleton(label: string): string {
  let out = "";
  for (const ch of label.normalize("NFKC").toLowerCase()) out += CONFUSABLES[ch] ?? ch;
  return out
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[1i|!]/g, "l")
    .replace(/5/g, "s");
}

function findLookalikeBrand(
  labels: string[],
  reg: string | null,
): { brand: string; display: string; nonAscii: boolean } | null {
  for (const brand of BRANDS) {
    if (reg !== null && brand.official.includes(reg)) continue;
    if (brand.token.length < 5) continue; // short names produce too many false positives
    const target = skeleton(brand.token);
    for (const label of labels) {
      const unicode = label.startsWith("xn--") ? domainToUnicode(label) || label : label;
      for (const token of unicode.split(/[-_]+/)) {
        if (token !== brand.token && skeleton(token) === target) {
          return { brand: brand.token, display: unicode, nonAscii: /[^\x00-\x7F]/.test(unicode) };
        }
      }
    }
  }
  return null;
}

function labelContainsBrand(label: string, token: string): boolean {
  const parts = label.split(/[-_\d]+/).filter(Boolean);
  if (parts.includes(token)) return true;
  // concatenations like "linkedincareers": only for distinctive brand names
  return token.length >= 6 && (label.startsWith(token) || label.endsWith(token)) && label !== token;
}

function registrableDomain(host: string): string | null {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  for (const n of [3, 2]) {
    if (labels.length >= n && MULTI_LABEL_SUFFIXES.has(labels.slice(-n).join("."))) {
      return labels.length > n ? labels.slice(-(n + 1)).join(".") : labels.slice(-n).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

function findPlatform(host: string, pathname: string): KnownPlatform | null {
  if (host === "docs.google.com" && pathname.startsWith("/forms")) return { name: "Google Forms", kind: "form_builder" };
  if (host === "sites.google.com") return { name: "free website host", kind: "free_hosting" };
  if (host === "api.whatsapp.com" || host === "chat.whatsapp.com") return { name: "WhatsApp", kind: "messaging_app" };
  for (const p of PLATFORMS) {
    if (p.domains.some((d) => host === d || host.endsWith(`.${d}`))) return { name: p.name, kind: p.kind };
  }
  return null;
}

/** Host exactly as typed, before WHATWG normalisation (used to spot disguised IPs and IDN). */
function extractRawHost(urlString: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(urlString);
  if (!m || m[1] === undefined) return null;
  let authority = m[1];
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  if (authority.startsWith("[")) return authority.slice(1, authority.indexOf("]") === -1 ? undefined : authority.indexOf("]")).toLowerCase();
  return authority.replace(/:\d*$/, "").toLowerCase();
}

function truncateForDisplay(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ===========================================================================
// Contact and company domain consistency (heuristic)
// ===========================================================================

const EMAIL_PATTERN = /\b[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,5})\b/gi;
const COMPANY_STOPWORDS = new Set([
  "sdn", "bhd", "berhad", "ltd", "limited", "inc", "incorporated", "llc", "pte", "plc", "gmbh",
  "corp", "corporation", "company", "co", "group", "holdings", "the", "and", "of", "international",
  "global", "solutions", "services", "technologies", "technology", "enterprise", "enterprises",
]);

function analyzeContactDomains(input: NormalizedInput, url: UrlAnalysis): ScamIndicator[] {
  const out: ScamIndicator[] = [];
  const sources: Array<[InputLocation, string | null]> = [
    ["job_description", input.description],
    ["recruiter_contact", input.recruiterContact],
  ];
  const urlIsCompanySite = url.registrableDomain !== null && url.knownPlatform === null;
  let webmailFlagged = false;
  let mismatchFlagged = false;

  for (const [location, text] of sources) {
    if (text === null) continue;
    let n = 0;
    for (const m of text.matchAll(EMAIL_PATTERN)) {
      if (++n > MAX_MATCHES_PER_RULE) break;
      const domain = (m[1] ?? "").toLowerCase();
      const email = m[0];
      if (FREE_WEBMAIL.has(domain)) {
        if (!webmailFlagged) {
          webmailFlagged = true;
          out.push({
            code: "free_webmail_contact", category: "domain_mismatch", severity: "medium", basis: "heuristic", location,
            description: `The recruiter uses a free personal email address (${domain}) rather than a company domain.`,
            matchedText: email, occurrences: 1,
          });
        }
        continue;
      }
      const emailReg = registrableDomain(domain);
      if (!mismatchFlagged && urlIsCompanySite && emailReg !== null && emailReg !== url.registrableDomain) {
        mismatchFlagged = true;
        out.push({
          code: "contact_domain_mismatch", category: "domain_mismatch", severity: "low", basis: "heuristic", location,
          description: `The contact email's domain (${emailReg}) differs from the listing's domain (${url.registrableDomain}).`,
          matchedText: email, occurrences: 1,
        });
      }
    }
  }

  if (input.companyName !== null && urlIsCompanySite && url.registrableDomain !== null) {
    const tokens = input.companyName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !COMPANY_STOPWORDS.has(t));
    const domainLabel = url.registrableDomain.split(".")[0] ?? "";
    const compact = tokens.join("");
    const matches = tokens.length === 0 || tokens.some((t) => domainLabel.includes(t)) || (compact.length > 0 && domainLabel.includes(compact));
    if (!matches) {
      out.push({
        code: "company_domain_mismatch", category: "domain_mismatch", severity: "low", basis: "heuristic", location: "company_name",
        description: `The company name "${input.companyName}" does not appear in the listing's domain (${url.registrableDomain}).`,
        matchedText: input.companyName, occurrences: 1,
      });
    }
  }
  return out;
}

// ===========================================================================
// Scoring and assessment
// ===========================================================================

const SEVERITY_POINTS: Record<Severity, number> = { high: 40, medium: 15, low: 5 };
const BASIS_WEIGHT: Record<EvidenceBasis, number> = { observed: 1, heuristic: 0.6 };

function dropRedundant(indicators: ScamIndicator[]): ScamIndicator[] {
  const strongOffPlatform = indicators.some(
    (i) => i.category === "off_platform_contact" && i.code !== "messaging_app_mention" && i.severity !== "low",
  );
  const seen = new Set<string>();
  return indicators.filter((i) => {
    if (strongOffPlatform && i.code === "messaging_app_mention") return false;
    const key = `${i.code}|${i.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreIndicators(indicators: ScamIndicator[]): number {
  const total = indicators.reduce((sum, i) => sum + SEVERITY_POINTS[i.severity] * BASIS_WEIGHT[i.basis], 0);
  return Math.min(100, Math.round(total));
}

function decideAssessment(indicators: ScamIndicator[], score: number, info: InformationSufficiency): ScamAssessment {
  const observedHigh = indicators.some((i) => i.basis === "observed" && i.severity === "high");
  if (observedHigh || score >= 50) return "high_risk";
  if (score >= 15) return "medium_risk";
  if (!info.sufficient) return "insufficient_evidence";
  return "no_major_indicators_detected";
}

function toRiskLevel(a: ScamAssessment): RiskLevel {
  switch (a) {
    case "high_risk":
      return "high";
    case "medium_risk":
      return "medium";
    case "no_major_indicators_detected":
      return "low";
    case "insufficient_evidence":
      return "unknown";
  }
}

const INFORMATION_SIGNALS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "role responsibilities", pattern: /\b(?:responsibilit(?:y|ies)|duties|you will|you'll|tasks? include|scope of work|role involves|assist (?:with|in)|support (?:the|our))\b/i },
  { name: "requirements or qualifications", pattern: /\b(?:requirements?|qualifications?|skills?|must (?:have|be)|we are looking for|candidates? (?:should|must)|studying|pursuing|degree|diploma|undergraduate|students?)\b/i },
  { name: "company identity", pattern: /\b(?:sdn\.? bhd|bhd|berhad|ltd|limited|inc|llc|pte|plc|gmbh|corp(?:oration)?|company|about us|our (?:company|team|firm|organi[sz]ation))\b/i },
  { name: "logistics (duration, location, pay or schedule)", pattern: /\b(?:duration|weeks?|months?|start date|location|remote|hybrid|on-?site|office|allowance|stipend|salary|per month|monthly|hours|full[- ]time|part[- ]time)\b/i },
  { name: "application process", pattern: /\b(?:apply|application|interviews?|send (?:your|us your) (?:cv|resume)|submit (?:your )?(?:cv|resume|application)|careers? (?:page|portal|site))\b/i },
];
const MIN_WORDS = 30;
const MIN_SIGNALS = 3;

function assessInformation(description: string | null, hasUrl: boolean): InformationSufficiency {
  const text = description ?? "";
  const wordCount = text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;
  const present = INFORMATION_SIGNALS.filter((s) => s.pattern.test(text));
  const missing = INFORMATION_SIGNALS.filter((s) => !s.pattern.test(text)).map((s) => s.name);
  if (description === null) missing.unshift("job description text");
  else if (wordCount < MIN_WORDS) missing.unshift(`more detail (only ${wordCount} words provided)`);
  if (!hasUrl) missing.push("a link to the listing");
  return { sufficient: wordCount >= MIN_WORDS && present.length >= MIN_SIGNALS, wordCount, missing };
}
