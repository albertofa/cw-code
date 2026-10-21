import { describe, expect, it } from "vitest";
import { diffLines, splitLines } from "./lineDiff.js";

const lines = (text: string) => text.split("");

describe("diffLines", () => {
  it("reports nothing for identical content", () => {
    expect(diffLines(lines("abc"), lines("abc"))).toEqual([]);
  });

  it("marks lines appended at the end as added", () => {
    expect(diffLines(lines("ab"), lines("abcd"))).toEqual([{ kind: "added", from: 3, to: 4 }]);
  });

  it("marks lines inserted in the middle as added", () => {
    expect(diffLines(lines("abef"), lines("abcdef"))).toEqual([{ kind: "added", from: 3, to: 4 }]);
  });

  it("marks a deletion at the boundary after the remaining line", () => {
    expect(diffLines(lines("abcd"), lines("ad"))).toEqual([{ kind: "deleted", from: 1, to: 1 }]);
  });

  it("marks a deletion at the top of the file as line 0", () => {
    expect(diffLines(lines("abc"), lines("c"))).toEqual([{ kind: "deleted", from: 0, to: 0 }]);
  });

  it("marks replaced lines as modified", () => {
    expect(diffLines(lines("abc"), lines("aXc"))).toEqual([{ kind: "modified", from: 2, to: 2 }]);
  });

  it("reports separate hunks for separate edits", () => {
    expect(diffLines(lines("abcdefgh"), lines("aXcdfghY"))).toEqual([
      { kind: "modified", from: 2, to: 2 },
      { kind: "deleted", from: 4, to: 4 },
      { kind: "added", from: 8, to: 8 }
    ]);
  });

  it("handles a file that was emptied or filled", () => {
    expect(diffLines([], lines("ab"))).toEqual([{ kind: "added", from: 1, to: 2 }]);
    expect(diffLines(lines("ab"), [])).toEqual([{ kind: "deleted", from: 0, to: 0 }]);
  });

  it("matches the export block added to the contracts index", () => {
    const base = splitLines('export type { A } from "./a.js";\nexport type { N } from "./n.js";\n');
    const current = splitLines('export type { A } from "./a.js";\nexport type {\n  DirEntry,\n  FsChangeEvent\n} from "./files.js";\nexport type { N } from "./n.js";\n');
    expect(diffLines(base, current)).toEqual([{ kind: "added", from: 2, to: 5 }]);
  });

  it("stays fast on large files with scattered edits", () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const current = base.map((line, i) => (i % 500 === 0 ? `${line} changed` : line));
    const started = performance.now();
    const changes = diffLines(base, current);
    expect(performance.now() - started).toBeLessThan(500);
    expect(changes).toHaveLength(40);
    expect(changes.every((change) => change.kind === "modified")).toBe(true);
  });
});

describe("splitLines", () => {
  it("splits on every line ending style", () => {
    expect(splitLines("a\r\nb\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });
});
