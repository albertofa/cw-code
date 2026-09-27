import { parseUpdateInfo as parseWithElectronUpdater } from "electron-updater/out/providers/Provider.js";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { normalizeReleaseNotes, parseUpdateInfo, readReleaseText, rewriteUpdateInfo, withReleaseText } from "./updateInfoYaml.ts";

const SHA = "OHXwimalg4cncuhddJevvTcG2qq5N6+/fJad/b+Z7hY6FxTYZizn+Mllv3jtU+Esx/CwnOI9H7DQgtS/emIGQQ==";
const LATEST = [
  "version: 1.2.0-alpha.3",
  "files:",
  "  - url: cw-code-Setup-1.2.0-alpha.3-x64.exe",
  `    sha512: ${SHA}`,
  "    size: 104376944",
  "path: cw-code-Setup-1.2.0-alpha.3-x64.exe",
  `sha512: ${SHA}`,
  "releaseDate: '2026-09-25T00:56:11.610Z'",
  ""
].join("\n");

const TRICKY_NOTES = [
  "   ## Features",
  "",
  "- feat: handle `a: b` and 'quotes' \"double\" #hash",
  "- fix: --- not a document marker",
  "  - nested: yes",
  "releaseName: not a key",
  "- trailing spaces   ",
  "\ttab\u0007bell"
].join("\r\n");

describe("release name and notes in the channel files", () => {
  it("round-trips through js-yaml and electron-updater's own parser, so the feed's text wins over the Atom fallback", () => {
    const text = withReleaseText(LATEST, { releaseName: "v1.2.0-alpha.3", releaseNotes: TRICKY_NOTES });
    const expected = normalizeReleaseNotes(TRICKY_NOTES);
    expect(expected).not.toContain("\u0007");
    expect(expected).not.toContain("\r");
    const viaUpdater = parseWithElectronUpdater(text, "alpha.yml", new URL("https://example.invalid/alpha.yml")) as { releaseName?: unknown; releaseNotes?: unknown; version?: unknown };
    expect(viaUpdater).toMatchObject({ version: "1.2.0-alpha.3", releaseName: "v1.2.0-alpha.3", releaseNotes: expected });
    expect(load(text)).toMatchObject({ releaseName: "v1.2.0-alpha.3", releaseNotes: expected });
    expect(readReleaseText(text)).toEqual({ releaseName: "v1.2.0-alpha.3", releaseNotes: expected });
    expect(parseUpdateInfo(text)).toMatchObject({ version: "1.2.0-alpha.3", sha512: SHA });
  });

  it("replaces any release text electron-builder wrote and stays stable when applied twice", () => {
    const withOld = `${LATEST}releaseName: old\nreleaseNotes: |\n  old line\n  another\n`;
    const once = withReleaseText(withOld, { releaseName: "v1.2.0-alpha.3", releaseNotes: "new" });
    expect(once).not.toContain("old");
    expect(withReleaseText(once, { releaseName: "v1.2.0-alpha.3", releaseNotes: "new" })).toBe(once);
    expect(load(once)).toMatchObject({ releaseName: "v1.2.0-alpha.3", releaseNotes: "new" });
  });

  it("writes empty notes as an empty string so clients never fall back to another release", () => {
    const text = withReleaseText(LATEST, { releaseName: "v1.2.0", releaseNotes: "  \n" });
    expect(load(text)).toMatchObject({ releaseName: "v1.2.0", releaseNotes: "" });
    expect(readReleaseText(text).releaseNotes).toBe("");
  });

  it("keeps CRLF files CRLF and survives a later rehash rewrite", () => {
    const crlf = LATEST.replaceAll("\n", "\r\n");
    const text = withReleaseText(crlf, { releaseName: "v1.2.0-alpha.3", releaseNotes: "a\nb" });
    expect(text.split("\r\n").length).toBeGreaterThan(8);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    const rewritten = rewriteUpdateInfo(text, { sha512: SHA.replace("O", "P"), size: 1 });
    expect(readReleaseText(rewritten.text)).toEqual({ releaseName: "v1.2.0-alpha.3", releaseNotes: "a\nb" });
  });
});
