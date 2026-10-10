/**
 * check_student_eligibility: matches a student's profile against the
 * listing's stated requirements.
 * OWNER: Developer 3.
 *
 * Deterministic and offline. It does NOT assess immigration or labour law:
 * work authorization is always reported as something to confirm officially.
 * A requirement the input cannot decide is reported with met = null, never
 * guessed.
 */
import type {
  CheckStudentEligibilityHandler,
  CheckStudentEligibilityInput,
  EligibilityRequirement,
  StudentEligibilityData,
} from "../shared/types.js";

export const ELIGIBILITY_DISCLAIMER =
  "Informational only: this compares the student's stated profile with the listing's stated requirements. It is not legal or immigration advice; confirm work authorization and internship rules with your institution and official sources.";

const SKILL_ALIASES: Record<string, string> = {
  js: "javascript", "node.js": "nodejs", node: "nodejs", ts: "typescript", py: "python",
  "ms excel": "excel", "microsoft excel": "excel", "powerbi": "power bi", "postgres": "postgresql",
  "ml": "machine learning", "ui/ux": "ux design", "ux": "ux design",
};

export function normalizeSkill(skill: string): string {
  const s = skill.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return SKILL_ALIASES[s] ?? s;
}

/**
 * Specific skills that demonstrate a general one. Only clear-cut cases:
 * a Linux distribution is Linux experience; MySQL is SQL. Never used to
 * invent a skill the student did not state.
 */
const IMPLIED_BY: Record<string, string[]> = {
  linux: ["kali", "kali linux", "ubuntu", "debian", "fedora", "centos", "red hat", "rhel", "arch linux", "linux mint", "parrot os"],
  windows: ["windows server", "active directory", "windows administration", "windows 10", "windows 11"],
  networking: ["ccna", "tcp/ip", "tcp ip", "wireshark", "cisco", "routing and switching", "network administration", "computer networks", "computer networking", "network security"],
  sql: ["mysql", "postgresql", "sqlite", "sql server", "mssql", "t-sql", "pl/sql", "oracle sql", "mariadb"],
  javascript: ["typescript", "react", "nodejs", "vue", "angular", "next.js", "jquery"],
  python: ["django", "flask", "fastapi", "pandas", "numpy", "pytorch", "tensorflow", "scikit-learn"],
  java: ["spring", "spring boot"],
  git: ["github", "gitlab", "bitbucket"],
  cybersecurity: ["penetration testing", "ethical hacking", "network security", "ceh", "security+", "comptia security+", "kali linux", "siem"],
  "cloud computing": ["aws", "azure", "google cloud", "gcp"],
};

/** Related but NOT proof (reported as unknown, never as met). */
const RELATED: Record<string, string[]> = {
  linux: ["unix", "macos", "bash", "shell scripting"],
  networking: ["cybersecurity", "cyber security"],
};

export type SkillMatch = { status: "exact" | "implied" | "related" | "missing"; via?: string };

