import { describe, expect, it } from "bun:test";
import type { DriverKind, HarnessUpdateInfo } from "@cw-code/contracts";
import { PENDING_HARNESS_UPDATES } from "../../app/AppTopic.js";
import { type HarnessCheck, HarnessUpdateService } from "./HarnessUpdateService.js";
import type { InstallPlan } from "./installMethod.js";
import type { UpdateCommand, UpdateRunResult } from "./runUpdateCommand.js";

const NPM_PLAN: InstallPlan = {
  method: "npm",
  command: { file: "npm", args: ["install", "-g", "pkg@latest"] },
  display: "npm install -g pkg@latest",
  lockKey: "npm-global:c:/node"
};

const MANUAL_PLAN: InstallPlan = { method: "winget", command: null, display: "winget upgrade Anthropic.ClaudeCode", lockKey: null };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function check(binary: DriverKind, actual: string | null): HarnessCheck {
  return {
    binary,
    binaryPath: `/bin/${binary}`,
    minimum: "0.0.1",
    actual,
    configured: false,
    found: true,
    available: true,
    error: null,
    ok: true,
    skipped: false
  };
}

interface Setup {
  versions: Partial<Record<DriverKind, string | null>>;
  plans?: Partial<Record<DriverKind, InstallPlan>>;
  latest?: string | null;
  run?(command: UpdateCommand, binary: DriverKind): Promise<UpdateRunResult>;
}

