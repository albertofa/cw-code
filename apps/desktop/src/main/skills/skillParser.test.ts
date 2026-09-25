import { describe, expect, it } from "vitest";
import { firstParagraph, parseSkillFile, serializeSkillFile } from "./skillParser.js";

describe("parseSkillFile", () => {
  it("parses frontmatter name and description with the body after the markers", () => {
    const parsed = parseSkillFile(
      "---\nname: my-skill\ndescription: Does things\n---\n\n# Hello\n\nBody text\n",
      "fallback"
    );
    expect(parsed.name).toBe("my-skill");
    expect(parsed.description).toBe("Does things");
    expect(parsed.body).toBe("# Hello\n\nBody text\n");
    expect(parsed.frontmatter).toMatchObject({ name: "my-skill", description: "Does things" });
  });

  it("defaults the name to the directory name when frontmatter has none", () => {
    const parsed = parseSkillFile("---\ndescription: Just a skill\n---\n\nBody\n", "dir-name");
    expect(parsed.name).toBe("dir-name");
    expect(parsed.description).toBe("Just a skill");
  });

  it("falls back to the first paragraph when the description is missing", () => {
    const parsed = parseSkillFile("# Title\n\nFirst paragraph here.\n\nSecond paragraph.\n", "fallback");
    expect(parsed.description).toBe("First paragraph here.");
    expect(parsed.body).toBe("# Title\n\nFirst paragraph here.\n\nSecond paragraph.\n");
    expect(parsed.frontmatter).toEqual({});
  });

  it("treats a file without markers as body-only", () => {
    const parsed = parseSkillFile("\n\nOnly body content.\n", "fallback");
    expect(parsed.name).toBe("fallback");
    expect(parsed.description).toBe("Only body content.");
    expect(parsed.frontmatter).toEqual({});
  });

  it("treats unclosed frontmatter as body-only", () => {
    const raw = "---\nname: oops\n\nBody without closing markers\n";
    const parsed = parseSkillFile(raw, "fallback");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw.replace(/\r\n/g, "\n"));
  });

  it("handles Windows CRLF line endings", () => {
    const parsed = parseSkillFile(
      "---\r\nname: crlf-skill\r\ndescription: CRLF skill\r\n---\r\n\r\nFirst para.\r\n\r\nSecond.\r\n",
      "fallback"
    );
    expect(parsed.name).toBe("crlf-skill");
    expect(parsed.description).toBe("CRLF skill");
    expect(parsed.body).toBe("First para.\n\nSecond.\n");
  });

  it("derives the description from the body with CRLF when frontmatter lacks one", () => {
    const parsed = parseSkillFile("# Title\r\n\r\nCRLF first para.\r\n\r\nMore.\r\n", "fallback");
    expect(parsed.description).toBe("CRLF first para.");
  });

  it("preserves arbitrary extra frontmatter keys verbatim", () => {
    const parsed = parseSkillFile(
      "---\nname: x\ndescription: y\nversion: 1.2.3\nlicense: MIT\n---\n\nBody\n",
      "x"
    );
    expect(parsed.frontmatter).toMatchObject({ version: "1.2.3", license: "MIT" });
  });

  it("round-trips through serializeSkillFile", () => {
    const serialized = serializeSkillFile({ name: "demo", description: "A demo" }, "Body text\n");
    const parsed = parseSkillFile(serialized, "demo");
    expect(parsed.name).toBe("demo");
    expect(parsed.description).toBe("A demo");
    expect(parsed.body).toBe("Body text\n");
  });
});

describe("firstParagraph", () => {
  it("returns an empty string when there is no text", () => {
    expect(firstParagraph("\n\n   \n")).toBe("");
  });
});
