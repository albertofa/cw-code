import { parseDn } from "builder-util-runtime";

export type SigningMode = "signpath" | "unsigned";
export type FileRole = "first-party" | "third-party";

export const FIRST_PARTY_APP_FILES: readonly string[] = ["win-unpacked/cw-code.exe"];
export const ACCEPTED_THIRD_PARTY_STATUSES: readonly string[] = ["NotSigned", "Valid"];

export interface SigningFileRecord {
  path: string;
  role: FileRole;
  sha512: string;
  status: string;
  signed: boolean;
  subject: string | null;
  timestamped: boolean;
}

export interface ReleaseProvenance {
  version: string;
  sourceSha: string;
  runId: string;
}

export interface BlockMapRecord {
  path: string;
  sha512: string;
  size: number;
}

export interface SigningManifest extends ReleaseProvenance {
  mode: SigningMode;
  production: boolean;
  publisher: string | null;
  verifiedAt: string;
  files: SigningFileRecord[];
  blockMap: BlockMapRecord;
}

export interface VerificationFileReport extends SigningFileRecord {
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

export interface PackageInfo extends ReleaseProvenance {
  signingMode: SigningMode;
  production: boolean;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface BuildSigningManifestInput {
  mode: SigningMode;
  production: boolean;
  publisher: string | null;
  expected: ReleaseProvenance;
  packageInfo: PackageInfo;
  report: VerificationReport;
  updateInfo: { installerName: string; sha512: string; version: string };
  appUpdatePublisherNames: string[] | null;
  blockMap: BlockMapRecord;
}

const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const RUN_ID = /^\d+$/;

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

export function isInstallerPath(path: string): boolean {
  return !path.includes("/") && path.toLowerCase().endsWith(".exe");
}

export function roleOf(path: string): FileRole {
  return FIRST_PARTY_APP_FILES.includes(path) || isInstallerPath(path) ? "first-party" : "third-party";
}

export function publisherMatches(subject: string | null, expected: string): boolean {
  if (subject === null || expected.trim() === "") return false;
  const actual = parseDn(subject);
  const wanted = parseDn(expected);
  if (wanted.size > 0) return [...wanted].every(([key, value]) => actual.get(key) === value);
  return actual.get("CN") === expected;
}

function validateProvenance(raw: Record<string, unknown>, errors: string[]): void {
  if (typeof raw.version !== "string" || !VERSION.test(raw.version)) errors.push(`version must be X.Y.Z[-prerelease], got ${JSON.stringify(raw.version)}`);
  if (typeof raw.sourceSha !== "string" || !FULL_SHA.test(raw.sourceSha)) errors.push("sourceSha must be a full lowercase 40-hex commit SHA");
  if (typeof raw.runId !== "string" || !RUN_ID.test(raw.runId)) errors.push("runId must be a numeric string");
}

function validateFileRecord(raw: unknown, index: number, errors: string[]): SigningFileRecord | null {
  const where = `files[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${where} is not an object`);
    return null;
  }
  const { path, role, sha512, status, signed, subject, timestamped } = raw;
  const before = errors.length;
  if (typeof path !== "string" || !isSafeRelativePath(path)) {
    errors.push(`${where}.path must be a relative forward-slash path without "..": ${JSON.stringify(path)}`);
  } else if (role !== roleOf(path)) {
    errors.push(`${where}.role for ${path} must be "${roleOf(path)}", got ${JSON.stringify(role)}`);
  }
  if (typeof sha512 !== "string" || !SHA512_BASE64.test(sha512)) errors.push(`${where}.sha512 must be a base64 SHA-512 digest`);
  if (typeof status !== "string" || status === "") errors.push(`${where}.status must be a non-empty string`);
  if (typeof signed !== "boolean") errors.push(`${where}.signed must be a boolean`);
  if (subject !== null && typeof subject !== "string") errors.push(`${where}.subject must be a string or null`);
  if (typeof timestamped !== "boolean") errors.push(`${where}.timestamped must be a boolean`);
  if (typeof signed === "boolean" && typeof status === "string" && signed !== (status === "Valid")) {
    errors.push(`${where}.signed must be true exactly when status is "Valid"`);
  }
  if (errors.length !== before) return null;
  return {
    path: path as string,
    role: role as FileRole,
    sha512: sha512 as string,
    status: status as string,
    signed: signed as boolean,
    subject: subject as string | null,
    timestamped: timestamped as boolean
  };
}

