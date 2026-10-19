import { describe, expect, it } from "vitest";
import {
  detectSkillTrigger,
  findSkillMentions,
  hasSkillCandidate,
  insertSkillMention,
  insertSkillTrigger,
  isSkillMentionList,
  skillInvocation,
  skillMentionNames
} from "./skillMentions.js";

const KNOWN = new Set(["plan", "debug", "ndk:plan", "code-review"]);

describe("findSkillMentions", () => {
  it("finds known mentions at the start, mid-text and after newlines", () => {
    const text = "$plan this\nthen $debug it";
    expect(findSkillMentions(text, KNOWN)).toEqual([
      { name: "plan", start: 0, end: 5 },
      { name: "debug", start: 16, end: 22 }
    ]);
  });

  it("ignores unknown names, money, shell variables and glued dollars", () => {
    expect(findSkillMentions("costs $5 or $20k, see $HOME and US$plan", KNOWN)).toEqual([]);
  });

  it("accepts trailing punctuation and trims trailing separators", () => {
    expect(skillMentionNames("use $plan. then $debug: now ($code-review)", KNOWN)).toEqual(["plan", "debug"]);
    expect(skillMentionNames("try $code-review, ok", KNOWN)).toEqual(["code-review"]);
  });

  it("keeps namespaced names whole", () => {
    expect(skillMentionNames("run $ndk:plan now", KNOWN)).toEqual(["ndk:plan"]);
  });

  it("rejects a mention glued to more name characters", () => {
    expect(findSkillMentions("$planner and $plan/x", KNOWN)).toEqual([]);
  });

  it("skips mentions inside inline code and fences", () => {
    const text = "echo `$plan` and\n```\n$debug\n```\nbut $debug";
    expect(findSkillMentions(text, KNOWN).map((m) => m.start)).toEqual([text.lastIndexOf("$debug")]);
  });

  it("dedupes names in first-mention order", () => {
    expect(skillMentionNames("$debug $plan $debug", KNOWN)).toEqual(["debug", "plan"]);
  });

  it("returns nothing when no skills are known", () => {
    expect(findSkillMentions("$plan", new Set())).toEqual([]);
  });
});

describe("hasSkillCandidate", () => {
  it("flags name-like tokens but not money", () => {
    expect(hasSkillCandidate("pay $5 now")).toBe(false);
    expect(hasSkillCandidate("pay $20k now")).toBe(false);
    expect(hasSkillCandidate("run $plan")).toBe(true);
  });

  it("ignores candidates inside code", () => {
    expect(hasSkillCandidate("check `$HOME` and\n```\necho $PATH\n```")).toBe(false);
  });
});

describe("skillMentionNames cap", () => {
  it("never returns more names than the main process accepts", () => {
    const names = Array.from({ length: 40 }, (_, i) => `s${i}`);
    const text = names.map((name) => `$${name}`).join(" ");
    const mentioned = skillMentionNames(text, new Set(names));
    expect(mentioned).toHaveLength(32);
    expect(isSkillMentionList(mentioned)).toBe(true);
  });
});

describe("detectSkillTrigger", () => {
  it("opens on a bare dollar at the start or after whitespace", () => {
    expect(detectSkillTrigger("$", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(detectSkillTrigger("fix it $de", 10)).toEqual({ start: 7, end: 10, query: "de" });
    expect(detectSkillTrigger("line\n$p", 7)).toEqual({ start: 5, end: 7, query: "p" });
  });

  it("covers the rest of the token after the caret", () => {
    expect(detectSkillTrigger("$plan now", 3)).toEqual({ start: 0, end: 5, query: "pl" });
  });

  it("stays closed for money, glued dollars, closed tokens and a caret before the dollar", () => {
    expect(detectSkillTrigger("pay $5", 6)).toBeNull();
    expect(detectSkillTrigger("pay $1e6", 8)).toBeNull();
    expect(detectSkillTrigger("US$pl", 5)).toBeNull();
    expect(detectSkillTrigger("$plan ", 6)).toBeNull();
    expect(detectSkillTrigger("$5.00", 5)).toBeNull();
    expect(detectSkillTrigger("x $plan", 2)).toBeNull();
  });

  it("stays closed inside inline code", () => {
    expect(detectSkillTrigger("`$pl", 4)).toBeNull();
    expect(detectSkillTrigger("`echo $pl`", 9)).toBeNull();
  });
});

describe("insertSkillMention", () => {
  it("replaces the token and adds a trailing space", () => {
    const trigger = detectSkillTrigger("fix $de", 7)!;
    expect(insertSkillMention("fix $de", trigger, "debug")).toEqual({ text: "fix $debug ", caret: 11 });
  });

  it("reuses existing whitespace after the token", () => {
    const trigger = detectSkillTrigger("$pl rest", 3)!;
    expect(insertSkillMention("$pl rest", trigger, "plan")).toEqual({ text: "$plan rest", caret: 6 });
  });
});

describe("insertSkillTrigger", () => {
  it("separates the dollar from a preceding word", () => {
    expect(insertSkillTrigger("fix", 3)).toEqual({ text: "fix $", caret: 5 });
    expect(insertSkillTrigger("fix ", 4)).toEqual({ text: "fix $", caret: 5 });
    expect(insertSkillTrigger("", 0)).toEqual({ text: "$", caret: 1 });
  });
});

describe("skillInvocation", () => {
  it("turns a leading mention into the invocation with the rest as arguments", () => {
    expect(skillInvocation("$debug the login fails", ["debug"])).toEqual({ name: "debug", args: "the login fails" });
    expect(skillInvocation("$debug", ["debug"])).toEqual({ name: "debug", args: "" });
  });

  it("keeps the whole prompt as arguments when the mention is mid-text", () => {
    expect(skillInvocation("fix the login with $debug please", ["debug"])).toEqual({
      name: "debug",
      args: "fix the login with /debug please"
    });
  });

  it("invokes the first mention and leaves later ones as references", () => {
    expect(skillInvocation("$plan it, then $debug it", ["plan", "debug"])).toEqual({
      name: "plan",
      args: "it, then /debug it"
    });
  });

  it("returns null when no listed skill is mentioned", () => {
    expect(skillInvocation("plain text $plan", ["debug"])).toBeNull();
  });
});

describe("isSkillMentionList", () => {
  it("accepts mention-shaped names and rejects anything else", () => {
    expect(isSkillMentionList(["plan", "ndk:plan", "code_review-2"])).toBe(true);
    expect(isSkillMentionList("plan")).toBe(false);
    expect(isSkillMentionList(["../etc"])).toBe(false);
    expect(isSkillMentionList([" plan"])).toBe(false);
    expect(isSkillMentionList([1])).toBe(false);
    expect(isSkillMentionList(Array.from({ length: 33 }, (_, i) => `s${i}`))).toBe(false);
  });
});
