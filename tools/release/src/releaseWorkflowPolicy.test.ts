import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobBlocks, readWorkflowText, runScriptLines, topLevelBlock } from "./workflowLines.ts";

const WORKFLOW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/release.yml");
const text = readWorkflowText(WORKFLOW_PATH);
const lines = text.split(/\r?\n/);
const jobs = jobBlocks(lines);

function job(name: string): string {
  const body = jobs.get(name);
  if (!body) throw new Error(`release.yml has no job "${name}"`);
  return body.join("\n");
}

describe("release.yml policy", () => {
  it("runs only after a CI run on main or by manual dispatch, never for pull requests", () => {
    const triggers = topLevelBlock(lines, "on").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
    expect(triggers).toEqual(["workflow_run:", "workflow_dispatch:"]);
    expect(topLevelBlock(lines, "on").join("\n")).toMatch(/workflows: \["CI"\]\n\s+branches: \[main\]/);
    expect(text).not.toMatch(/pull_request/);
  });

  it("guards the plan job to main, successful push CI runs of this repository", () => {
    const plan = job("plan");
    expect(plan).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    expect(plan).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(plan).toContain("github.event.workflow_run.event == 'push'");
    expect(plan).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(plan).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  });

  it("defaults to validation and fails a publish request early unless publishing is enabled", () => {
    expect(topLevelBlock(lines, "on").join("\n")).toMatch(/mode:[\s\S]*default: validate/);
    expect(job("plan")).toMatch(/PUBLISHING_ENABLED: \$\{\{ vars\.CW_RELEASE_PUBLISHING_ENABLED \}\}/);
    expect(job("plan")).toContain('[ "$PUBLISHING_ENABLED" = "true" ] || fail');
    expect(job("publish")).toMatch(/if: needs\.plan\.outputs\.mode == 'publish' && vars\.CW_RELEASE_PUBLISHING_ENABLED == 'true'/);
    expect(job("publish")).toMatch(/PUBLISHING_ENABLED: \$\{\{ vars\.CW_RELEASE_PUBLISHING_ENABLED \}\}[\s\S]*if \[ "\$PUBLISHING_ENABLED" != "true" \]; then[\s\S]*exit 1[\s\S]*release\.ts publish/);
  });

  it("rejects stable-only inputs on an alpha run", () => {
    expect(job("plan")).toContain('if [ "$CHANNEL" = "alpha" ] && { [ -n "$CANDIDATE" ] || [ -n "$EXPECTED_SHA" ]; }; then');
  });

  it("keeps validation and publication in separate per-channel groups and serializes every publish job", () => {
    expect(topLevelBlock(lines, "concurrency").map((line) => line.trim()).filter(Boolean)).toEqual([
      "group: release-${{ inputs.mode == 'publish' && 'publish' || 'validate' }}-${{ inputs.channel || 'alpha' }}",
      "cancel-in-progress: false"
    ]);
    expect(job("publish")).toMatch(/concurrency:\n\s+group: release-publish\n\s+cancel-in-progress: false/);
  });

  it("runs the gate tooling from the workflow's own commit; only verify-source checks out the source SHA", () => {
    const checkoutRefs = [...text.matchAll(/uses: actions\/checkout@[^\n]+\n(?:\s+#[^\n]*\n)?\s+with:\n\s+ref: ([^\n]+)/g)].map((match) => match[1].trim());
    expect(checkoutRefs).toHaveLength(lines.filter((line) => line.includes("uses: actions/checkout@")).length);
    expect(checkoutRefs.filter((ref) => ref !== "${{ github.workflow_sha }}")).toEqual(["${{ needs.plan.outputs.sha }}"]);
    expect(job("verify-source")).toContain("node tooling/scripts/verify-installed-upgrade.mjs --assert-production-bundle");
    expect(job("plan")).toContain('--sha "$SOURCE"');
  });

  it("installs without lifecycle scripts wherever only the release tooling runs", () => {
    for (const name of ["plan", "publish", "verify-publication"]) expect(job(name)).toContain("pnpm install --frozen-lockfile --ignore-scripts");
  });

  it("reads the repository by default and grants contents: write only to the protected publish job", () => {
    expect(topLevelBlock(lines, "permissions").map((line) => line.trim()).filter(Boolean)).toEqual(["contents: read"]);
    for (const [name, body] of jobs) {
      const writes = body.some((line) => /\bwrite\b/.test(line) && /^\s+[\w-]+: write$/.test(line));
      expect({ name, writes }).toEqual({ name, writes: name === "publish" });
    }
    expect(job("publish")).toMatch(/environment: release-publish/);
  });

  it("never touches secrets; signing secrets stay inside sign-windows.yml's protected jobs", () => {
    expect(text).not.toMatch(/secrets[.:]/);
    expect(job("sign")).toMatch(/uses: \.\/\.github\/workflows\/sign-windows\.yml/);
    expect(job("sign")).toMatch(/production: \$\{\{ needs\.plan\.outputs\.production == 'true' \}\}/);
  });

  it("chains build, signing, verification and publication so nothing publishes without every gate", () => {
    expect(job("verify-source")).toMatch(/needs: plan/);
    expect(job("sign")).toMatch(/needs: \[plan, verify-source\]/);
    expect(job("verify-candidate")).toMatch(/needs: \[plan, sign\]/);
    expect(job("publish")).toMatch(/needs: \[plan, verify-candidate\]/);
    expect(job("verify-publication")).toMatch(/needs: \[plan, publish\]/);
    const candidate = job("verify-candidate");
    for (const gate of ["check-signing-manifest", "stage-release-set", "validate-release-assets", "verify-windows-package.mjs --dist release-full --install", "--production-bytes"]) {
      expect(candidate).toContain(gate);
    }
    expect(job("verify-source")).toMatch(/pnpm typecheck[\s\S]*pnpm test[\s\S]*pnpm build/);
  });

  it("checks the published release anonymously", () => {
    const check = job("verify-publication");
    expect(check).toContain("check-published");
    expect(check).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|github\.token/);
    expect(check).toMatch(/contents: read/);
    expect(check).toContain("if: always() && needs.publish.outputs.published == 'true'");
    expect(job("publish")).toContain("published: ${{ steps.publish.outputs.published }}");
  });

  it("pins every action to a full commit SHA and never persists checkout credentials", () => {
    const uses = lines.filter((line) => /^\s*(- )?uses: (?!\.\/)/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d[\w.]*$/);
    const checkouts = lines.filter((line) => line.includes("uses: actions/checkout@")).length;
    expect(lines.filter((line) => line.trim() === "persist-credentials: false").length).toBe(checkouts);
  });

  it("passes inputs through env and never interpolates expressions into scripts", () => {
    expect(runScriptLines(lines).filter((line) => line.includes("${{"))).toEqual([]);
  });

  it("keeps release artifacts for 30 days, separate from CI artifacts, and never caches or overwrites", () => {
    expect(lines.filter((line) => /retention-days:/.test(line)).map((line) => line.trim())).toEqual(Array(3).fill("retention-days: 30"));
    expect(lines.filter((line) => /^\s*(cache|overwrite):/.test(line))).toEqual([]);
  });

  it("publishes only through the publish command, never with electron-builder or raw gh release writes", () => {
    expect(text).not.toMatch(/--publish (always|onTag|onTagOrDraft)/);
    expect(text).not.toMatch(/gh release (create|upload|edit|delete)/);
    expect(text).not.toMatch(/--clobber/);
    expect(job("publish")).toContain("release.ts publish");
    expect(text.match(/release\.ts publish/g)).toHaveLength(1);
  });
});
