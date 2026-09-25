export type SigningMode = "signpath" | "unsigned";

export interface SigningFileRecord {
  path: string;
  sha512: string;
  signed: boolean;
  subject: string | null;
  timestamped: boolean;
}

export interface SigningManifest {
  mode: SigningMode;
  production: boolean;
  publisher: string | null;
  verifiedAt: string;
  files: SigningFileRecord[];
}

export interface VerificationFileReport extends SigningFileRecord {
  status: string;
  publisherMatches: boolean;
  errors: string[];
}

export interface VerificationReport {
  expectedPublisher: string | null;
  allowUnsigned: boolean;
  ok: boolean;
  checkedAt: string;
  files: VerificationFileReport[];
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface BuildSigningManifestInput {
  mode: SigningMode;
  production: boolean;
  publisher: string | null;
  report: VerificationReport;
  installer: { path: string; sha512: string };
  appUpdatePublisherNames: string[] | null;
}

const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function isSafeRelativePath(value: string): boolean {
  if (value === "" || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function parseDistinguishedName(dn: string): Map<string, string> {
  const result = new Map<string, string>();
  let current = "";
  let quoted = false;
  const parts: string[] = [];
  for (const char of dn) {
    if (char === '"') quoted = !quoted;
    if ((char === "," || char === ";") && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toUpperCase();
    const value = part.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!result.has(key)) result.set(key, value);
  }
  return result;
}

export function publisherMatches(subject: string | null, expected: string): boolean {
  if (subject === null || expected.trim() === "") return false;
  const actual = parseDistinguishedName(subject);
  if (!expected.includes("=")) return actual.get("CN") === expected;
  const wanted = parseDistinguishedName(expected);
  return wanted.size > 0 && [...wanted].every(([key, value]) => actual.get(key) === value);
}

function validateFileRecord(raw: unknown, index: number, errors: string[]): SigningFileRecord | null {
  const where = `files[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${where} is not an object`);
    return null;
  }
  const { path, sha512, signed, subject, timestamped } = raw;
  const before = errors.length;
  if (typeof path !== "string" || !isSafeRelativePath(path)) errors.push(`${where}.path must be a relative forward-slash path without "..": ${JSON.stringify(path)}`);
  if (typeof sha512 !== "string" || !SHA512_BASE64.test(sha512)) errors.push(`${where}.sha512 must be a base64 SHA-512 digest`);
  if (typeof signed !== "boolean") errors.push(`${where}.signed must be a boolean`);
  if (subject !== null && typeof subject !== "string") errors.push(`${where}.subject must be a string or null`);
  if (typeof timestamped !== "boolean") errors.push(`${where}.timestamped must be a boolean`);
  if (errors.length !== before) return null;
  return { path: path as string, sha512: sha512 as string, signed: signed as boolean, subject: subject as string | null, timestamped: timestamped as boolean };
}

function checkModeRules(manifest: SigningManifest, errors: string[]): void {
  if (manifest.mode === "unsigned" && manifest.production) {
    errors.push("unsigned mode can never be production");
  }
  if (manifest.mode !== "signpath") return;
  const publisher = manifest.publisher;
  if (publisher === null || publisher.trim() === "") {
    errors.push("signpath mode requires a publisher");
    return;
  }
  manifest.files.forEach((file) => {
    if (!file.signed) errors.push(`${file.path} is not signed`);
    if (!file.timestamped) errors.push(`${file.path} has no trusted timestamp`);
    if (!publisherMatches(file.subject, publisher)) {
      errors.push(`${file.path} is signed by ${JSON.stringify(file.subject)}, expected publisher ${JSON.stringify(publisher)}`);
    }
  });
}

export function validateSigningManifest(raw: unknown): Validation<SigningManifest> {
  if (!isRecord(raw)) return { ok: false, errors: ["Signing manifest is not an object"] };
  const errors: string[] = [];
  const { mode, production, publisher, verifiedAt, files } = raw;
  if (mode !== "signpath" && mode !== "unsigned") errors.push(`mode must be "signpath" or "unsigned", got ${JSON.stringify(mode)}`);
  if (typeof production !== "boolean") errors.push("production must be a boolean");
  if (publisher !== null && typeof publisher !== "string") errors.push("publisher must be a string or null");
  if (!isIsoTimestamp(verifiedAt)) errors.push("verifiedAt must be an ISO-8601 timestamp");
  if (!Array.isArray(files) || files.length === 0) errors.push("files must be a non-empty array");
  if (errors.length > 0) return { ok: false, errors };

  const records = (files as unknown[]).map((file, index) => validateFileRecord(file, index, errors));
  const paths = new Set<string>();
  for (const record of records) {
    if (record === null) continue;
    if (paths.has(record.path)) errors.push(`${record.path} is listed more than once`);
    paths.add(record.path);
  }
  if (errors.length > 0) return { ok: false, errors };

  const manifest: SigningManifest = {
    mode: mode as SigningMode,
    production: production as boolean,
    publisher: publisher as string | null,
    verifiedAt: verifiedAt as string,
    files: records.filter((record): record is SigningFileRecord => record !== null)
  };
  checkModeRules(manifest, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: manifest };
}

export function parseVerificationReport(raw: unknown): Validation<VerificationReport> {
  if (!isRecord(raw)) return { ok: false, errors: ["Verification report is not an object"] };
  const errors: string[] = [];
  const { expectedPublisher, allowUnsigned, ok, checkedAt, files } = raw;
  if (expectedPublisher !== null && typeof expectedPublisher !== "string") errors.push("expectedPublisher must be a string or null");
  if (typeof allowUnsigned !== "boolean") errors.push("allowUnsigned must be a boolean");
  if (typeof ok !== "boolean") errors.push("ok must be a boolean");
  if (!isIsoTimestamp(checkedAt)) errors.push("checkedAt must be an ISO-8601 timestamp");
  if (!Array.isArray(files) || files.length === 0) errors.push("files must be a non-empty array");
  if (errors.length > 0) return { ok: false, errors };

  const reports: VerificationFileReport[] = [];
  (files as unknown[]).forEach((file, index) => {
    const record = validateFileRecord(file, index, errors);
    if (record === null || !isRecord(file)) return;
    const { status, publisherMatches: matches, errors: fileErrors } = file;
    if (typeof status !== "string") errors.push(`files[${index}].status must be a string`);
    if (typeof matches !== "boolean") errors.push(`files[${index}].publisherMatches must be a boolean`);
    if (!Array.isArray(fileErrors) || !fileErrors.every((entry) => typeof entry === "string")) {
      errors.push(`files[${index}].errors must be an array of strings`);
    }
    reports.push({ ...record, status: String(status), publisherMatches: matches === true, errors: Array.isArray(fileErrors) ? fileErrors.map(String) : [] });
  });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      expectedPublisher: expectedPublisher as string | null,
      allowUnsigned: allowUnsigned as boolean,
      ok: ok as boolean,
      checkedAt: checkedAt as string,
      files: reports
    }
  };
}

