import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobBlocks, runScriptLines, topLevelBlock } from "./workflowLines.ts";

const WORKFLOW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/sign-windows.yml");
const lines = readFileSync(WORKFLOW_PATH, "utf8").split(/\r?\n/);

describe("sign-windows.yml policy", () => {
  it("is only reachable through workflow_call", () => {
    const triggers = topLevelBlock(lines, "on").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
    expect(triggers).toEqual(["workflow_call:"]);
  });

  it("pins every action to a full commit SHA with a version comment", () => {
    const uses = lines.filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d[\w.]*$/);
    }
  });

  it("never persists checkout credentials", () => {
    const checkouts = lines.filter((line) => line.includes("uses: actions/checkout@")).length;
    const disabled = lines.filter((line) => line.trim() === "persist-credentials: false").length;
    expect(checkouts).toBeGreaterThan(0);
    expect(disabled).toBe(checkouts);
  });

  it("exposes secrets only to jobs bound to the protected release-signing environment", () => {
    for (const [name, body] of jobBlocks(lines)) {
      const usesSecrets = body.some((line) => line.includes("secrets."));
      const protectedJob = body.some((line) => line.trim() === "environment: release-signing");
      if (usesSecrets) expect({ name, protectedJob }).toEqual({ name, protectedJob: true });
    }
  });

  it("finds script lines in every block scalar style", () => {
    const sample = ["      - run: echo ${{ a }}", "        run: >-", "          echo ${{ b }}", "        run: |+", "          echo ${{ c }}", "        env:", "          X: ${{ d }}"];
    expect(runScriptLines(sample).filter((line) => line.includes("${{"))).toHaveLength(3);
  });

  it("never interpolates expressions directly into shell scripts", () => {
    expect(runScriptLines(lines).filter((line) => /\$\{\{/.test(line))).toEqual([]);
  });

  it("runs every gate script from the tooling checkout of the workflow's own commit", () => {
    const gateLines = lines.filter((line) => /verify-signatures\.ps1|tree-digest\.ps1|release\.ts (rehash|signing-manifest|check-signing-manifest)|release\.ts "\$\{args/.test(line));
    expect(gateLines.length).toBeGreaterThan(0);
    for (const line of gateLines) expect(line).toContain("tooling/");
    const toolingCheckouts = lines.filter((line) => line.trim() === "path: tooling").length;
    const workflowShaRefs = lines.filter((line) => line.trim() === "ref: ${{ job.workflow_sha }}").length;
    expect(toolingCheckouts).toBeGreaterThan(0);
    expect(workflowShaRefs).toBe(toolingCheckouts);
  });

  it("keeps intermediate artifacts for 3 days, long enough for a delayed environment approval, and the final set for 14", () => {
    const retention = lines.filter((line) => /retention-days:/.test(line)).map((line) => line.trim());
    expect(retention).toEqual([...Array(5).fill("retention-days: 3"), "retention-days: 14"]);
  });

  it("binds check-signing-manifest to the requested version, source SHA and run", () => {
    expect(lines.join("\n")).toMatch(/check-signing-manifest [^\n]*\n\s+--expected-version "\$VERSION" --expected-source-sha "\$SOURCE_SHA" --expected-run-id "\$RUN_ID"/);
  });

  it("uses no dependency cache and never overwrites artifacts", () => {
    expect(lines.filter((line) => /^\s*(cache|overwrite):/.test(line))).toEqual([]);
  });
});
