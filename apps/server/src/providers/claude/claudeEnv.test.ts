import { describe, expect, it } from "bun:test";
import { claudeChildEnv } from "./claudeEnv.js";

describe("claudeChildEnv", () => {
  it("sets the cw-code entrypoint", () => {
    expect(claudeChildEnv({ PATH: "/usr/bin" }, "linux")).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_ENTRYPOINT: "cw-code" });
  });

  it("overrides an inherited entrypoint", () => {
    expect(claudeChildEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }, "win32")["CLAUDE_CODE_ENTRYPOINT"]).toBe("cw-code");
  });

  it("does not mutate the input env", () => {
    const env = { PATH: "/usr/bin" };
    claudeChildEnv(env, "darwin");
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
