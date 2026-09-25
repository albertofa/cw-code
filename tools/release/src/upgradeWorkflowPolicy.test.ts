import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWorkflowText, runScriptLines, topLevelBlock } from "./workflowLines.ts";

const WORKFLOW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/upgrade-test.yml");
const text = readWorkflowText(WORKFLOW_PATH);
const lines = text.split(/\r?\n/);

describe("upgrade-test.yml policy", () => {
  it("runs on dispatch, nightly and on pull requests that touch the update path", () => {
    const triggers = topLevelBlock(lines, "on").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
    expect(triggers).toEqual(["workflow_dispatch:", "schedule:", "pull_request:"]);
    for (const path of [
      "pnpm-lock.yaml",
      "apps/desktop/package.json",
      "apps/desktop/src/main/updates/**",
      "apps/desktop/src/main/shutdown/**",
      "apps/desktop/src/main/storage/**",
      "apps/desktop/src/main/storage/__fixtures__/**",
      "apps/desktop/src/main/sessions/**",
      "apps/desktop/src/main/settings/**",
      "apps/desktop/src/main/paths/**",
      "apps/desktop/src/main/index.ts",
      "apps/desktop/electron-builder*.yml",
      "apps/desktop/electron.vite.config.ts",
      "packages/contracts/src/updates.ts",
      "packages/contracts/src/shutdown.ts",
      "packages/contracts/src/settings.ts",
      "packages/contracts/src/startup.ts",
      "scripts/verify-installed-upgrade.mjs",
      "scripts/lib/**",
      "scripts/fixtures/**",
      "tools/release/src/feed*.ts",
      "tools/release/src/rehash.ts",
      "tools/release/src/updateInfoYaml.ts",
      "tools/release/src/semver.ts",
      "tools/release/src/upgradeScenarios.ts",
      ".github/workflows/upgrade-test.yml"
    ]) {
      expect(text).toContain(`- "${path}"`);
    }
  });

  it("only reads the repository", () => {
    expect(topLevelBlock(lines, "permissions").map((line) => line.trim()).filter(Boolean)).toEqual(["contents: read"]);
  });

  it("uses no secrets and never interpolates expressions into scripts", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(runScriptLines(lines).filter((line) => line.includes("${{"))).toEqual([]);
  });

  it("pins every action to a full commit SHA and never persists checkout credentials", () => {
    const uses = lines.filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d[\w.]*$/);
    const checkouts = lines.filter((line) => line.includes("uses: actions/checkout@")).length;
    expect(lines.filter((line) => line.trim() === "persist-credentials: false").length).toBe(checkouts);
  });

  it("bounds the job and keeps evidence for seven days", () => {
    expect(text).toMatch(/runs-on: windows-latest/);
    expect(text).toMatch(/timeout-minutes: \d+/);
    expect(text).toMatch(/retention-days: 7/);
    expect(text).toMatch(/if: always\(\)/);
  });

  it("never publishes", () => {
    expect(text).not.toMatch(/--publish (always|onTag|onTagOrDraft)/);
    expect(text).not.toMatch(/gh release (create|upload|edit)/);
    expect(text).not.toMatch(/contents: write/);
  });
});
