import { describe, expect, test } from "bun:test";
import type { CliVersionCheck, HarnessAvailability } from "@cw-code/contracts";
import { PENDING_HARNESSES } from "../app/AppTopic.js";
import { HarnessMonitor, type HarnessBinaries, type HarnessCheckTrigger } from "./HarnessMonitor.js";

const BINARIES: HarnessBinaries = { claudeBinary: "claude", opencodeBinary: "opencode", codexBinary: "codex" };

function version(binary: CliVersionCheck["binary"], overrides: Partial<CliVersionCheck> = {}): CliVersionCheck {
  return { binary, binaryPath: binary, minimum: "1.0.0", actual: "2.0.0", configured: false, found: true, available: true, error: null, ok: true, ...overrides };
}

function setup(probe: () => Promise<CliVersionCheck[]>) {
  const published: HarnessAvailability[] = [];
  const monitor = new HarnessMonitor({
    binaries: () => BINARIES,
    current: () => published.at(-1) ?? PENDING_HARNESSES,
    publish: (availability) => published.push(availability),
    checkCliVersions: probe,
    now: () => 1_000
  });
  return { monitor, published };
}

describe("HarnessMonitor", () => {
  test.each<HarnessCheckTrigger>(["startup", "settings", "recheck"])("publishes the %s result", async (trigger) => {
    const { monitor, published } = setup(async () => [
      version("claude"),
      version("opencode", { found: false, available: false, actual: null, ok: false }),
      version("codex", { actual: "0.1.0", ok: false })
    ]);
    await monitor.check(trigger);
    expect(published).toHaveLength(1);
    const [result] = published;
    expect(result).toMatchObject({ trigger, checkedAt: 1_000, error: null, installed: ["claude", "codex"] });
    expect(result?.checks.map((check) => [check.binary, check.skipped])).toEqual([
      ["claude", false],
      ["opencode", true],
      ["codex", false]
    ]);
    expect(result?.issues.map((issue) => issue.id)).toEqual(["cli-versions"]);
  });

  test("reports no installed harness as a blocking issue", async () => {
    const missing = (binary: CliVersionCheck["binary"]) => version(binary, { found: false, available: false, actual: null, ok: false });
    const { monitor, published } = setup(async () => [missing("claude"), missing("opencode"), missing("codex")]);
    await monitor.check("startup");
    expect(published[0]?.installed).toEqual([]);
    expect(published[0]?.issues).toMatchObject([{ id: "cli-binaries", level: "error" }]);
  });

  test("keeps the previous result and records the error when the probe fails", async () => {
    let fail = false;
    const { monitor, published } = setup(async () => {
      if (fail) throw new Error("probe crashed");
      return [version("claude"), version("opencode"), version("codex")];
    });
    await monitor.check("startup");
    fail = true;
    await monitor.check("recheck");
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ trigger: "recheck", error: "probe crashed", installed: ["claude", "opencode", "codex"] });
  });

  test("drops the result of a check superseded by a newer one", async () => {
    const releases: Array<() => void> = [];
    const { monitor, published } = setup(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve([version("claude"), version("opencode"), version("codex")]));
        })
    );
    const first = monitor.check("startup");
    const second = monitor.check("settings");
    releases[1]?.();
    releases[0]?.();
    const results = await Promise.all([first, second]);
    expect(published.map((availability) => availability.trigger)).toEqual(["settings"]);
    expect(results.map((availability) => availability.trigger)).toEqual(["settings", "settings"]);
  });
});
