import { describe, expect, it } from "vitest";
import { AUTO_TITLE_TIMEOUT_MS, buildTitlePrompt, sanitizeGeneratedTitle } from "./autoTitle.js";

describe("buildTitlePrompt", () => {
  it("includes the first message", () => {
    const prompt = buildTitlePrompt("Add dark mode to the settings window");
    expect(prompt).toContain("Add dark mode to the settings window");
  });

  it("trims the first message", () => {
    const prompt = buildTitlePrompt("   Fix login redirect   ");
    expect(prompt).toContain("Fix login redirect");
    expect(prompt).not.toContain("   Fix login redirect");
    expect(prompt.endsWith("Fix login redirect")).toBe(true);
  });

  it("truncates the message to 2000 characters", () => {
    const prompt = buildTitlePrompt("x".repeat(3000));
    expect(prompt).toContain("x".repeat(2000));
    expect(prompt).not.toContain("x".repeat(2001));
  });

  it("states the title rules", () => {
    const prompt = buildTitlePrompt("hi");
    expect(prompt).toContain("3-6 words");
    expect(prompt).toContain("no quotes");
    expect(prompt).toContain("no markdown");
    expect(prompt).toContain("no trailing punctuation");
    expect(prompt).toContain("same language as the message");
    expect(prompt).toContain("title only");
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("strips surrounding quotes", () => {
    expect(sanitizeGeneratedTitle('"Fix login redirect"')).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("'Fix login redirect'")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("\u201cFix login redirect\u201d")).toBe("Fix login redirect");
  });

  it("strips markdown noise", () => {
    expect(sanitizeGeneratedTitle("**Fix login redirect**")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("## Fix login redirect")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("- Fix login redirect")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("1. Fix login redirect")).toBe("Fix login redirect");
  });

  it("strips surrounding quotes mixed with markdown", () => {
    expect(sanitizeGeneratedTitle('**"Fix login redirect"**')).toBe("Fix login redirect");
  });

  it("strips trailing punctuation", () => {
    expect(sanitizeGeneratedTitle("Fix login redirect.")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("Fix login redirect:")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("Fix login redirect;")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("Fix login redirect,")).toBe("Fix login redirect");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeGeneratedTitle("Fix    login   redirect")).toBe("Fix login redirect");
  });

  it("caps the title at 60 characters", () => {
    expect(sanitizeGeneratedTitle("a".repeat(80))).toBe("a".repeat(60));
  });

  it("returns an empty string for blank input", () => {
    expect(sanitizeGeneratedTitle("")).toBe("");
    expect(sanitizeGeneratedTitle("   \n\t  ")).toBe("");
    expect(sanitizeGeneratedTitle('""')).toBe("");
    expect(sanitizeGeneratedTitle("...")).toBe("");
  });

  it("keeps the first line when extra lines follow", () => {
    expect(sanitizeGeneratedTitle("Fix login redirect\n\nHere is why the parser treats it that way.")).toBe(
      "Fix login redirect",
    );
    expect(sanitizeGeneratedTitle("Fix login redirect.\r\nMore text.")).toBe("Fix login redirect");
  });

  it("splits on a lone carriage return", () => {
    expect(sanitizeGeneratedTitle("Fix login redirect\rHere is why.")).toBe("Fix login redirect");
  });

  it("strips a trailing hash but keeps internal ones", () => {
    expect(sanitizeGeneratedTitle("Fix login redirect #")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("C# migration")).toBe("C# migration");
  });

  it("skips leading blank lines", () => {
    expect(sanitizeGeneratedTitle("\n  \n Fix login redirect \n")).toBe("Fix login redirect");
  });
});

describe("AUTO_TITLE_TIMEOUT_MS", () => {
  it("is 45 seconds", () => {
    expect(AUTO_TITLE_TIMEOUT_MS).toBe(45_000);
  });
});
