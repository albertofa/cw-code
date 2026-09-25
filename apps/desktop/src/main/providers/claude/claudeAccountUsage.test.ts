import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mapClaudeUsage, probeClaudeAccountUsage } from "./claudeAccountUsage.js";

function controlResponse(response: unknown) {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "r2",
      response
    }
  };
}

describe("mapClaudeUsage", () => {
  it("maps the live Team response with three limits and extra usage disabled", () => {
    const state = mapClaudeUsage(
      controlResponse({
        subscription_type: "team",
        rate_limits_available: true,
        rate_limits: {
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 89,
              severity: "warning",
              resets_at: "2026-09-24T03:10:00.419321+00:00",
              scope: null,
              is_active: true
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: 62,
              severity: "normal",
              resets_at: "2026-09-25T11:00:00.419347+00:00",
              scope: null,
              is_active: false
            },
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 56,
              severity: "normal",
              resets_at: "2026-09-25T11:00:00.419556+00:00",
              scope: { model: { id: null, display_name: "Fable" }, surface: null },
              is_active: false
            }
          ],
          extra_usage: {
            is_enabled: false,
            monthly_limit: null,
            used_credits: null,
            utilization: null,
            currency: null,
            decimal_places: null,
            disabled_reason: null
          }
        }
      })
    );
    expect(state).toEqual({
      status: "ok",
      plan: "Team",
      windows: [
        {
          id: "session",
          label: "Current session",
          percent: 89,
          resetsAt: Date.parse("2026-09-24T03:10:00.419321+00:00"),
          severity: "warning",
          active: true
        },
        {
          id: "weekly_all",
          label: "Weekly · all models",
          percent: 62,
          resetsAt: Date.parse("2026-09-25T11:00:00.419347+00:00"),
          severity: "normal",
          active: false
        },
        {
          id: "weekly_scoped:Fable",
          label: "Weekly · Fable",
          percent: 56,
          resetsAt: Date.parse("2026-09-25T11:00:00.419556+00:00"),
          severity: "normal",
          active: false
        }
      ],
      balances: [{ id: "extra-usage", label: "Extra usage", enabled: false, detail: "Disabled" }],
      notes: []
    });
  });

  it("returns unavailable api-key when rate limits are unavailable", () => {
    const state = mapClaudeUsage(
      controlResponse({ subscription_type: null, rate_limits_available: false, rate_limits: { limits: [] } })
    );
    expect(state).toEqual({
      status: "unavailable",
      reason: "api-key",
      message: "Claude is signed in with an API key; plan limits aren't available."
    });
  });

  it("returns an error when limits is missing or malformed", () => {
    const state = mapClaudeUsage(
      controlResponse({ subscription_type: "pro", rate_limits_available: true, rate_limits: {} })
    );
    expect(state).toEqual({ status: "error", message: "Unexpected get_usage response" });
  });

  it("title-cases an unknown limit kind instead of dropping it", () => {
    const state = mapClaudeUsage(
      controlResponse({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          limits: [
            { kind: "monthly_credits", percent: 10, severity: "normal", resets_at: null, scope: null, is_active: true }
          ]
        }
      })
    );
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("expected ok");
    expect(state.windows).toEqual([
      { id: "monthly_credits", label: "Monthly Credits", percent: 10, severity: "normal", active: true }
    ]);
  });

  it("treats percent at or above 100 as blocked even when the server reports normal severity", () => {
    const state = mapClaudeUsage(
      controlResponse({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: { limits: [{ kind: "session", percent: 100, severity: "normal", scope: null }] }
      })
    );
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("expected ok");
    expect(state.windows[0]?.severity).toBe("blocked");
  });

  it("maps a control-level error to unsupported-version", () => {
    const state = mapClaudeUsage({
      type: "control_response",
      response: { subtype: "error", request_id: "r2", error: "unknown subtype get_usage" }
    });
    expect(state).toEqual({
      status: "unavailable",
      reason: "unsupported-version",
      message: "Claude CLI returned an unexpected response to get_usage."
    });
  });

  it("returns an error for a completely malformed payload", () => {
    expect(mapClaudeUsage(null)).toEqual({ status: "error", message: "Unexpected get_usage response" });
    expect(mapClaudeUsage("not json")).toEqual({ status: "error", message: "Unexpected get_usage response" });
  });

  it("returns an error, not api-key, when subscription_type is missing entirely", () => {
    const state = mapClaudeUsage(
      controlResponse({ rate_limits_available: true, rate_limits: { limits: [] } })
    );
    expect(state).toEqual({ status: "error", message: "Unexpected get_usage response" });
  });

  it("returns ok with a note and no windows when limits is an empty array", () => {
    const state = mapClaudeUsage(
      controlResponse({ subscription_type: "pro", rate_limits_available: true, rate_limits: { limits: [] } })
    );
    expect(state).toEqual({
      status: "ok",
      plan: "Pro",
      windows: [],
      balances: [],
      notes: ["Claude reported no plan windows for this account"]
    });
  });

  it("returns ok with a note and warns when every limit row is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = mapClaudeUsage(
      controlResponse({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: { limits: [{ percent: 10 }, { kind: "session" }] }
      })
    );
    expect(state).toEqual({
      status: "ok",
      plan: "Pro",
      windows: [],
      balances: [],
      notes: ["Claude reported no plan windows for this account"]
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 2 malformed rate limit row"));
    warn.mockRestore();
  });

  it("suffixes colliding window ids instead of dropping duplicates", () => {
    const state = mapClaudeUsage(
      controlResponse({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          limits: [
            { kind: "session", percent: 10, severity: "normal", scope: null },
            { kind: "session", percent: 20, severity: "normal", scope: null }
          ]
        }
      })
    );
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("expected ok");
    expect(state.windows.map((w) => w.id)).toEqual(["session", "session-2"]);
  });
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 123;
  exitCode: number | null = null;

  kill(): boolean {
    return true;
  }
}

