import { describe, expect, it } from "bun:test";
import { resolveRevealPath } from "./revealPath.js";

const FILES = [
  "apps/desktop/src/renderer/src/editor/languages.ts",
  "apps/desktop/src/renderer/src/editor/languages.test.ts",
  "apps/desktop/src/main/index.ts",
  "packages/contracts/src/index.ts",
  "README.md"
];

describe("resolveRevealPath", () => {
  it("keeps an exact workspace path", () => {
    expect(resolveRevealPath("README.md", FILES)).toEqual({ kind: "unique", path: "README.md" });
  });

  it("resolves a bare file name to its only match", () => {
    expect(resolveRevealPath("languages.ts", FILES)).toEqual({ kind: "unique", path: "apps/desktop/src/renderer/src/editor/languages.ts" });
  });

  it("resolves a partial path by its segment suffix", () => {
    expect(resolveRevealPath("editor/languages.ts", FILES)).toEqual({ kind: "unique", path: "apps/desktop/src/renderer/src/editor/languages.ts" });
    expect(resolveRevealPath("main/index.ts", FILES)).toEqual({ kind: "unique", path: "apps/desktop/src/main/index.ts" });
  });

  it("does not match partial segment names", () => {
    expect(resolveRevealPath("ages.ts", FILES)).toEqual({ kind: "none" });
  });

  it("normalizes backslashes, ./ prefixes and case", () => {
    expect(resolveRevealPath(".\\Editor\\Languages.ts", FILES)).toEqual({ kind: "unique", path: "apps/desktop/src/renderer/src/editor/languages.ts" });
  });

  it("falls back to the file name when the directories are wrong", () => {
    expect(resolveRevealPath("src/wrong/languages.ts", FILES)).toEqual({ kind: "unique", path: "apps/desktop/src/renderer/src/editor/languages.ts" });
  });

  it("reports ambiguous names with the shortest paths first", () => {
    expect(resolveRevealPath("index.ts", FILES)).toEqual({
      kind: "ambiguous",
      candidates: ["apps/desktop/src/main/index.ts", "packages/contracts/src/index.ts"]
    });
  });

  it("reports when nothing matches", () => {
    expect(resolveRevealPath("missing.ts", FILES)).toEqual({ kind: "none" });
    expect(resolveRevealPath("  ", FILES)).toEqual({ kind: "none" });
  });
});
