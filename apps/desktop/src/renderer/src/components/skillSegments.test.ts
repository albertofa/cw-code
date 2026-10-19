import { describe, expect, it } from "vitest";
import { findSkillMentions, findSkillReferences } from "../../../shared/skillMentions.js";
import { skillSegments } from "./skillSegments.js";

const KNOWN = new Set(["plan", "debug"]);

describe("skillSegments", () => {
  it("splits text around $ mentions and keeps the raw token", () => {
    const text = "use $plan, then $debug";
    expect(skillSegments(text, findSkillMentions(text, KNOWN))).toEqual([
      { kind: "text", value: "use " },
      { kind: "skill", name: "plan", raw: "$plan" },
      { kind: "text", value: ", then " },
      { kind: "skill", name: "debug", raw: "$debug" }
    ]);
  });

  it("returns the whole text when nothing matches", () => {
    expect(skillSegments("plain $HOME", findSkillMentions("plain $HOME", KNOWN))).toEqual([
      { kind: "text", value: "plain $HOME" }
    ]);
    expect(skillSegments("", [])).toEqual([]);
  });

  it("covers slash references the Claude transcript stores", () => {
    const text = "/debug fix login with /plan, not src/plan or /tmp/plan";
    expect(skillSegments(text, findSkillReferences(text, KNOWN)).filter((s) => s.kind === "skill")).toEqual([
      { kind: "skill", name: "debug", raw: "/debug" },
      { kind: "skill", name: "plan", raw: "/plan" }
    ]);
  });
});