function fakeSpawn(children: FakeChild[]) {
  return ((_command: string, _args: readonly string[], options?: { cwd?: string }) => {
    const child = new FakeChild();
    (child as unknown as { spawnOptions?: unknown }).spawnOptions = options;
    children.push(child);
    return child;
  }) as unknown as Parameters<typeof probeClaudeAccountUsage>[2];
}

describe("probeClaudeAccountUsage", () => {
  it("spawns with a neutral home-directory cwd, ends stdin, and kills the still-running child", async () => {
    const children: FakeChild[] = [];
    const killed: unknown[] = [];
    const promise = probeClaudeAccountUsage("claude", ["-p"], fakeSpawn(children), (proc) => killed.push(proc));
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    const options = (child as unknown as { spawnOptions?: { cwd?: string } }).spawnOptions;
    expect(options?.cwd).toBeTruthy();
    const stdinEnd = vi.spyOn(child.stdin, "end");
    const requestId = (JSON.parse(child.stdin.read()?.toString().trim().split("\n")[1] ?? "null") as {
      request_id: string;
    }).request_id;
    child.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: { subscription_type: "pro", rate_limits_available: true, rate_limits: { limits: [] } }
        }
      })}\n`
    );
    const state = await promise;
    expect(state.status).toBe("ok");
    expect(stdinEnd).toHaveBeenCalled();
    expect(killed).toEqual([child]);
  });

  it("skips killFn when the child has already exited", async () => {
    const children: FakeChild[] = [];
    const killed: unknown[] = [];
    const promise = probeClaudeAccountUsage("claude", ["-p"], fakeSpawn(children), (proc) => killed.push(proc));
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    child.exitCode = 0;
    child.emit("close");
    await promise;
    expect(killed).toEqual([]);
  });

  it("includes a truncated stderr preview when the process exits before responding", async () => {
    const children: FakeChild[] = [];
    const promise = probeClaudeAccountUsage("claude", ["-p"], fakeSpawn(children), () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    child.stderr.write("fatal: something broke\n");
    child.emit("close");
    const state = await promise;
    expect(state).toEqual({
      status: "error",
      message: "claude get_usage probe exited before responding (stderr: fatal: something broke)"
    });
  });

  it("resolves not-installed instead of throwing when spawnFn throws ENOENT synchronously", async () => {
    const spawnFn = (() => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    }) as unknown as Parameters<typeof probeClaudeAccountUsage>[2];
    const state = await probeClaudeAccountUsage("claude", ["-p"], spawnFn, () => {});
    expect(state).toEqual({
      status: "unavailable",
      reason: "not-installed",
      message: "Claude isn't installed. Set its path in Settings → Harnesses → Claude."
    });
  });
});