export function fileRuleErrors(file: SigningFileRecord, firstPartyPublisher: string | null): string[] {
  if (file.role === "first-party" && firstPartyPublisher !== null) {
    const errors: string[] = [];
    if (file.status !== "Valid") errors.push(`${file.path} (first-party) has Authenticode status ${file.status}`);
    if (!file.timestamped) errors.push(`${file.path} (first-party) has no timestamp countersignature`);
    if (!publisherMatches(file.subject, firstPartyPublisher)) {
      errors.push(`${file.path} (first-party) is signed by ${JSON.stringify(file.subject)}, expected publisher ${JSON.stringify(firstPartyPublisher)}`);
    }
    return errors;
  }
  if (!ACCEPTED_THIRD_PARTY_STATUSES.includes(file.status)) {
    return [`${file.path} (${file.role}) has Authenticode status ${file.status}; only NotSigned or Valid is accepted`];
  }
  return [];
}

function firstPartySetErrors(files: SigningFileRecord[]): string[] {
  const errors: string[] = [];
  const paths = new Set(files.map((file) => file.path));
  for (const required of FIRST_PARTY_APP_FILES) {
    if (!paths.has(required)) errors.push(`first-party file ${required} is missing`);
  }
  const installers = files.filter((file) => isInstallerPath(file.path));
  if (installers.length !== 1) errors.push(`expected exactly one top-level installer, found ${installers.length}`);
  return errors;
}

function validateBlockMapRecord(raw: unknown, errors: string[]): BlockMapRecord | null {
  if (!isRecord(raw)) {
    errors.push("blockMap must be an object with path, sha512 and size");
    return null;
  }
  const { path, sha512, size } = raw;
  const before = errors.length;
  if (typeof path !== "string" || !isSafeRelativePath(path) || path.includes("/") || !path.endsWith(".blockmap")) {
    errors.push(`blockMap.path must be a top-level .blockmap file name, got ${JSON.stringify(path)}`);
  }
  if (typeof sha512 !== "string" || !SHA512_BASE64.test(sha512)) errors.push("blockMap.sha512 must be a base64 SHA-512 digest");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) errors.push("blockMap.size must be a positive integer");
  if (errors.length !== before) return null;
  return { path: path as string, sha512: sha512 as string, size: size as number };
}

export function blockMapNameOf(installerPath: string): string {
  return `${installerPath}.blockmap`;
}

export function validateSigningManifest(raw: unknown): Validation<SigningManifest> {
  if (!isRecord(raw)) return { ok: false, errors: ["Signing manifest is not an object"] };
  const errors: string[] = [];
  const { mode, production, publisher, verifiedAt, files } = raw;
  if (mode !== "signpath" && mode !== "unsigned") errors.push(`mode must be "signpath" or "unsigned", got ${JSON.stringify(mode)}`);
  if (typeof production !== "boolean") errors.push("production must be a boolean");
  if (publisher !== null && typeof publisher !== "string") errors.push("publisher must be a string or null");
  if (!isIsoTimestamp(verifiedAt)) errors.push("verifiedAt must be an ISO-8601 timestamp");
  validateProvenance(raw, errors);
  if (!Array.isArray(files) || files.length === 0) errors.push("files must be a non-empty array");
  if (errors.length > 0) return { ok: false, errors };

  const records = (files as unknown[]).map((file, index) => validateFileRecord(file, index, errors));
  const paths = new Set<string>();
  for (const record of records) {
    if (record === null) continue;
    if (paths.has(record.path)) errors.push(`${record.path} is listed more than once`);
    paths.add(record.path);
  }
  const blockMap = validateBlockMapRecord(raw.blockMap, errors);
  if (errors.length > 0 || blockMap === null) return { ok: false, errors };

  const manifest: SigningManifest = {
    mode: mode as SigningMode,
    production: production as boolean,
    publisher: publisher as string | null,
    version: raw.version as string,
    sourceSha: raw.sourceSha as string,
    runId: raw.runId as string,
    verifiedAt: verifiedAt as string,
    files: records.filter((record): record is SigningFileRecord => record !== null),
    blockMap
  };
  if (manifest.mode === "unsigned" && manifest.production) errors.push("unsigned mode can never be production");
  if (manifest.mode === "signpath" && (manifest.publisher === null || manifest.publisher.trim() === "")) {
    errors.push("signpath mode requires a publisher");
  }
  errors.push(...firstPartySetErrors(manifest.files));
  const installer = manifest.files.find((file) => isInstallerPath(file.path));
  if (installer && manifest.blockMap.path !== blockMapNameOf(installer.path)) {
    errors.push(`blockMap.path ${manifest.blockMap.path} must be ${blockMapNameOf(installer.path)}`);
  }
  const firstPartyPublisher = manifest.mode === "signpath" ? manifest.publisher : null;
  for (const file of manifest.files) errors.push(...fileRuleErrors(file, firstPartyPublisher));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: manifest };
}

