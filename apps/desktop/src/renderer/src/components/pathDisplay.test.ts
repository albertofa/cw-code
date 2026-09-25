import { describe, expect, it } from "vitest";
import { expandHome, formatFileSubject, looksLikeFileMention, shortenHome, shortenHomeInText, stripMentionMarker } from "./pathDisplay.js";

describe("shortenHome", () => {
  it("shortens posix home prefixes to ~/", () => {
    expect(shortenHome("/home/tester", "/home/tester")).toBe("~");
    expect(shortenHome("/home/tester/projects/cw", "/home/tester")).toBe("~/projects/cw");
  });

  it("leaves paths outside home untouched", () => {
    expect(shortenHome("/home/tester2/projects", "/home/tester")).toBe("/home/tester2/projects");
    expect(shortenHome("/other/place", "/home/tester")).toBe("/other/place");
  });

  it("shortens Windows user-profile prefixes case-insensitively", () => {
    expect(shortenHome("C:\\Users\\tester", "C:\\Users\\tester")).toBe("~");
    expect(shortenHome("C:\\Users\\tester\\Projects\\cw", "C:\\Users\\tester")).toBe("~/Projects/cw");
    expect(shortenHome("c:\\users\\tester\\Projects", "C:\\Users\\tester")).toBe("~/Projects");
  });

  it("does not match sibling profile names", () => {
    expect(shortenHome("C:\\Users\\tester2\\proj", "C:\\Users\\tester")).toBe("C:\\Users\\tester2\\proj");
  });

  it("keeps already-shortened input shortened", () => {
    expect(shortenHome("~", "/home/tester")).toBe("~");
    expect(shortenHome("~/projects", "/home/tester")).toBe("~/projects");
  });

  it("returns input when home is unknown", () => {
    expect(shortenHome("/home/tester/x", "")).toBe("/home/tester/x");
    expect(shortenHome("/home/tester/x")).toBe("/home/tester/x");
  });
});

describe("expandHome", () => {
  it("expands ~/ against the given home dir", () => {
    expect(expandHome("~/skills", "/home/tester")).toBe("/home/tester/skills");
    expect(expandHome("~", "/home/tester")).toBe("/home/tester");
  });
});

describe("formatFileSubject", () => {
  it("prefers the project-relative path", () => {
    expect(formatFileSubject("/proj/src/a.ts", "/proj", "/home/tester")).toBe("src/a.ts");
    expect(formatFileSubject("C:\\proj\\src\\a.ts", "C:\\proj", "C:\\Users\\tester")).toBe("src/a.ts");
  });

  it("strips the @ attachment marker", () => {
    expect(formatFileSubject("@.cw/pastes/x.png", "/proj", "/home/tester")).toBe(".cw/pastes/x.png");
  });

  it("falls back to ~/ when outside the project base", () => {
    expect(formatFileSubject("/home/tester/docs/a.md", "/proj", "/home/tester")).toBe("~/docs/a.md");
    expect(formatFileSubject("C:\\Users\\tester\\docs\\a.md", "C:\\proj", "C:\\Users\\tester")).toBe("~/docs/a.md");
  });

  it("returns the plain path when neither base nor home matches", () => {
    expect(formatFileSubject("@/other/x.png", "/proj", "/home/tester")).toBe("/other/x.png");
    expect(formatFileSubject("rel/path.ts", "/proj", "/home/tester")).toBe("rel/path.ts");
  });
});

describe("shortenHomeInText", () => {
  it("replaces home-absolute paths inside longer text", () => {
    expect(shortenHomeInText("read /home/tester/docs/a.md now", "/home/tester")).toBe("read ~/docs/a.md now");
    expect(shortenHomeInText("run C:\\Users\\tester\\bin\\x", "C:\\Users\\tester")).toBe("run ~/bin/x");
  });

  it("leaves sibling names alone", () => {
    expect(shortenHomeInText("/home/tester2/x", "/home/tester")).toBe("/home/tester2/x");
  });
});

describe("looksLikeFileMention", () => {
  it("matches @-mentions and bare paths without whitespace", () => {
    expect(looksLikeFileMention("@.cw/pastes/x.png")).toBe(true);
    expect(looksLikeFileMention("C:\\Users\\tester\\docs\\a.md")).toBe(true);
    expect(looksLikeFileMention(".cw/pastes/x.png")).toBe(true);
  });

  it("rejects sentences and bare words", () => {
    expect(looksLikeFileMention("Asked 2 questions")).toBe(false);
    expect(looksLikeFileMention("@someone")).toBe(false);
    expect(looksLikeFileMention("")).toBe(false);
  });
});
