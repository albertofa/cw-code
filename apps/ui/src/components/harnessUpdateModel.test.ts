import { describe, expect, it } from "bun:test";
import type { DriverKind, HarnessUpdateInfo, HarnessUpdates } from "@cw-code/contracts";
import { harnessUpdateView } from "./harnessUpdateModel.js";

const NOW = 1_000_000;

function info(binary: DriverKind, patch: Partial<HarnessUpdateInfo> = {}): HarnessUpdateInfo {
  return {
    binary,
    status: "current",
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
    installMethod: "npm",
    canUpdate: true,
    updateCommand: null,
    message: null,
    checkedAt: null,
    phase: "idle",
    phaseMessage: null,
    startedAt: null,
    finishedAt: null,
    output: null,
    ...patch
  };
}

function updates(patch: Partial<Record<DriverKind, Partial<HarnessUpdateInfo>>> = {}): HarnessUpdates {
  return { claude: info("claude", patch.claude), codex: info("codex", patch.codex), opencode: info("opencode", patch.opencode) };
}

describe("harnessUpdateView", () => {
  it("returns null without data or anything to show", () => {
    expect(harnessUpdateView(undefined, NOW)).toBeNull();
    expect(harnessUpdateView(updates(), NOW)).toBeNull();
    expect(harnessUpdateView(updates({ codex: { status: "unknown" } }), NOW)).toBeNull();
  });

  it("shows a busy view while updating one harness", () => {
    const view = harnessUpdateView(updates({ claude: { phase: "running", phaseMessage: "Updating to 2.0.0" } }), NOW);
    expect(view).toMatchObject({ tone: "info", title: "Updating Claude…", lines: ["Updating to 2.0.0"], action: null, busy: true, autoHideMs: null });
  });

  it("collapses several active harnesses and takes priority over other states", () => {
    const view = harnessUpdateView(
      updates({
        claude: { phase: "queued", phaseMessage: "Waiting for 1 running turn(s) to finish" },
        codex: { phase: "running", phaseMessage: "Updating to 3.0.0" },
        opencode: { phase: "failed", finishedAt: NOW - 10, phaseMessage: "boom" }
      }),
      NOW
    );
    expect(view?.title).toBe("Updating 2 harnesses…");
    expect(view?.lines).toEqual(["Waiting for 1 running turn(s) to finish", "Updating to 3.0.0"]);
    expect(view?.busy).toBe(true);
  });

  it("shows an error view for a failed update", () => {
    const view = harnessUpdateView(updates({ codex: { phase: "failed", finishedAt: NOW - 5000, phaseMessage: "Update command exited with code 1" } }), NOW);
    expect(view).toMatchObject({
      tone: "error",
      title: "Codex update failed",
      lines: ["Update command exited with code 1"],
      action: "settings",
      actionLabel: "Details",
      busy: false,
      targets: ["codex"]
    });
  });

  it("shows a warning view for an unchanged update", () => {
    const view = harnessUpdateView(updates({ opencode: { phase: "unchanged", finishedAt: NOW - 5000, phaseMessage: "Update finished but OpenCode still reports 1.0.0" } }), NOW);
    expect(view).toMatchObject({ tone: "warning", title: "OpenCode still needs an update", action: "settings", actionLabel: "Details" });
  });

  it("uses plural titles for several failures", () => {
    const failed = { phase: "failed", finishedAt: NOW - 1, phaseMessage: "x" } as const;
    expect(harnessUpdateView(updates({ claude: failed, codex: failed }), NOW)?.title).toBe("2 harness updates failed");
    const unchanged = { phase: "unchanged", finishedAt: NOW - 1, phaseMessage: "x" } as const;
    expect(harnessUpdateView(updates({ claude: unchanged, codex: unchanged }), NOW)?.title).toBe("2 harnesses still need an update");
    const mixed = harnessUpdateView(updates({ claude: failed, codex: unchanged }), NOW);
    expect(mixed?.title).toBe("2 harness updates need attention");
    expect(mixed?.tone).toBe("error");
  });

  it("ignores failed and unchanged phases without a finish time", () => {
    expect(harnessUpdateView(updates({ claude: { phase: "failed" }, codex: { phase: "unchanged" } }), NOW)).toBeNull();
  });

  it("shows a success view for 3 seconds with the remaining time", () => {
    const state = updates({ claude: { phase: "succeeded", finishedAt: NOW - 1000, currentVersion: "2.0.0" } });
    expect(harnessUpdateView(state, NOW)).toMatchObject({
      tone: "success",
      title: "Claude updated to 2.0.0",
      lines: ["New turns use the updated version."],
      action: null,
      autoHideMs: 2000
    });
    expect(harnessUpdateView(state, NOW + 2000)).toBeNull();
  });

  it("treats a future finish time as now", () => {
    const state = updates({ claude: { phase: "succeeded", finishedAt: NOW + 60_000, currentVersion: "2.0.0" } });
    expect(harnessUpdateView(state, NOW)).toMatchObject({ tone: "success", autoHideMs: 3000 });
  });

  it("offers to cancel queued harnesses only", () => {
    const view = harnessUpdateView(updates({ claude: { phase: "queued" }, codex: { phase: "running" } }), NOW);
    expect(view?.cancelTargets).toEqual(["claude"]);
  });

  it("uses a plural success title", () => {
    const done = { phase: "succeeded", finishedAt: NOW - 500 } as const;
    expect(harnessUpdateView(updates({ claude: done, codex: done }), NOW)?.title).toBe("2 harnesses updated");
  });

  it("offers an update for behind harnesses that can update", () => {
    const view = harnessUpdateView(
      updates({
        claude: { status: "behind", currentVersion: "2.1.312", latestVersion: "2.1.314" },
        codex: { status: "behind", currentVersion: "0.5.0", latestVersion: "0.6.0", canUpdate: false }
      }),
      NOW
    );
    expect(view).toMatchObject({
      tone: "info",
      title: "2 harness updates available",
      lines: ["Claude 2.1.312 → 2.1.314", "Codex 0.5.0 → 0.6.0"],
      action: "update",
      actionLabel: "Update",
      targets: ["claude"]
    });
  });

  it("uses the singular available title", () => {
    const view = harnessUpdateView(updates({ claude: { status: "behind", currentVersion: "1.0.0", latestVersion: "1.1.0" } }), NOW);
    expect(view?.title).toBe("Harness update available");
  });

  it("falls back to opening settings when none can update", () => {
    const view = harnessUpdateView(updates({ opencode: { status: "behind", canUpdate: false, latestVersion: "2.0.0" } }), NOW);
    expect(view).toMatchObject({ action: "settings", actionLabel: "Open settings", targets: ["opencode"] });
  });

  it("changes the key when statuses, versions, phases or finish times change", () => {
    const base = harnessUpdateView(updates({ claude: { status: "behind", latestVersion: "1.1.0" } }), NOW)?.key;
    const newer = harnessUpdateView(updates({ claude: { status: "behind", latestVersion: "1.2.0" } }), NOW)?.key;
    expect(newer).not.toBe(base);
    const failedA = harnessUpdateView(updates({ claude: { phase: "failed", finishedAt: 1, phaseMessage: "x" } }), NOW)?.key;
    const failedB = harnessUpdateView(updates({ claude: { phase: "failed", finishedAt: 2, phaseMessage: "x" } }), NOW)?.key;
    expect(failedA).not.toBe(failedB);
    expect(harnessUpdateView(updates({ claude: { status: "behind", latestVersion: "1.1.0" } }), NOW + 5)?.key).toBe(base);
  });
});
