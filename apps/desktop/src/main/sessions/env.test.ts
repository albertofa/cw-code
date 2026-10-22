import { describe, expect, it } from "vitest";
import { buildTurnEnv, githubAccountEnv } from "./env.js";

describe("buildTurnEnv", () => {
  it("applies precedence: turn env over session vars over process env", () => {
    const env = buildTurnEnv(
      { A: "process", B: "process", C: "process" },
      { B: "session", C: "session" },
      { C: "turn", D: "turn" }
    );
    expect(env).toEqual({ A: "process", B: "session", C: "turn", D: "turn" });
  });

  it("filters non-string values from the process env", () => {
    const env = buildTurnEnv({ GOOD: "1", BAD: undefined, NUM: 42 } as unknown as Record<string, string | undefined>, {});
    expect(env).toEqual({ GOOD: "1" });
  });

  it("filters non-string values from session and turn env", () => {
    const env = buildTurnEnv(
      { BASE: "1" },
      { CW_SESSION_ID: "s1", BAD: undefined } as unknown as Record<string, string>,
      { CW_EXTRA: "x", NUM: 7 } as unknown as Record<string, string>
    );
    expect(env).toEqual({ BASE: "1", CW_SESSION_ID: "s1", CW_EXTRA: "x" });
  });

  it("handles empty inputs", () => {
    expect(buildTurnEnv({}, {})).toEqual({});
    expect(buildTurnEnv({}, {}, {})).toEqual({});
  });

  it("returns a copy that does not mutate the inputs", () => {
    const processEnv = { A: "1" };
    const sessionVars = { B: "2" };
    const env = buildTurnEnv(processEnv, sessionVars, { C: "3" });
    env["D"] = "4";
    expect(processEnv).toEqual({ A: "1" });
    expect(sessionVars).toEqual({ B: "2" });
  });
});

describe("githubAccountEnv", () => {
  it("uses GH_TOKEN for github.com", () => {
    expect(githubAccountEnv({ host: "github.com", login: "octo" }, "tok")).toEqual({ GH_HOST: "github.com", GH_TOKEN: "tok" });
  });

  it("uses GH_TOKEN for ghe.com tenants", () => {
    expect(githubAccountEnv({ host: "Acme.GHE.com", login: "octo" }, "tok")).toEqual({ GH_HOST: "acme.ghe.com", GH_TOKEN: "tok" });
  });

  it("uses GH_ENTERPRISE_TOKEN for enterprise server hosts", () => {
    expect(githubAccountEnv({ host: "git.example.com", login: "octo" }, "tok")).toEqual({ GH_HOST: "git.example.com", GH_ENTERPRISE_TOKEN: "tok" });
  });

  it("returns nothing without an account or a token", () => {
    expect(githubAccountEnv({ host: "github.com", login: "octo" }, null)).toEqual({});
    expect(githubAccountEnv({ host: "github.com", login: "octo" }, "")).toEqual({});
    expect(githubAccountEnv(undefined, "tok")).toEqual({});
  });
});
