import { describe, expect, it } from "vitest";
import { planMarker } from "./planMarker.ts";
import type { RemoteRelease } from "./releaseClient.ts";
import { selectLinuxUpgradeBase, selectUpgradeBase } from "./upgradeBase.ts";

function linuxNames(version: string): string[] {
  return [`cw-code-${version}-x86_64.AppImage`, `cw-code-${version}-amd64.deb`, "latest-linux.yml", "alpha-linux.yml"];
}

function withLinux(tag: string, overrides: Partial<RemoteRelease> = {}): RemoteRelease {
  const base = release(tag, overrides);
  const names = linuxNames(tag.slice(1)).map((name, index) => ({ id: 100 + index, name, size: 10, state: "uploaded" }));
  return { ...base, assets: [...base.assets, ...names] };
}

function release(tag: string, overrides: Partial<RemoteRelease> = {}): RemoteRelease {
  const version = tag.slice(1);
  return {
    id: 1,
    tagName: tag,
    targetCommitish: "a".repeat(40),
    draft: false,
    prerelease: version.includes("-"),
    name: tag,
    body: `notes\n\n${planMarker("a".repeat(40))}`,
    htmlUrl: `https://github.com/albertofa/cw-code/releases/tag/${tag}`,
    assets: [`cw-code-Setup-${version}-x64.exe`, `cw-code-Setup-${version}-x64.exe.blockmap`, "latest.yml", "alpha.yml", "signing.json"].map((name, index) => ({
      id: index,
      name,
      size: 10,
      state: "uploaded"
    })),
    ...overrides
  };
}

const LEGACY = release("v0.0.1-alpha.21", { body: "manual upload", assets: [{ id: 1, name: "cw-code.Setup.0.0.1-alpha.21.exe", size: 10, state: "uploaded" }] });

describe("selectUpgradeBase", () => {
  it("reports a bootstrap when no release came from this pipeline (the legacy manual upload has no updater)", () => {
    expect(selectUpgradeBase({ version: "0.0.1-alpha.22", channel: "alpha" }, [LEGACY])).toMatchObject({ status: "bootstrap" });
  });

  it("picks the highest pipeline alpha below an alpha candidate", () => {
    const releases = [LEGACY, release("v0.0.1-alpha.22"), release("v0.0.1-alpha.23"), release("v0.0.1-alpha.25"), release("v0.0.1")];
    expect(selectUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, releases)).toEqual({
      status: "found",
      tag: "v0.0.1-alpha.23",
      version: "0.0.1-alpha.23",
      installer: "cw-code-Setup-0.0.1-alpha.23-x64.exe"
    });
  });

  it("lets a stable candidate upgrade from the highest pipeline release of either channel", () => {
    expect(selectUpgradeBase({ version: "0.0.2", channel: "stable" }, [release("v0.0.1"), release("v0.0.2-alpha.4")])).toMatchObject({ tag: "v0.0.2-alpha.4" });
  });

  it("never uses a stable N for an alpha candidate, because a stable client does not accept alphas", () => {
    expect(selectUpgradeBase({ version: "0.0.2-alpha.0", channel: "alpha" }, [release("v0.0.1")])).toMatchObject({ status: "none-compatible" });
  });

  it("ignores drafts, unmarked releases and releases missing a required asset", () => {
    const incomplete = release("v0.0.1-alpha.23");
    incomplete.assets = incomplete.assets.filter((asset) => asset.name !== "alpha.yml");
    const releases = [release("v0.0.1-alpha.22"), release("v0.0.1-alpha.23", { draft: true }), release("v0.0.1-alpha.23", { body: "no marker" }), incomplete];
    expect(selectUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, releases)).toMatchObject({ tag: "v0.0.1-alpha.22" });
    const starter = release("v0.0.1-alpha.22");
    starter.assets[0] = { ...starter.assets[0], state: "starter" };
    expect(selectUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, [starter])).toMatchObject({ status: "bootstrap" });
  });
});

describe("selectLinuxUpgradeBase", () => {
  it("reports a bootstrap while no pipeline release carries the Linux assets", () => {
    const result = selectLinuxUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, [LEGACY, release("v0.0.1-alpha.22"), release("v0.0.1-alpha.23")]);
    expect(result).toMatchObject({ status: "bootstrap" });
    expect(result).toMatchObject({ reason: expect.stringContaining("Linux") });
  });

  it("picks the highest pipeline alpha below an alpha candidate that carries the full Linux set", () => {
    const releases = [release("v0.0.1-alpha.24"), withLinux("v0.0.1-alpha.22"), withLinux("v0.0.1-alpha.23"), withLinux("v0.0.1-alpha.25"), withLinux("v0.0.1")];
    expect(selectLinuxUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, releases)).toEqual({
      status: "found",
      tag: "v0.0.1-alpha.23",
      version: "0.0.1-alpha.23",
      appImage: "cw-code-0.0.1-alpha.23-x86_64.AppImage",
      deb: "cw-code-0.0.1-alpha.23-amd64.deb"
    });
  });

  it("lets a stable candidate upgrade from the highest Linux-capable release of either channel", () => {
    expect(selectLinuxUpgradeBase({ version: "0.0.2", channel: "stable" }, [withLinux("v0.0.1"), withLinux("v0.0.2-alpha.4")])).toMatchObject({ tag: "v0.0.2-alpha.4" });
  });

  it("never uses a stable N for an alpha candidate", () => {
    expect(selectLinuxUpgradeBase({ version: "0.0.2-alpha.0", channel: "alpha" }, [withLinux("v0.0.1")])).toMatchObject({ status: "none-compatible" });
  });

  it("skips releases missing any Linux asset, an unmarked release or a draft", () => {
    const lackingDeb = withLinux("v0.0.1-alpha.23");
    lackingDeb.assets = lackingDeb.assets.filter((asset) => !asset.name.endsWith(".deb"));
    const lackingFeed = withLinux("v0.0.1-alpha.23");
    lackingFeed.assets = lackingFeed.assets.filter((asset) => asset.name !== "alpha-linux.yml");
    const releases = [withLinux("v0.0.1-alpha.22"), lackingDeb, lackingFeed, withLinux("v0.0.1-alpha.23", { draft: true }), withLinux("v0.0.1-alpha.23", { body: "no marker" })];
    expect(selectLinuxUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, releases)).toMatchObject({ tag: "v0.0.1-alpha.22" });
    expect(selectLinuxUpgradeBase({ version: "0.0.1-alpha.24", channel: "alpha" }, [lackingDeb])).toMatchObject({ status: "bootstrap" });
  });

  it("reports none-compatible when Linux releases exist but none is below the candidate", () => {
    expect(selectLinuxUpgradeBase({ version: "0.0.1-alpha.22", channel: "alpha" }, [withLinux("v0.0.1-alpha.22")])).toMatchObject({ status: "none-compatible" });
  });
});
