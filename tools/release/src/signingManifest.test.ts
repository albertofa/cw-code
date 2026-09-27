import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BuildSigningManifestInput,
  type SigningManifest,
  type VerificationFileReport,
  type VerificationReport,
  buildSigningManifest,
  parsePackageInfo,
  parseVerificationReport,
  publisherMatches,
  roleOf,
  validateSigningManifest
} from "./signingManifest.ts";

const PUBLISHER = "SignPath Foundation";
const SUBJECT = 'CN=SignPath Foundation, O="SignPath Foundation, Inc.", L=Lewes, S=Delaware, C=US';
const MICROSOFT = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const INSTALLER = "cw-code-Setup-1.2.0-x64.exe";
const APP_EXE = "win-unpacked/cw-code.exe";
const FFMPEG = "win-unpacked/ffmpeg.dll";
const CONPTY = "win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll";
const PROVENANCE = { version: "1.2.0", sourceSha: "a".repeat(40), runId: "123456" };

function sha(label: string): string {
  return createHash("sha512").update(label).digest("base64");
}

function file(path: string, overrides: Partial<VerificationFileReport> = {}): VerificationFileReport {
  const firstParty = roleOf(path) === "first-party";
  return {
    path,
    role: roleOf(path),
    sha512: sha(path),
    status: firstParty ? "Valid" : "NotSigned",
    signed: firstParty,
    subject: firstParty ? SUBJECT : null,
    timestamped: firstParty,
    publisherMatches: firstParty,
    errors: [],
    ...overrides
  };
}

const MICROSOFT_SIGNED: Partial<VerificationFileReport> = { status: "Valid", signed: true, subject: MICROSOFT, timestamped: true };

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    expectedPublisher: PUBLISHER,
    allowUnsigned: false,
    ok: true,
    checkedAt: "2026-09-25T01:00:00.000Z",
    files: [file(APP_EXE), file(FFMPEG), file(CONPTY, MICROSOFT_SIGNED), file(INSTALLER)],
    ...overrides
  };
}

function signedInput(overrides: Partial<BuildSigningManifestInput> = {}): BuildSigningManifestInput {
  return {
    mode: "signpath",
    production: true,
    publisher: PUBLISHER,
    expected: PROVENANCE,
    packageInfo: { ...PROVENANCE, signingMode: "signpath", production: true },
    report: report(),
    updateInfo: { installerName: INSTALLER, sha512: sha(INSTALLER), version: "1.2.0" },
    appUpdatePublisherNames: [PUBLISHER],
    ...overrides
  };
}

function errorsOf<T>(result: { ok: true; value: T } | { ok: false; errors: string[] }): string {
  return result.ok ? "" : result.errors.join("\n");
}

