import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BuildSigningManifestInput,
  type VerificationFileReport,
  type VerificationReport,
  buildSigningManifest,
  parseDistinguishedName,
  parseVerificationReport,
  publisherMatches,
  validateSigningManifest
} from "./signingManifest.ts";

const PUBLISHER = "SignPath Foundation";
const SUBJECT = 'CN=SignPath Foundation, O="SignPath Foundation, Inc.", L=Lewes, S=Delaware, C=US';
const INSTALLER = "cw-code-Setup-1.2.0-x64.exe";

function sha(label: string): string {
  return createHash("sha512").update(label).digest("base64");
}

function signedFile(path: string, overrides: Partial<VerificationFileReport> = {}): VerificationFileReport {
  return { path, sha512: sha(path), signed: true, subject: SUBJECT, timestamped: true, status: "Valid", publisherMatches: true, errors: [], ...overrides };
}

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    expectedPublisher: PUBLISHER,
    allowUnsigned: false,
    ok: true,
    checkedAt: "2026-09-25T01:00:00.000Z",
    files: [signedFile("win-unpacked/cw-code.exe"), signedFile(INSTALLER)],
    ...overrides
  };
}

function signedInput(overrides: Partial<BuildSigningManifestInput> = {}): BuildSigningManifestInput {
  return {
    mode: "signpath",
    production: true,
    publisher: PUBLISHER,
    report: report(),
    installer: { path: INSTALLER, sha512: sha(INSTALLER) },
    appUpdatePublisherNames: [PUBLISHER],
    ...overrides
  };
}

function errorsOf<T>(result: { ok: true; value: T } | { ok: false; errors: string[] }): string {
  return result.ok ? "" : result.errors.join("\n");
}

describe("publisher matching", () => {
  it("parses quoted RDN values containing commas", () => {
    expect(parseDistinguishedName(SUBJECT).get("O")).toBe("SignPath Foundation, Inc.");
  });

  it("matches a bare name against the subject CN and a DN against every given RDN", () => {
    expect(publisherMatches(SUBJECT, PUBLISHER)).toBe(true);
    expect(publisherMatches(SUBJECT, "CN=SignPath Foundation, C=US")).toBe(true);
    expect(publisherMatches(SUBJECT, "CN=SignPath Foundation, C=DE")).toBe(false);
    expect(publisherMatches(SUBJECT, "Other Publisher")).toBe(false);
    expect(publisherMatches(null, PUBLISHER)).toBe(false);
  });
});

describe("buildSigningManifest", () => {
  it("builds a production manifest from a passing signed verification", () => {
    const result = buildSigningManifest(signedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      mode: "signpath",
      production: true,
      publisher: PUBLISHER,
      verifiedAt: "2026-09-25T01:00:00.000Z",
      files: [
        { path: "win-unpacked/cw-code.exe", sha512: sha("win-unpacked/cw-code.exe"), signed: true, subject: SUBJECT, timestamped: true },
        { path: INSTALLER, sha512: sha(INSTALLER), signed: true, subject: SUBJECT, timestamped: true }
      ]
    });
  });

  it("rejects unsigned mode marked as production", () => {
    const result = buildSigningManifest(signedInput({ mode: "unsigned", production: true, report: report({ allowUnsigned: true }) }));
    expect(errorsOf(result)).toMatch(/unsigned mode can never be production/);
  });

  it("accepts an explicit non-production unsigned manifest", () => {
    const files = [signedFile(INSTALLER, { signed: false, subject: null, timestamped: false, status: "NotSigned", publisherMatches: false })];
    const result = buildSigningManifest(
      signedInput({ mode: "unsigned", production: false, publisher: null, appUpdatePublisherNames: null, report: report({ allowUnsigned: true, ok: false, expectedPublisher: null, files }) })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ mode: "unsigned", production: false, publisher: null });
  });

  it("rejects a signpath manifest without a publisher", () => {
    expect(errorsOf(buildSigningManifest(signedInput({ publisher: "" })))).toMatch(/requires a publisher/);
  });

  it("rejects a failed verification report", () => {
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ ok: false }) })))).toMatch(/verification failed/);
  });

  it("rejects a report produced with -AllowUnsigned in signpath mode", () => {
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ allowUnsigned: true }) })))).toMatch(/-AllowUnsigned/);
  });

  it("rejects a missing timestamp even if the report claims success", () => {
    const files = [signedFile("win-unpacked/cw-code.exe", { timestamped: false }), signedFile(INSTALLER)];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/cw-code.exe has no trusted timestamp/);
  });

  it("rejects an unexpected publisher even if the report claims success", () => {
    const files = [signedFile("win-unpacked/cw-code.exe", { subject: "CN=Someone Else" }), signedFile(INSTALLER)];
    expect(errorsOf(buildSigningManifest(signedInput({ report: report({ files }) })))).toMatch(/expected publisher/);
  });

  it("rejects an app-update.yml without the publisher name", () => {
    expect(errorsOf(buildSigningManifest(signedInput({ appUpdatePublisherNames: [] })))).toMatch(/app-update.yml publisherName/);
    expect(errorsOf(buildSigningManifest(signedInput({ appUpdatePublisherNames: null })))).toMatch(/app-update.yml publisherName/);
  });

  it("rejects an installer whose hash differs from the update info", () => {
    const result = buildSigningManifest(signedInput({ installer: { path: INSTALLER, sha512: sha("stale") } }));
    expect(errorsOf(result)).toMatch(/rehash must run after the last byte-changing step/);
  });

  it("rejects an installer missing from the report", () => {
    const result = buildSigningManifest(signedInput({ installer: { path: "other.exe", sha512: sha("other.exe") } }));
    expect(errorsOf(result)).toMatch(/missing from the verification report/);
  });
});

