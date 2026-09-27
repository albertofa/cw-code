import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows");

interface Step {
  name?: string;
  run?: unknown;
  uses?: unknown;
}

interface Job {
  steps?: Step[];
  uses?: unknown;
}

function parseWorkflow(file: string): { jobs: Record<string, Job> } {
  const parsed = load(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));
  if (!parsed || typeof parsed !== "object" || !("jobs" in parsed)) throw new Error(`${file} has no jobs`);
  return parsed as { jobs: Record<string, Job> };
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((file) => /\.ya?ml$/.test(file));

describe("workflow structure", () => {
  it.each(workflowFiles)("%s parses and every step has exactly one of run or uses", (file) => {
    const { jobs } = parseWorkflow(file);
    for (const [jobId, job] of Object.entries(jobs)) {
      if (job.uses !== undefined) continue;
      expect(Array.isArray(job.steps), `${file} job ${jobId} has steps`).toBe(true);
      for (const step of job.steps ?? []) {
        const label = `${file} job ${jobId} step ${step.name ?? "(unnamed)"}`;
        expect(step.run === undefined ? 0 : 1, label).not.toBe(step.uses === undefined ? 0 : 1);
      }
    }
  });

  it("sign-windows.yml package-app checks out the gate tooling before running the bundle gate", () => {
    const steps = parseWorkflow("sign-windows.yml").jobs["package-app"]?.steps ?? [];
    const names = steps.map((step) => step.name ?? "");
    const checkout = names.indexOf("Check out the gate tooling from the signing workflow's commit");
    const gate = names.indexOf("Reject any update autotest path in the packaged app");
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(checkout);
    expect(String(steps[checkout]?.uses)).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
  });
});
