import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("parses a command with value flags", () => {
    const result = parseArgs(["plan", "--channel", "alpha", "--out", "plan.json"]);
    expect(result.command).toBe("plan");
    expect(result.options.get("channel")).toBe("alpha");
    expect(result.options.get("out")).toBe("plan.json");
  });

  it("parses a bare boolean flag without consuming the next token as its value", () => {
    const result = parseArgs(["plan", "--channel", "alpha", "--force", "--out", "plan.json"]);
    expect(result.options.get("force")).toBe("true");
    expect(result.options.get("out")).toBe("plan.json");
  });

  it("throws when a flag is missing its value entirely", () => {
    expect(() => parseArgs(["plan", "--channel"])).toThrow(/--channel requires a value/);
  });

  it("throws when a flag's value looks like another flag", () => {
    expect(() => parseArgs(["plan", "--out", "--channel", "alpha"])).toThrow(/--out requires a value/);
  });

  it("throws on a stray positional argument", () => {
    expect(() => parseArgs(["plan", "extra"])).toThrow(/Unexpected argument "extra"/);
  });

  it("returns an empty command and no options for an empty argv", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("");
    expect(result.options.size).toBe(0);
  });
});