function setup(options: Setup) {
  const versions = { ...options.versions };
  const plans: Partial<Record<DriverKind, InstallPlan>> = { ...options.plans };
  const state = { enabled: true, latest: options.latest === undefined ? "2.0.0" : options.latest };
  const busy: Record<DriverKind, number> = { claude: 0, codex: 0, opencode: 0 };
  const listeners = new Set<() => void>();
  const events: string[] = [];
  const runs: DriverKind[] = [];
  const service = new HarnessUpdateService({
    initial: PENDING_HARNESS_UPDATES,
    checks: () => (Object.keys(versions) as DriverKind[]).map((binary) => check(binary, versions[binary] ?? null)),
    enabled: () => state.enabled,
    plan: async (binary) => plans[binary] ?? { ...NPM_PLAN, command: { file: binary, args: ["install"] } },
    latest: async () => state.latest,
    run: async (command, onProgress) => {
      const binary = command.file as DriverKind;
      events.push(`run:${binary}`);
      runs.push(binary);
      onProgress("working");
      if (options.run) return options.run(command, binary);
      versions[binary] = state.latest;
      return { code: 0, output: "added 1 package\n", error: null };
    },
    activity: (kind) => ({ busy: busy[kind] }),
    onActivity: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: async (kind) => {
      events.push(`release:${kind}`);
    },
    recheck: async () => {
      events.push("recheck");
    },
    publish: () => {},
    now: () => 1000
  });
  return {
    service,
    versions,
    plans,
    state,
    busy,
    events,
    runs,
    fireActivity: () => {
      for (const listener of [...listeners]) listener();
    }
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
}

function pick(info: HarnessUpdateInfo, keys: Array<keyof HarnessUpdateInfo>): Partial<HarnessUpdateInfo> {
  return Object.fromEntries(keys.map((key) => [key, info[key]]));
}

const settled = (phase: HarnessUpdateInfo["phase"]): boolean => phase !== "queued" && phase !== "running" && phase !== "idle";

describe("HarnessUpdateService", () => {
  it("updates a behind harness and reports success", async () => {
    const { service, events } = setup({ versions: { claude: "1.0.0" } });
    const refreshed = await service.refresh({ fresh: true });
    expect(pick(refreshed.claude, ["status", "currentVersion", "latestVersion", "canUpdate", "updateCommand", "message"])).toEqual({
      status: "behind",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      canUpdate: true,
      updateCommand: "npm install -g pkg@latest",
      message: null
    });
    const accepted = await service.update(["claude"]);
    expect(["queued", "running"]).toContain(accepted.claude.phase);
    await until(() => settled(service.updates.claude.phase));
    expect(pick(service.updates.claude, ["phase", "phaseMessage", "currentVersion", "status", "output"])).toEqual({
      phase: "succeeded",
      phaseMessage: "Updated to 2.0.0",
      currentVersion: "2.0.0",
      status: "current",
      output: "added 1 package\n"
    });
    expect(events).toEqual(["release:claude", "run:claude", "release:claude", "recheck"]);
  });

  it("reports unchanged when the harness still reports the old version", async () => {
    const { service } = setup({
      versions: { claude: "1.0.0" },
      run: async () => ({ code: 0, output: "ok", error: null })
    });
    await service.refresh({ fresh: true });
    await service.update(["claude"]);
    await until(() => settled(service.updates.claude.phase));
    expect(pick(service.updates.claude, ["phase", "phaseMessage"])).toEqual({
      phase: "unchanged",
      phaseMessage: "Update finished, but Claude still reports 1.0.0."
    });
  });

  it("reports unchanged when the version cannot be read after the update", async () => {
    const { service, versions } = setup({
      versions: { claude: "1.0.0" },
      run: async () => {
        versions.claude = null;
        return { code: 0, output: "ok", error: null };
      }
    });
    await service.refresh({ fresh: true });
    await service.update(["claude"]);
    await until(() => settled(service.updates.claude.phase));
    expect(pick(service.updates.claude, ["phase", "phaseMessage"])).toEqual({
      phase: "unchanged",
      phaseMessage: "Update finished, but the version could not be verified."
    });
  });

  it("fails with the exit code and the last output line", async () => {
    const { service, events } = setup({
      versions: { claude: "1.0.0" },
      run: async () => ({ code: 1, output: "fetching\n\u001b[31mnpm ERR! EACCES\u001b[0m\n", error: null })
    });
    await service.refresh({ fresh: true });
    await service.update(["claude"]);
    await until(() => settled(service.updates.claude.phase));
    expect(pick(service.updates.claude, ["phase", "phaseMessage", "output"])).toEqual({
      phase: "failed",
      phaseMessage: "Update command exited with code 1: npm ERR! EACCES",
      output: "fetching\n\u001b[31mnpm ERR! EACCES\u001b[0m\n"
    });
    expect(events).toEqual(["release:claude", "run:claude", "release:claude"]);
  });

  it("fails when the runner reports a timeout", async () => {
    const { service } = setup({
      versions: { claude: "1.0.0" },
      run: async () => ({ code: null, output: "", error: "Update timed out." })
    });
    await service.refresh({ fresh: true });
    await service.update(["claude"]);
    await until(() => settled(service.updates.claude.phase));
    expect(pick(service.updates.claude, ["phase", "phaseMessage"])).toEqual({ phase: "failed", phaseMessage: "Update timed out." });
  });

  it("queues updates that share a lock key", async () => {
    const gate = deferred<void>();
    const { service, versions, runs } = setup({
      versions: { claude: "1.0.0", codex: "1.0.0" },
      run: async (_command, binary) => {
        if (binary === "claude") await gate.promise;
        versions[binary] = "2.0.0";
        return { code: 0, output: "", error: null };
      }
    });
    await service.refresh({ fresh: true });
    const accepted = await service.update(["claude", "codex"]);
    expect(pick(accepted.codex, ["phase", "phaseMessage"])).toEqual({ phase: "queued", phaseMessage: "Waiting for another update to finish" });
    await until(() => service.updates.claude.phase === "running");
    expect(service.updates.codex.phase).toBe("queued");
    expect(runs).toEqual(["claude"]);
    gate.resolve();
    await until(() => settled(service.updates.codex.phase));
    expect(runs).toEqual(["claude", "codex"]);
    expect(service.updates.claude.phase).toBe("succeeded");
    expect(service.updates.codex.phase).toBe("succeeded");
  });

  it("waits for running turns before updating", async () => {
    const { service, busy, runs, fireActivity } = setup({ versions: { claude: "1.0.0" } });
    busy.claude = 2;
    await service.refresh({ fresh: true });
    await service.update(["claude"]);
    expect(pick(service.updates.claude, ["phase", "phaseMessage"])).toEqual({
      phase: "queued",
      phaseMessage: "Waiting for 2 running turn(s) to finish"
    });
    busy.claude = 1;
    fireActivity();
    expect(service.updates.claude.phaseMessage).toBe("Waiting for 1 running turn(s) to finish");
    expect(runs).toEqual([]);
    busy.claude = 0;
    fireActivity();
    await until(() => settled(service.updates.claude.phase));
    expect(runs).toEqual(["claude"]);
    expect(service.updates.claude.phase).toBe("succeeded");
  });

  it("gates new turns only while the update runs", async () => {
    const gate = deferred<void>();
    const { service, versions } = setup({
      versions: { claude: "1.0.0" },
      run: async () => {
        await gate.promise;
        versions.claude = "2.0.0";
        return { code: 0, output: "", error: null };
      }
    });
    await service.refresh({ fresh: true });
    expect(service.turnGate("claude")).toBeNull();
    await service.update(["claude"]);
    await until(() => service.updates.claude.phase === "running");
    expect(service.turnGate("claude")).toBe("Claude is updating. Try again when the update finishes.");
    expect(service.turnGate("codex")).toBeNull();
    gate.resolve();
    await until(() => settled(service.updates.claude.phase));
    expect(service.turnGate("claude")).toBeNull();
  });

  it("fails when the installation changed since the last check", async () => {
    const { service, plans, runs } = setup({ versions: { claude: "1.0.0" } });
    await service.refresh({ fresh: true });
    plans.claude = { ...NPM_PLAN, lockKey: "bun-global" };
    await service.update(["claude"]);
    expect(pick(service.updates.claude, ["phase", "phaseMessage"])).toEqual({
      phase: "failed",
      phaseMessage: "The installation changed. Recheck and try again."
    });
    expect(runs).toEqual([]);
  });

  it("reports unknown status when checks are disabled", async () => {
    const { service, state } = setup({ versions: { claude: "1.0.0" } });
    state.enabled = false;
    const refreshed = await service.refresh({ fresh: true });
    expect(pick(refreshed.claude, ["status", "latestVersion", "canUpdate", "message", "phase"])).toEqual({
      status: "unknown",
      latestVersion: null,
      canUpdate: false,
      message: null,
      phase: "idle"
    });
  });

  it("suggests the manual command and never runs it", async () => {
    const { service, runs } = setup({ versions: { claude: "1.0.0" }, plans: { claude: MANUAL_PLAN } });
    const refreshed = await service.refresh({ fresh: true });
    expect(pick(refreshed.claude, ["status", "installMethod", "canUpdate", "updateCommand", "message"])).toEqual({
      status: "behind",
      installMethod: "winget",
      canUpdate: false,
      updateCommand: "winget upgrade Anthropic.ClaudeCode",
      message: "Version 2.0.0 is out. Update it with the tool that installed /bin/claude."
    });
    const accepted = await service.update(["claude"]);
    expect(accepted.claude.phase).toBe("idle");
    expect(runs).toEqual([]);
  });

  it("keeps phase fields across refreshes", async () => {
    const { service } = setup({
      versions: { claude: "1.0.0" },
      run: async () => ({ code: 2, output: "boom", error: null })
    });
    await service.refresh({ fresh: true });
    await service.update(["claude"]);
    await until(() => settled(service.updates.claude.phase));
    const before = pick(service.updates.claude, ["phase", "phaseMessage", "startedAt", "finishedAt", "output"]);
    const refreshed = await service.refresh({ fresh: true });
    expect(pick(refreshed.claude, ["phase", "phaseMessage", "startedAt", "finishedAt", "output"])).toEqual(before);
    expect(before.phase).toBe("failed");
  });

  it("lets the newest refresh win", async () => {
    const { service, state } = setup({ versions: { claude: "1.0.0" } });
    const first = service.refresh({ fresh: false });
    state.latest = "3.0.0";
    const second = service.refresh({ fresh: true });
    const [a, b] = await Promise.all([first, second]);
    expect(a.claude.latestVersion).toBe("3.0.0");
    expect(b.claude.latestVersion).toBe("3.0.0");
  });
});