describe("validateSigningManifest", () => {
  const valid = {
    mode: "signpath",
    production: true,
    publisher: PUBLISHER,
    verifiedAt: "2026-09-25T01:00:00.000Z",
    files: [{ path: INSTALLER, sha512: sha(INSTALLER), signed: true, subject: SUBJECT, timestamped: true }]
  };

  it("accepts a valid signed production manifest", () => {
    expect(validateSigningManifest(valid).ok).toBe(true);
  });

  it("rejects production unsigned manifests", () => {
    expect(errorsOf(validateSigningManifest({ ...valid, mode: "unsigned", publisher: null }))).toMatch(/never be production/);
  });

  it("rejects a signed manifest with a missing timestamp", () => {
    const files = [{ ...valid.files[0], timestamped: false }];
    expect(errorsOf(validateSigningManifest({ ...valid, files }))).toMatch(/no trusted timestamp/);
  });

  it("rejects unsigned files in signpath mode", () => {
    const files = [{ ...valid.files[0], signed: false, subject: null }];
    expect(errorsOf(validateSigningManifest({ ...valid, files }))).toMatch(/is not signed/);
  });

  it("rejects malformed shapes, unsafe paths, bad digests and duplicates", () => {
    expect(errorsOf(validateSigningManifest(null))).toMatch(/not an object/);
    expect(errorsOf(validateSigningManifest({ ...valid, mode: "azure" }))).toMatch(/mode must be/);
    expect(errorsOf(validateSigningManifest({ ...valid, files: [] }))).toMatch(/non-empty/);
    expect(errorsOf(validateSigningManifest({ ...valid, verifiedAt: "yesterday" }))).toMatch(/verifiedAt/);
    expect(errorsOf(validateSigningManifest({ ...valid, files: [{ ...valid.files[0], path: "../x.exe" }] }))).toMatch(/relative/);
    expect(errorsOf(validateSigningManifest({ ...valid, files: [{ ...valid.files[0], path: "C:/x.exe" }] }))).toMatch(/relative/);
    expect(errorsOf(validateSigningManifest({ ...valid, files: [{ ...valid.files[0], sha512: "abc" }] }))).toMatch(/SHA-512/);
    expect(errorsOf(validateSigningManifest({ ...valid, files: [valid.files[0], valid.files[0]] }))).toMatch(/more than once/);
  });
});

describe("parseVerificationReport", () => {
  it("round-trips a report", () => {
    const raw: unknown = JSON.parse(JSON.stringify(report()));
    const result = parseVerificationReport(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(report());
  });

  it("rejects malformed reports", () => {
    expect(errorsOf(parseVerificationReport({ ...report(), ok: "yes" }))).toMatch(/ok must be a boolean/);
    expect(errorsOf(parseVerificationReport({ ...report(), files: [{ ...signedFile(INSTALLER), errors: [1] }] }))).toMatch(/errors must be an array of strings/);
  });
});