export function parsePackageInfo(raw: unknown): Validation<PackageInfo> {
  if (!isRecord(raw)) return { ok: false, errors: ["package-info.json is not an object"] };
  const errors: string[] = [];
  validateProvenance(raw, errors);
  if (raw.signingMode !== "signpath" && raw.signingMode !== "unsigned") errors.push("package-info signingMode must be signpath or unsigned");
  if (typeof raw.production !== "boolean") errors.push("package-info production must be a boolean");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: raw.version as string,
      sourceSha: raw.sourceSha as string,
      runId: raw.runId as string,
      signingMode: raw.signingMode as SigningMode,
      production: raw.production as boolean
    }
  };
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
    const { publisherMatches: matches, errors: fileErrors } = file;
    if (typeof matches !== "boolean") errors.push(`files[${index}].publisherMatches must be a boolean`);
    if (!Array.isArray(fileErrors) || !fileErrors.every((entry) => typeof entry === "string")) {
      errors.push(`files[${index}].errors must be an array of strings`);
      return;
    }
    reports.push({ ...record, publisherMatches: matches === true, errors: fileErrors.map(String) });
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

function provenanceErrors(input: BuildSigningManifestInput): string[] {
  const { expected, packageInfo, updateInfo, mode, production } = input;
  const errors: string[] = [];
  for (const key of ["version", "sourceSha", "runId"] as const) {
    if (packageInfo[key] !== expected[key]) {
      errors.push(`package-info.json ${key} ${JSON.stringify(packageInfo[key])} differs from the workflow input ${JSON.stringify(expected[key])}`);
    }
  }
  if (packageInfo.signingMode !== mode) errors.push(`package-info.json signingMode ${packageInfo.signingMode} differs from ${mode}`);
  if (packageInfo.production !== production) errors.push(`package-info.json production ${packageInfo.production} differs from ${production}`);
  if (updateInfo.version !== expected.version) {
    errors.push(`update info version ${updateInfo.version} differs from the release version ${expected.version}`);
  }
  return errors;
}

export function buildSigningManifest(input: BuildSigningManifestInput): Validation<SigningManifest> {
  const { mode, production, report, updateInfo, appUpdatePublisherNames, expected } = input;
  const publisher = input.publisher === null || input.publisher.trim() === "" ? null : input.publisher;
  const errors = provenanceErrors(input);

  if (mode === "unsigned" && production) errors.push("unsigned mode can never be production");
  if (mode === "unsigned" && !report.allowUnsigned) errors.push("unsigned mode expects a report produced with -AllowUnsigned");
  if (!report.ok) errors.push("signature verification failed; see the verification report");
  if (mode === "signpath") {
    if (publisher === null) errors.push("signpath mode requires a publisher");
    if (report.allowUnsigned) errors.push("signpath mode cannot accept a report produced with -AllowUnsigned");
    if (publisher !== null && report.expectedPublisher !== publisher) {
      errors.push(`verification ran against publisher ${JSON.stringify(report.expectedPublisher)}, expected ${JSON.stringify(publisher)}`);
    }
    if (publisher !== null && !(appUpdatePublisherNames ?? []).includes(publisher)) {
      errors.push(`app-update.yml publisherName ${JSON.stringify(appUpdatePublisherNames)} does not include ${JSON.stringify(publisher)}`);
    }
  }

  const installerReport = report.files.find((file) => file.path === updateInfo.installerName);
  if (!installerReport) {
    errors.push(`installer ${updateInfo.installerName} is missing from the verification report`);
  } else if (installerReport.sha512 !== updateInfo.sha512) {
    errors.push(`installer ${updateInfo.installerName} sha512 differs from the update info; rehash must run after the last byte-changing step`);
  }
  if (errors.length > 0) return { ok: false, errors };

  return validateSigningManifest({
    mode,
    production,
    publisher,
    version: expected.version,
    sourceSha: expected.sourceSha,
    runId: expected.runId,
    verifiedAt: report.checkedAt,
    files: report.files.map(({ path, role, sha512, status, signed, subject, timestamped }) => ({ path, role, sha512, status, signed, subject, timestamped })),
    blockMap: input.blockMap
  });
}

export function provenanceMismatches(manifest: ReleaseProvenance, expected: Partial<ReleaseProvenance>): string[] {
  const errors: string[] = [];
  for (const key of ["version", "sourceSha", "runId"] as const) {
    const wanted = expected[key];
    if (wanted !== undefined && manifest[key] !== wanted) {
      errors.push(`signing.json ${key} ${JSON.stringify(manifest[key])} differs from the expected ${JSON.stringify(wanted)}`);
    }
  }
  return errors;
}