function manifest(): SigningManifest {
  const result = buildSigningManifest(signedInput());
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

describe("roles", () => {
  it("treats only cw-code.exe and the top-level installer as first-party", () => {
    expect(roleOf(APP_EXE)).toBe("first-party");
    expect(roleOf(INSTALLER)).toBe("first-party");
    expect(roleOf(FFMPEG)).toBe("third-party");
    expect(roleOf("win-unpacked/resources/elevate.exe")).toBe("third-party");
    expect(roleOf("win-unpacked/nested/cw-code.exe")).toBe("third-party");
  });
});

describe("publisherMatches (electron-updater semantics via builder-util-runtime parseDn)", () => {
  it("compares a bare name with the CN", () => {
    expect(publisherMatches(SUBJECT, PUBLISHER)).toBe(true);
    expect(publisherMatches(SUBJECT, "Other Publisher")).toBe(false);
    expect(publisherMatches(null, PUBLISHER)).toBe(false);
  });

  it("requires every RDN of a DN to match, including quoted values with commas", () => {
    expect(publisherMatches(SUBJECT, 'CN=SignPath Foundation, O="SignPath Foundation, Inc."')).toBe(true);
    expect(publisherMatches(SUBJECT, "CN=SignPath Foundation, C=DE")).toBe(false);
  });
});

describe("buildSigningManifest", () => {
  it("records role, status and provenance for every file", () => {
    const value = manifest();
    expect(value).toMatchObject({ mode: "signpath", production: true, publisher: PUBLISHER, ...PROVENANCE, verifiedAt: "2026-09-25T01:00:00.000Z" });
    expect(value.files.map((entry) => [entry.path, entry.role, entry.status])).toEqual([
      [APP_EXE, "first-party", "Valid"],
      [FFMPEG, "third-party", "NotSigned"],
      [CONPTY, "third-party", "Valid"],
      [INSTALLER, "first-party", "Valid"]
    ]);
  });

  it("rejects unsigned mode marked as production", () => {
    const result = buildSigningManifest(
      signedInput({ mode: "unsigned", production: true, packageInfo: { ...PROVENANCE, signingMode: "unsigned", production: true }, report: report({ allowUnsigned: true }) })
    );
    expect(errorsOf(result)).toMatch(/unsigned mode can never be production/);
  });

  it("accepts an explicit non-production unsigned manifest with unsigned first-party files", () => {
    const unsigned: Partial<VerificationFileReport> = { status: "NotSigned", signed: false, subject: null, timestamped: false, publisherMatches: false };
    const result = buildSigningManifest(
      signedInput({
        mode: "unsigned",
        production: false,
        publisher: null,
        appUpdatePublisherNames: null,
        packageInfo: { ...PROVENANCE, signingMode: "unsigned", production: false },
        report: report({ allowUnsigned: true, expectedPublisher: null, files: [file(APP_EXE, unsigned), file(FFMPEG), file(INSTALLER, unsigned)] })
      })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a first-party file without a timestamp even if the report claims success", () => {
    const files = [file(APP_EXE, { timestamped: false }), file(FFMPEG), file(INSTALLER)];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/cw-code.exe \(first-party\) has no timestamp/);
  });

  it("rejects a first-party file signed by another publisher", () => {
    const files = [file(APP_EXE, { subject: MICROSOFT }), file(FFMPEG), file(INSTALLER)];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/expected publisher/);
  });

  it("rejects an unsigned first-party installer", () => {
    const files = [file(APP_EXE), file(INSTALLER, { status: "NotSigned", signed: false, subject: null, timestamped: false })];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/cw-code-Setup-1.2.0-x64.exe \(first-party\) has Authenticode status NotSigned/);
  });

  it("rejects a third-party file whose signature is no longer trusted", () => {
    const files = [file(APP_EXE), file(CONPTY, { ...MICROSOFT_SIGNED, status: "NotTrusted", signed: false }), file(INSTALLER)];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/conpty.dll \(third-party\) has Authenticode status NotTrusted/);
  });

  it("rejects a missing first-party app file", () => {
    const files = [file(FFMPEG), file(INSTALLER)];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/first-party file win-unpacked\/cw-code.exe is missing/);
  });

  it("rejects a failed or -AllowUnsigned report in signpath mode", () => {
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ ok: false }) })))).toMatch(/verification failed/);
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ allowUnsigned: true }) })))).toMatch(/-AllowUnsigned/);
  });

  it("rejects an app-update.yml without the publisher name", () => {
    expect(errorsOf(buildSigningManifest(signedInput({ appUpdatePublisherNames: [] })))).toMatch(/app-update.yml publisherName/);
  });

  it("rejects an installer whose hash differs from the update info", () => {
    const result = buildSigningManifest(signedInput({ updateInfo: { installerName: INSTALLER, sha512: sha("stale"), version: "1.2.0" } }));
    expect(errorsOf(result)).toMatch(/rehash must run after the last byte-changing step/);
  });

  it("rejects provenance that differs from the workflow inputs or the update info", () => {
    const packageInfo = { ...PROVENANCE, sourceSha: "b".repeat(40), signingMode: "signpath" as const, production: true };
    expect(errorsOf(buildSigningManifest(signedInput({ packageInfo })))).toMatch(/package-info.json sourceSha/);
    const updateInfo = { installerName: INSTALLER, sha512: sha(INSTALLER), version: "1.1.0" };
    expect(errorsOf(buildSigningManifest(signedInput({ updateInfo })))).toMatch(/update info version 1.1.0/);
  });
});

