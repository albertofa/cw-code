import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobBlocks, readWorkflowText, runScriptLines, topLevelBlock } from "./workflowLines.ts";

const WORKFLOW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/check-update-feed.yml");
const text = readWorkflowText(WORKFLOW_PATH);
const lines = text.split(/\r?\n/);

describe("check-update-feed.yml policy", () => {
  it("runs on a bounded schedule and by manual dispatch only", () => {
    const triggers = topLevelBlock(lines, "on").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
    expect(triggers).toEqual(["schedule:", "workflow_dispatch:"]);
    const crons = [...text.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
    expect(crons).toHaveLength(1);
    const [minute, hour] = crons[0].split(" ");
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\*\/([6-9]|1\d|2[0-4])$/);
    expect(text).not.toMatch(/pull_request|workflow_run|\bpush:/);
  });

  it("only reads, at workflow and job level", () => {
    expect(topLevelBlock(lines, "permissions").map((line) => line.trim()).filter(Boolean)).toEqual(["contents: read"]);
    expect(text).not.toMatch(/: write\b/);
    for (const body of jobBlocks(lines).values()) expect(body.join("\n")).toMatch(/permissions:\n\s+contents: read/);
  });

  it("uses no secrets, only the run's read-only token, and never interpolates expressions into scripts", () => {
    expect(text).not.toMatch(/secrets[.:]/);
    expect([...text.matchAll(/\$\{\{ github\.token \}\}/g)]).toHaveLength(1);
    expect(text).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(runScriptLines(lines).filter((line) => line.includes("${{"))).toEqual([]);
  });

  it("pins every action to a full commit SHA and never persists checkout credentials", () => {
    const uses = lines.filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d[\w.]*$/);
    const checkouts = lines.filter((line) => line.includes("uses: actions/checkout@")).length;
    expect(lines.filter((line) => line.trim() === "persist-credentials: false").length).toBe(checkouts);
  });

  it("bounds the run and installs the tooling without lifecycle scripts", () => {
    expect(text).toMatch(/timeout-minutes: \d+/);
    expect(text).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(text).toMatch(/release\.ts "\$\{args\[@\]\}"/);
    expect(text).toMatch(/args=\(monitor-feed --attempts \d --delay-seconds \d+\)/);
  });

  it("never publishes, edits releases, opens issues or uploads artifacts", () => {
    expect(text).not.toMatch(/gh (release|issue|pr|api)\b/);
    expect(text).not.toMatch(/upload-artifact|github-script|--publish/);
    expect(text).not.toMatch(/issues:|environment:/);
  });
});