export function buildSigningManifest(input: BuildSigningManifestInput): Validation<SigningManifest> {
  const { mode, production, report, installer, appUpdatePublisherNames } = input;
  const publisher = input.publisher === null || input.publisher.trim() === "" ? null : input.publisher;
  const errors: string[] = [];

  if (mode === "unsigned" && production) errors.push("unsigned mode can never be production");
  if (mode === "unsigned" && !report.allowUnsigned) errors.push("unsigned mode expects a report produced with -AllowUnsigned");
  if (mode === "signpath") {
    if (publisher === null) errors.push("signpath mode requires a publisher");
    if (report.allowUnsigned) errors.push("signpath mode cannot accept a report produced with -AllowUnsigned");
    if (!report.ok) errors.push("signature verification failed; see the verification report");
    if (publisher !== null && report.expectedPublisher !== publisher) {
      errors.push(`verification ran against publisher ${JSON.stringify(report.expectedPublisher)}, expected ${JSON.stringify(publisher)}`);
    }
    if (publisher !== null && !(appUpdatePublisherNames ?? []).includes(publisher)) {
      errors.push(`app-update.yml publisherName ${JSON.stringify(appUpdatePublisherNames)} does not include ${JSON.stringify(publisher)}`);
    }
  }

  const installerReport = report.files.find((file) => file.path === installer.path);
  if (!installerReport) {
    errors.push(`installer ${installer.path} is missing from the verification report`);
  } else if (installerReport.sha512 !== installer.sha512) {
    errors.push(`installer ${installer.path} sha512 differs from the update info; rehash must run after the last byte-changing step`);
  }
  if (errors.length > 0) return { ok: false, errors };

  return validateSigningManifest({
    mode,
    production,
    publisher,
    verifiedAt: report.checkedAt,
    files: report.files.map(({ path, sha512, signed, subject, timestamped }) => ({ path, sha512, signed, subject, timestamped }))
  });
}