function hasTerm(haystack: string, term: string): boolean {
  if (term.length < 3) return haystack === term;
  const i = haystack.indexOf(term);
  if (i === -1) return false;
  const before = haystack[i - 1] ?? " ";
  const after = haystack[i + term.length] ?? " ";
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/** How a student's stated skills relate to one required skill. */
export function matchSkill(studentSkills: string[], required: string): SkillMatch {
  const req = normalizeSkill(required);
  const mine = studentSkills.map((s) => ({ raw: s, n: normalizeSkill(s) }));
  if (mine.some((s) => s.n === req)) return { status: "exact" };
  const contains = mine.find((s) => hasTerm(s.n, req)); // "Linux administration" demonstrates "Linux"
  if (contains) return { status: "implied", via: contains.raw };
  const implied = mine.find((s) => (IMPLIED_BY[req] ?? []).some((k) => s.n === k || hasTerm(s.n, k)));
  if (implied) return { status: "implied", via: implied.raw };
  const related = mine.find((s) => (RELATED[req] ?? []).some((k) => s.n === k || hasTerm(s.n, k)));
  if (related) return { status: "related", via: related.raw };
  return { status: "missing" };
}

function majorMatches(studentMajor: string, required: string): boolean {
  const a = studentMajor.toLowerCase();
  const b = required.toLowerCase();
  if (/\b(any|all)\b/.test(b)) return true;
  return a.includes(b) || b.includes(a);
}

function isIsoDate(s: string | undefined): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export const checkStudentEligibility: CheckStudentEligibilityHandler = async (input: CheckStudentEligibilityInput) => {
  const req = input?.requirements;
  const student = input?.student;
  const requirements: EligibilityRequirement[] = [];
  const missingInformation: string[] = [];
  const warnings: string[] = [];
  /** Requirements that decide the outcome (preferred skills do not). */
  const mandatory: EligibilityRequirement[] = [];
  const addReq = (description: string, met: boolean | null, isMandatory = true) => {
    const r = { description, met };
    requirements.push(r);
    if (isMandatory) mandatory.push(r);
  };

  if (typeof input?.internshipCountry !== "string" || input.internshipCountry.trim() === "") {
    return { status: "error", data: null, evidence: [], warnings: ["internshipCountry is required."] };
  }

  if (req?.majors && req.majors.length > 0) {
    if (!student?.major) {
      addReq(`Field of study: ${req.majors.join(" / ")}`, null);
      missingInformation.push("student's major");
    } else addReq(`Field of study: ${req.majors.join(" / ")} (student: ${student.major})`, req.majors.some((m) => majorMatches(student.major ?? "", m)));
  }

  if (req?.studyLevels && req.studyLevels.length > 0) {
    if (!input.studyLevel) {
      addReq(`Study level: ${req.studyLevels.join(" / ")}`, null);
      missingInformation.push("study level");
    } else addReq(`Study level: ${req.studyLevels.join(" / ")} (student: ${input.studyLevel})`, req.studyLevels.includes(input.studyLevel));
  }

  if (req?.requiresEnrollment) {
    if (input.currentlyEnrolled === undefined) {
      addReq("Currently enrolled as a student", null);
      missingInformation.push("enrolment status");
    } else addReq("Currently enrolled as a student", input.currentlyEnrolled);
  }

  // Skills: a skill absent from the profile is UNKNOWN (null), not "not met":
  // the profile may simply not list it. It never counts as met either.
  const skillReq = (label: string, skill: string, mandatory: boolean) => {
    if (!student?.skills) return addReq(`${label}: ${skill}`, null, mandatory);
    const m = matchSkill(student.skills, skill);
    if (m.status === "exact") return addReq(`${label}: ${skill}`, true, mandatory);
    if (m.status === "implied") return addReq(`${label}: ${skill} (shown by your skill "${m.via}")`, true, mandatory);
    if (m.status === "related") return addReq(`${label}: ${skill} (related to your skill "${m.via}"; confirm you have it)`, null, mandatory);
    return addReq(`${label}: ${skill} (not shown in your profile)`, null, mandatory);
  };
  for (const skill of req?.requiredSkills ?? []) skillReq("Required skill", skill, true);
  for (const skill of req?.preferredSkills ?? []) skillReq("Preferred skill (not mandatory)", skill, false);
  if ((req?.requiredSkills?.length ?? 0) > 0 && !student?.skills) missingInformation.push("student's skills");
  const unshown = (req?.requiredSkills ?? []).filter((s) => student?.skills && matchSkill(student.skills, s).status !== "exact" && matchSkill(student.skills, s).status !== "implied");
  if (unshown.length > 0) {
    missingInformation.push(`Required skills your profile does not show: ${unshown.join(", ")}. Add them to your profile only if you really have them.`);
  }

  const neededHours = req?.minHoursPerWeek ?? input.hoursPerWeek;
  if (neededHours !== undefined) {
    if (student?.hoursPerWeekAvailable === undefined) {
      addReq(`Availability: ${neededHours} hours per week`, null);
      missingInformation.push("hours per week the student can commit");
    } else addReq(`Availability: ${neededHours} hours per week (student: ${student.hoursPerWeekAvailable})`, student.hoursPerWeekAvailable >= neededHours);
  }

  if (isIsoDate(req?.startDate)) {
    if (!isIsoDate(student?.availableFrom)) {
      addReq(`Can start by ${req.startDate}`, null);
      missingInformation.push("date the student can start");
    } else addReq(`Can start by ${req.startDate} (student available from ${student.availableFrom})`, student.availableFrom <= req.startDate);
  }
  let endDate = isIsoDate(req?.endDate) ? req.endDate : undefined;
  if (!endDate && isIsoDate(req?.startDate) && input.internshipDurationWeeks) {
    endDate = new Date(Date.parse(req.startDate) + input.internshipDurationWeeks * 7 * 86400000).toISOString().slice(0, 10);
  }
  if (endDate) {
    if (!isIsoDate(student?.availableUntil)) addReq(`Available until ${endDate}`, null);
    else addReq(`Available until ${endDate} (student available until ${student.availableUntil})`, student.availableUntil >= endDate);
  }

  if (req?.workMode) {
    if (!student?.workModes || student.workModes.length === 0) addReq(`Work mode: ${req.workMode}`, null);
    else addReq(`Work mode: ${req.workMode} (student accepts ${student.workModes.join(", ")})`, student.workModes.includes(req.workMode));
  }
  if (req?.location && req.workMode !== "remote" && student?.locations && student.locations.length > 0) {
    const loc = req.location.toLowerCase();
    addReq(
      `Location: ${req.location} (student: ${student.locations.join(", ")})`,
      student.locations.some((l) => loc.includes(l.toLowerCase()) || l.toLowerCase().includes(loc)),
    );
  }

  // Work authorization: never decided here.
  const visa = input.visaOrPermitType?.trim().toLowerCase();
  if (!visa) {
    missingInformation.push(`work authorization status for ${input.internshipCountry}`);
  } else if (!/^(citizen|national|permanent resident|pr)$/.test(visa)) {
    addReq(`Permission to intern in ${input.internshipCountry} on "${input.visaOrPermitType}": confirm with your institution or immigration authority`, null);
  }

  let outcome: StudentEligibilityData["outcome"];
  if (mandatory.length === 0) {
    outcome = "unknown";
    warnings.push("No listing requirements were provided, so eligibility could not be assessed.");
  } else if (mandatory.some((r) => r.met === false)) outcome = "not_eligible";
  else if (mandatory.some((r) => r.met === null)) outcome = "conditionally_eligible";
  else outcome = "eligible";

  return {
    status: req ? "success" : "partial",
    data: { outcome, requirements, missingInformation, disclaimer: ELIGIBILITY_DISCLAIMER },
    evidence: [{ source: "agent_supplied_requirements", description: "Requirements as extracted from the listing by the agent; shortlist_internships cross-checks them against the stored listing text." }],
    warnings,
  };
};
