import { describe, expect, test } from "bun:test";
import type { PermissionMode, SessionMeta, SettingsPatch } from "@cw-code/contracts";
import { requireOwner } from "../handlers/shared.js";
import { Router, type CallContext } from "../transport/Router.js";
import {
  AGENT_METHODS,
  AGENT_WRITABLE_SETTINGS,
  agentTurnPermissionMode,
  assertAgentCreateOptions,
  assertAgentMayDispatch,
  assertAgentModelId,
  assertAgentOmits,
  assertAgentSessionTarget,
  assertAgentSettingsPatch,
  assertCanDispatchSubagents,
  callerPermissionCap,
  capPermissionMode,
  isSafeModelId,
  ownedSubagent,
  SAFE_MODEL_ID,
  SUBAGENT_DEPTH_REFUSAL
} from "./agentPolicy.js";

const agent: CallContext = { clientId: "c", client: "mcp", auth: { kind: "agent", sessionId: "s1" } };
const owner: CallContext = { clientId: "c", client: "desktop-ui", auth: { kind: "owner" } };

function routerWith(methods: string[]): Router {
  const router = new Router();
  for (const method of methods) router.handle(method, () => `ran ${method}`);
  return router;
}

describe("Router agent policy", () => {
  test("lets an agent call an allowlisted method", async () => {
    const router = routerWith(["turns.start"]);
    expect(await router.dispatch("turns.start", {}, agent)).toBe("ran turns.start");
  });

  test("rejects a non-allowlisted method for an agent but not for the owner", async () => {
    const router = routerWith(["fs.readFile"]);
    await expect(router.dispatch("fs.readFile", {}, agent)).rejects.toMatchObject({ code: "forbidden" });
    expect(await router.dispatch("fs.readFile", {}, owner)).toBe("ran fs.readFile");
  });

  test("rejects an owner-only method for an agent", async () => {
    const router = new Router();
    router.handle("server.stop", (_params, ctx) => requireOwner(ctx, "stopping the server"));
    await expect(router.dispatch("server.stop", {}, agent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(router.dispatch("server.stop", {}, owner)).resolves.toBeUndefined();
  });
});

describe("capPermissionMode", () => {
  const modes: PermissionMode[] = ["manual", "acceptEdits", "auto", "bypassPermissions"];

  test.each(modes.flatMap((requested, i) => modes.map((caller, j) => [requested, caller, modes[Math.min(i, j)]] as const)))(
    "requested %s with caller %s gives %s",
    (requested, caller, expected) => {
      expect(capPermissionMode(requested, caller)).toBe(expected);
    }
  );

  test("undefined caller is manual", () => {
    expect(capPermissionMode("bypassPermissions", undefined)).toBe("manual");
    expect(capPermissionMode(undefined, undefined)).toBe("manual");
  });

  test("undefined requested inherits the caller mode", () => {
    expect(capPermissionMode(undefined, "auto")).toBe("auto");
  });
});

describe("agentTurnPermissionMode", () => {
  const composers: Record<string, PermissionMode> = { caller: "manual", target: "bypassPermissions", trusted: "auto" };
  const turnModes: Record<string, PermissionMode> = { target: "manual" };
  const sessions = {
    getComposer: (id: string) => ({ permissionMode: composers[id] }),
    turnPermissionMode: (id: string): PermissionMode | undefined => turnModes[id]
  };

  test("caps the requested mode at the caller session mode", () => {
    expect(agentTurnPermissionMode(sessions, "target", "caller", "bypassPermissions")).toBe("manual");
  });

  test("falls back to the target session's stored mode, still capped", () => {
    expect(agentTurnPermissionMode(sessions, "target", "caller", undefined)).toBe("manual");
    expect(agentTurnPermissionMode(sessions, "target", "trusted", undefined)).toBe("auto");
  });

  test("keeps a requested mode below the cap", () => {
    expect(agentTurnPermissionMode(sessions, "target", "trusted", "acceptEdits")).toBe("acceptEdits");
  });

  test("caps at the caller's running turn mode when it is below its stored mode", () => {
    expect(callerPermissionCap(sessions, "target")).toBe("manual");
    expect(agentTurnPermissionMode(sessions, "trusted", "target", "bypassPermissions")).toBe("manual");
  });

  test("uses the stored mode when the caller has not run a turn", () => {
    expect(callerPermissionCap(sessions, "trusted")).toBe("auto");
  });

  test("keeps the stored mode when the running turn is above it", () => {
    const raised = { ...sessions, turnPermissionMode: (): PermissionMode => "bypassPermissions" };
    expect(callerPermissionCap(raised, "trusted")).toBe("auto");
  });
});

describe("AGENT_WRITABLE_SETTINGS", () => {
  test.each(["autoTitleEnabled", "autoTitleDriver", "autoTitleModel", "autoTitleEffort"] as const)("excludes %s", (key) => {
    expect(AGENT_WRITABLE_SETTINGS.has(key)).toBe(false);
    expect(() => assertAgentSettingsPatch({ [key]: "x" })).toThrow(key);
  });
});

describe("agent argument guards", () => {
  test("rejects a set forbidden field with the forbidden code", () => {
    expect(() => assertAgentOmits({ prompt: "p", command: { name: "x" } }, ["command"], "turns.start")).toThrow("turns.start command");
    let caught: unknown;
    try {
      assertAgentOmits({ attachments: [] }, ["attachments"], "turns.start");
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("forbidden");
  });

  test("ignores fields that are absent or undefined", () => {
    expect(() => assertAgentOmits({ prompt: "p", command: undefined }, ["command", "prRefs"], "turns.start")).not.toThrow();
  });

  test("allows only useWorktree in sessions.create options", () => {
    expect(() => assertAgentCreateOptions(undefined)).not.toThrow();
    expect(() => assertAgentCreateOptions({ useWorktree: false })).not.toThrow();
    expect(() => assertAgentCreateOptions({ useWorktree: true, baseBranch: "main" })).toThrow("baseBranch");
    expect(() => assertAgentCreateOptions({ reuseWorktreePath: "/x" })).toThrow("reuseWorktreePath");
    expect(() => assertAgentCreateOptions("new")).toThrow("must be an object");
  });
});

describe("AGENT_METHODS", () => {
  test("lists exactly the methods the cw tools call", () => {
    expect([...AGENT_METHODS].sort()).toEqual(
      [
        "composer.get",
        "projects.list",
        "sessions.create",
        "sessions.list",
        "settings.get",
        "settings.set",
        "subagents.ack",
        "subagents.create",
        "subagents.list",
        "subagents.send",
        "subagents.stop",
        "subagents.targets",
        "turns.start",
        "turns.stop",
        "usage.report"
      ].sort()
    );
  });
});

describe("subagent policy", () => {
  const session = (id: string, parentSessionId?: string): SessionMeta => ({
    id,
    projectId: "p1",
    driver: "codex",
    title: id,
    status: "idle",
    resumeCursor: "",
    createdAt: 1,
    updatedAt: 1,
    ...(parentSessionId ? { subagent: { parentSessionId, isolation: "shared" } } : {})
  });

  test("refuses a subagent that tries to dispatch its own subagents", () => {
    expect(() => assertCanDispatchSubagents(session("parent"))).not.toThrow();
    expect(() => assertCanDispatchSubagents(session("kid", "parent"))).toThrow(SUBAGENT_DEPTH_REFUSAL);
    try {
      assertCanDispatchSubagents(session("kid", "parent"));
    } catch (error) {
      expect((error as { code?: string }).code).toBe("forbidden");
    }
  });

  test("returns a subagent only to its parent, or to a caller without a session", () => {
    const kid = session("kid", "parent");
    expect(ownedSubagent(kid, "kid", "parent")).toBe(kid);
    expect(ownedSubagent(kid, "kid", null)).toBe(kid);
  });

  test("refuses dispatch only for agent callers whose session is a subagent", () => {
    const sessions = new Map([
      ["parent", session("parent")],
      ["kid", session("kid", "parent")]
    ]);
    const lookup = (id: string) => sessions.get(id);
    const agentOf = (sessionId: string): CallContext => ({ clientId: "c", client: "mcp", auth: { kind: "agent", sessionId } });
    expect(() => assertAgentMayDispatch(agentOf("parent"), lookup)).not.toThrow();
    expect(() => assertAgentMayDispatch(owner, lookup)).not.toThrow();
    expect(() => assertAgentMayDispatch(agentOf("kid"), lookup)).toThrow(SUBAGENT_DEPTH_REFUSAL);
  });

  test("hides another parent's subagent as an unknown session and points the parent at the subagent tools", () => {
    const sessions = new Map([["kid", session("kid", "parent")]]);
    const lookup = (id: string) => sessions.get(id);
    expect(() => assertAgentSessionTarget(lookup, "kid", "stranger")).toThrow("unknown session kid");
    expect(() => assertAgentSessionTarget(lookup, "kid", "parent")).toThrow("subagent_send");
    expect(() => assertAgentSessionTarget(lookup, "plain", "parent")).not.toThrow();
  });

  test("answers the same for another parent's subagent, a plain session and an unknown id", () => {
    expect(() => ownedSubagent(session("kid", "parent"), "kid", "stranger")).toThrow("unknown subagent kid");
    expect(() => ownedSubagent(session("plain"), "plain", null)).toThrow("unknown subagent plain");
    expect(() => ownedSubagent(undefined, "missing", "parent")).toThrow("unknown subagent missing");
  });
});

describe("isSafeModelId", () => {
  test.each([
    "opus",
    "fable",
    "claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "openai/gpt-5",
    "openai/gpt-5.2",
    "opencode/big-pickle",
    "anthropic/claude-sonnet-4-5",
    "openrouter/qwen/qwen3-coder:free",
    "gpt-5@high",
    "high"
  ])("accepts %s", (id) => {
    expect(isSafeModelId(id)).toBe(true);
  });

  test.each(["", "opus&whoami", "opus|calc", "a b", "-p", "--model", "%PATH%", 'a"b', "x^y", "x(y)", "a>b", "a\nb", "a".repeat(129)])(
    "rejects %j",
    (id) => {
      expect(isSafeModelId(id)).toBe(false);
    }
  );

  test("rejects non-strings", () => {
    expect(isSafeModelId(undefined)).toBe(false);
    expect(isSafeModelId(["opus"])).toBe(false);
  });

  test("has a pattern that strict regex engines accept, since tool schemas publish it", () => {
    const strict = new RegExp(SAFE_MODEL_ID.source, "v");
    for (const id of ["opus", "openai/gpt-5", "claude-opus-4[1m]", "a@b:c+d", "x_y.z"]) expect(strict.test(id)).toBe(true);
    for (const id of ["a b", "opus&whoami", "a\\b"]) expect(strict.test(id)).toBe(false);
  });
});

describe("assertAgentModelId", () => {
  test("allows an absent value and rejects an unsafe one with the forbidden code", () => {
    expect(() => assertAgentModelId(undefined, "prefs.model")).not.toThrow();
    expect(() => assertAgentModelId("openai/gpt-5", "prefs.model")).not.toThrow();
    expect(() => assertAgentModelId("opus&whoami", "prefs.model")).toThrow("prefs.model is not a valid model id");
    expect(() => assertAgentModelId("", "prefs.model")).toThrow("prefs.model");
    try {
      assertAgentModelId("opus&whoami", "prefs.model");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("forbidden");
    }
  });
});

describe("assertAgentSettingsPatch", () => {
  test.each(["claudeDefaultModel", "codexDefaultModel", "opencodeDefaultModel"] as const)("rejects an unsafe %s and allows clearing it", (key) => {
    expect(() => assertAgentSettingsPatch({ [key]: "opus&whoami" })).toThrow(key);
    expect(() => assertAgentSettingsPatch({ [key]: 42 } as unknown as SettingsPatch)).toThrow(key);
    expect(() => assertAgentSettingsPatch({ [key]: "" })).not.toThrow();
    expect(() => assertAgentSettingsPatch({ [key]: " openai/gpt-5 " })).not.toThrow();
  });

  test("checks every enabled Claude model id", () => {
    expect(() => assertAgentSettingsPatch({ claudeEnabledModels: ["claude-opus-5-5[1m]", "fable"] })).not.toThrow();
    expect(() => assertAgentSettingsPatch({ claudeEnabledModels: ["fable", "opus&whoami"] })).toThrow("claudeEnabledModels");
    expect(() => assertAgentSettingsPatch({ claudeEnabledModels: "fable" } as unknown as SettingsPatch)).toThrow("claudeEnabledModels");
  });

  test.each([["claudeBinaryPath", "/bin/claude"], ["claudeExtraArgs", "--x"], ["keepServerRunning", true]])("rejects %s", (key, value) => {
    expect(() => assertAgentSettingsPatch({ [key]: value })).toThrow(key);
    try {
      assertAgentSettingsPatch({ [key]: value });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("forbidden");
    }
  });

  test("names the first denied key in a mixed patch", () => {
    expect(() => assertAgentSettingsPatch({ claudeDefaultModel: "m", claudeBinaryPath: "x" })).toThrow("claudeBinaryPath");
  });

  test("accepts allowlisted keys", () => {
    expect(() => assertAgentSettingsPatch({ claudeDefaultModel: "opus", holdingHours: 4 })).not.toThrow();
  });
});