describe("validateSigningManifest", () => {
  it("accepts a built manifest after a JSON round trip", () => {
    expect(validateSigningManifest(JSON.parse(JSON.stringify(manifest()))).ok).toBe(true);
  });

  it("rejects production unsigned manifests", () => {
    expect(errorsOf(validateSigningManifest({ ...manifest(), mode: "unsigned" }))).toMatch(/never be production/);
  });

  it("rejects a relabelled role", () => {
    const value = manifest();
    const files = value.files.map((entry) => (entry.path === APP_EXE ? { ...entry, role: "third-party" } : entry));
    expect(errorsOf(validateSigningManifest({ ...value, files }))).toMatch(/role for win-unpacked\/cw-code.exe must be "first-party"/);
  });

  it("rejects a missing timestamp on a first-party file", () => {
    const value = manifest();
    const files = value.files.map((entry) => (entry.path === INSTALLER ? { ...entry, timestamped: false } : entry));
    expect(errorsOf(validateSigningManifest({ ...value, files }))).toMatch(/has no timestamp countersignature/);
  });

  it("rejects signed flags that contradict the status", () => {
    const value = manifest();
    const files = value.files.map((entry) => (entry.path === FFMPEG ? { ...entry, signed: true } : entry));
    expect(errorsOf(validateSigningManifest({ ...value, files }))).toMatch(/signed must be true exactly when status is "Valid"/);
  });

  it("rejects two installers", () => {
    const value = manifest();
    const files = [...value.files, { ...value.files[3], path: "other-Setup.exe", sha512: sha("other") }];
    expect(errorsOf(validateSigningManifest({ ...value, files }))).toMatch(/exactly one top-level installer, found 2/);
  });

  it("rejects malformed shapes, provenance, unsafe paths, bad digests and duplicates", () => {
    const value = manifest();
    expect(errorsOf(validateSigningManifest(null))).toMatch(/not an object/);
    expect(errorsOf(validateSigningManifest({ ...value, mode: "azure" }))).toMatch(/mode must be/);
    expect(errorsOf(validateSigningManifest({ ...value, sourceSha: "abc" }))).toMatch(/sourceSha/);
    expect(errorsOf(validateSigningManifest({ ...value, runId: 12 }))).toMatch(/runId/);
    expect(errorsOf(validateSigningManifest({ ...value, files: [] }))).toMatch(/non-empty/);
    expect(errorsOf(validateSigningManifest({ ...value, verifiedAt: "yesterday" }))).toMatch(/verifiedAt/);
    expect(errorsOf(validateSigningManifest({ ...value, files: [{ ...value.files[1], path: "../x.dll" }] }))).toMatch(/relative/);
    expect(errorsOf(validateSigningManifest({ ...value, files: [{ ...value.files[1], sha512: "abc" }] }))).toMatch(/SHA-512/);
    expect(errorsOf(validateSigningManifest({ ...value, files: [...value.files, value.files[1]] }))).toMatch(/more than once/);
  });
});

describe("parsers", () => {
  it("round-trips a verification report", () => {
    const result = parseVerificationReport(JSON.parse(JSON.stringify(report())));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(report());
  });

  it("rejects malformed verification reports", () => {
    expect(errorsOf(parseVerificationReport({ ...report(), ok: "yes" }))).toMatch(/ok must be a boolean/);
    expect(errorsOf(parseVerificationReport({ ...report(), files: [{ ...file(INSTALLER), errors: [1] }] }))).toMatch(/errors must be an array of strings/);
  });

  it("parses package-info.json and rejects bad provenance", () => {
    expect(parsePackageInfo({ ...PROVENANCE, signingMode: "signpath", production: true }).ok).toBe(true);
    expect(errorsOf(parsePackageInfo({ ...PROVENANCE, signingMode: "signpath", production: "yes" }))).toMatch(/production/);
    expect(errorsOf(parsePackageInfo({ ...PROVENANCE, version: "", signingMode: "unsigned", production: false }))).toMatch(/version/);
  });
});
