import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/sign-windows.yml");
const lines = readFileSync(WORKFLOW_PATH, "utf8").split(/\r?\n/);

function topLevelBlock(key: string): string[] {
  const start = lines.indexOf(`${key}:`);
  if (start === -1) throw new Error(`sign-windows.yml has no top-level "${key}:"`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function jobs(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of topLevelBlock("jobs")) {
    const header = /^ {2}([\w-]+):$/.exec(line);
    if (header) {
      current = [];
      result.set(header[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return result;
}

describe("sign-windows.yml policy", () => {
  it("is only reachable through workflow_call", () => {
    const triggers = topLevelBlock("on").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
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
    for (const [name, body] of jobs()) {
      const usesSecrets = body.some((line) => line.includes("secrets."));
      const protectedJob = body.some((line) => line.trim() === "environment: release-signing");
      if (usesSecrets) expect({ name, protectedJob }).toEqual({ name, protectedJob: true });
    }
  });

  it("never interpolates inputs directly into shell scripts", () => {
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (/^\s*(- )?run: \|/.test(line)) {
        inRun = true;
        runIndent = indent;
        continue;
      }
      if (inRun && line.trim() !== "" && indent <= runIndent) inRun = false;
      const inlineRun = /^\s*(- )?run: (?!\|)/.test(line);
      if (inRun || inlineRun) expect(line).not.toMatch(/\$\{\{/);
    }
  });
});
