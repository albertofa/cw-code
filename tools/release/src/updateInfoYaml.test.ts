import { describe, expect, it } from "vitest";
import { formatScalar, parseScalar, parseUpdateInfo, readPublisherNames, rewriteUpdateInfo } from "./updateInfoYaml.ts";

const OLD_SHA = "OHXwimalg4cncuhddJevvTcG2qq5N6+/fJad/b+Z7hY6FxTYZizn+Mllv3jtU+Esx/CwnOI9H7DQgtS/emIGQQ==";
const NEW_SHA = "+new/Signed0000000000000000000000000000000000000000000000000000000000000000000000000==";

const LATEST = [
  "version: 0.0.1-alpha.21",
  "files:",
  "  - url: cw-code-Setup-0.0.1-alpha.21-x64.exe",
  `    sha512: ${OLD_SHA}`,
  "    size: 104376944",
  "path: cw-code-Setup-0.0.1-alpha.21-x64.exe",
  `sha512: ${OLD_SHA}`,
  "releaseDate: '2026-09-25T00:56:11.610Z'",
  ""
].join("\n");

const WITH_NOTES = [
  "version: 1.2.0",
  "files:",
  "  - url: cw-code-Setup-1.2.0-x64.exe",
  `    sha512: ${OLD_SHA}`,
  "    size: 10",
  "    isAdminRightsRequired: true",
  "path: cw-code-Setup-1.2.0-x64.exe",
  `sha512: ${OLD_SHA}`,
  "releaseNotes: |-",
  "  ## Fixes",
  "  path: not-a-key.exe",
  "  sha512: not-a-key",
  "releaseDate: '2026-09-25T00:56:11.610Z'",
  ""
].join("\n");

describe("parseScalar / formatScalar", () => {
  it("round-trips plain, single-quoted and double-quoted values", () => {
    expect(parseScalar("abc")).toBe("abc");
    expect(parseScalar("'it''s'")).toBe("it's");
    expect(parseScalar('"a\\"b"')).toBe('a"b');
  });

  it("quotes values YAML would otherwise reinterpret", () => {
    expect(formatScalar(OLD_SHA)).toBe(OLD_SHA);
    expect(formatScalar(NEW_SHA)).toBe(`'${NEW_SHA}'`);
    expect(formatScalar("123")).toBe("'123'");
    expect(formatScalar("true")).toBe("'true'");
    expect(parseScalar(formatScalar(NEW_SHA))).toBe(NEW_SHA);
  });
});

describe("parseUpdateInfo", () => {
  it("reads electron-builder's update info shape", () => {
    expect(parseUpdateInfo(LATEST)).toEqual({
      version: "0.0.1-alpha.21",
      path: "cw-code-Setup-0.0.1-alpha.21-x64.exe",
      sha512: OLD_SHA,
      files: [{ url: "cw-code-Setup-0.0.1-alpha.21-x64.exe", sha512: OLD_SHA, size: 104376944 }]
    });
  });

  it("ignores lookalike keys inside block scalars", () => {
    expect(parseUpdateInfo(WITH_NOTES).path).toBe("cw-code-Setup-1.2.0-x64.exe");
  });

  it("rejects a missing size", () => {
    expect(() => parseUpdateInfo(LATEST.replace("    size: 104376944\n", ""))).toThrow(/missing "size"/);
  });

  it("rejects a path that is not a bare file name", () => {
    const traversal = LATEST.replaceAll("cw-code-Setup-0.0.1-alpha.21-x64.exe", "../evil.exe");
    expect(() => parseUpdateInfo(traversal)).toThrow(/bare file name/);
  });

  it("rejects a files entry that does not match the top-level path", () => {
    expect(() => parseUpdateInfo(LATEST.replace("path: cw-code", "path: other"))).toThrow(/does not match top-level path/);
  });

  it("rejects multiple installers in one update info file", () => {
    const twoFiles = LATEST.replace(
      "path:",
      `  - url: second.exe\n    sha512: ${OLD_SHA}\n    size: 1\npath:`
    );
    expect(() => parseUpdateInfo(twoFiles)).toThrow(/only a single installer/);
  });
});

describe("rewriteUpdateInfo", () => {
  it("is byte-identical when the digest is unchanged", () => {
    const result = rewriteUpdateInfo(LATEST, { sha512: OLD_SHA, size: 104376944 });
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LATEST);
  });

  it("replaces files[].sha512/size and the top-level sha512, keeping everything else", () => {
    const result = rewriteUpdateInfo(WITH_NOTES, { sha512: NEW_SHA, size: 4242 });
    expect(result.changed).toBe(true);
    expect(result.previous).toEqual({ sha512: OLD_SHA, size: 10 });
    const parsed = parseUpdateInfo(result.text);
    expect(parsed.sha512).toBe(NEW_SHA);
    expect(parsed.files).toEqual([{ url: "cw-code-Setup-1.2.0-x64.exe", sha512: NEW_SHA, size: 4242 }]);
    expect(result.text).toContain("    isAdminRightsRequired: true\n");
    expect(result.text).toContain("  path: not-a-key.exe\n  sha512: not-a-key\n");
    expect(result.text).toContain("releaseDate: '2026-09-25T00:56:11.610Z'\n");
    expect(result.text.split("\n")).toHaveLength(WITH_NOTES.split("\n").length);
  });

  it("preserves CRLF line endings", () => {
    const crlf = LATEST.replaceAll("\n", "\r\n");
    const result = rewriteUpdateInfo(crlf, { sha512: NEW_SHA, size: 1 });
    expect(result.text).not.toMatch(/[^\r]\n/);
    expect(parseUpdateInfo(result.text).files[0].size).toBe(1);
  });

  it("rejects an invalid size", () => {
    expect(() => rewriteUpdateInfo(LATEST, { sha512: NEW_SHA, size: -1 })).toThrow(/Invalid installer size/);
  });
});

describe("readPublisherNames", () => {
  it("reads a publisherName list", () => {
    const text = "owner: albertofa\nrepo: cw-code\nprovider: github\npublisherName:\n  - SignPath Foundation\n  - 'Old: Name'\nupdaterCacheDirName: x\n";
    expect(readPublisherNames(text)).toEqual(["SignPath Foundation", "Old: Name"]);
  });

  it("reads an inline publisherName", () => {
    expect(readPublisherNames("publisherName: SignPath Foundation\n")).toEqual(["SignPath Foundation"]);
  });

  it("returns an empty list when publisher verification is not configured", () => {
    expect(readPublisherNames("owner: albertofa\nprovider: github\n")).toEqual([]);
  });
});
