import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { browseDirectories, DriveRootsCache } from "./directoryBrowser.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cw-browse-"));
  for (const name of ["beta", "Alpha", "gamma", ".hidden", "repo/.git"]) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "file.txt"), "x");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("browseDirectories", () => {
  test("lists directories only, sorted case-insensitively, hiding dot-dirs", async () => {
    const listing = await browseDirectories(root, { home: root });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["Alpha", "beta", "gamma", "repo"]);
    expect(listing.truncated).toBe(false);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(dirname(root));
  });

  test("shows dot-dirs on request and flags git repositories", async () => {
    const listing = await browseDirectories(root, { home: root, showHidden: true });
    expect(listing.entries.map((entry) => entry.name)).toContain(".hidden");
    expect(listing.entries.find((entry) => entry.name === "repo")?.isGitRepo).toBe(true);
    expect(listing.entries.find((entry) => entry.name === "beta")?.isGitRepo).toBe(false);
  });

  test("defaults a null path to home and lists home first in roots", async () => {
    const listing = await browseDirectories(null, { home: root });
    expect(listing.path).toBe(root);
    expect(listing.roots[0]).toEqual({ label: "Home", path: root });
  });

  test("truncates at the cap", async () => {
    const listing = await browseDirectories(root, { home: root, cap: 2 });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["Alpha", "beta"]);
    expect(listing.truncated).toBe(true);
  });

  test("has no parent at a filesystem root", async () => {
    const fsRoot = parse(root).root;
    const listing = await browseDirectories(fsRoot, { home: root, readdir: async () => [] });
    expect(listing.parent).toBeNull();
  });

  test("treats an empty path like home", async () => {
    const listing = await browseDirectories("", { home: root });
    expect(listing.path).toBe(root);
  });

  test("rejects relative paths", async () => {
    await expect(browseDirectories("relative/dir", { home: root })).rejects.toThrow("path must be absolute: relative/dir");
  });

  test("maps filesystem errors to readable messages", async () => {
    const failWith = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    const missing = join(root, "missing");
    await expect(browseDirectories(missing, { home: root })).rejects.toThrow(`folder not found on the server: ${missing}`);
    await expect(browseDirectories(root, { home: root, readdir: failWith("EACCES") })).rejects.toThrow(`permission denied: ${root}`);
    await expect(browseDirectories(root, { home: root, readdir: failWith("EPERM") })).rejects.toThrow(`permission denied: ${root}`);
  });

  test("lists existing drive letters as roots on Windows and / on POSIX", async () => {
    const windows = await browseDirectories("C:\\Users", {
      platform: "win32",
      home: "C:\\Users\\me",
      readdir: async () => [],
      exists: async (path) => path === "C:\\" || path === "D:\\"
    });
    expect(windows.roots).toEqual([
      { label: "Home", path: "C:\\Users\\me" },
      { label: "C:", path: "C:\\" },
      { label: "D:", path: "D:\\" }
    ]);
    expect(windows.parent).toBe("C:\\");
    const drive = await browseDirectories("C:\\", { platform: "win32", home: "C:\\Users\\me", readdir: async () => [], exists: async () => false });
    expect(drive.parent).toBeNull();
    const posix = await browseDirectories("/srv", { platform: "linux", home: "/home/me", readdir: async () => [] });
    expect(posix.roots).toEqual([
      { label: "Home", path: "/home/me" },
      { label: "/", path: "/" }
    ]);
    expect(posix.parent).toBe("/");
  });

  test("follows symlinks to directories and skips broken ones", async () => {
    const entries = [
      { name: "link", isDirectory: () => false, isSymbolicLink: () => true },
      { name: "broken", isDirectory: () => false, isSymbolicLink: () => true },
      { name: "fileLink", isDirectory: () => false, isSymbolicLink: () => true }
    ];
    const listing = await browseDirectories("/srv", {
      platform: "linux",
      home: "/home/me",
      readdir: async () => entries,
      stat: async (path) => {
        if (path === "/srv/broken") throw new Error("ENOENT");
        return { isDirectory: () => path === "/srv/link" };
      },
      exists: async () => false
    });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["link"]);
  });

  test("probes drives in parallel, omits a hung drive and caches the roots", async () => {
    let probes = 0;
    let now = 0;
    const driveCache = new DriveRootsCache(10_000, () => now);
    const options = {
      platform: "win32" as const,
      home: "C:\Users\me",
      readdir: async () => [],
      driveProbeTimeoutMs: 20,
      driveCache,
      exists: (path: string) => {
        probes += 1;
        if (path === "Z:\\") return new Promise<boolean>(() => {});
        return Promise.resolve(path === "C:\\");
      }
    };
    const first = await browseDirectories("C:\\", options);
    expect(first.roots.map((entry) => entry.label)).toEqual(["Home", "C:"]);
    const probesAfterFirst = probes;
    await browseDirectories("C:\\", options);
    expect(probes).toBe(probesAfterFirst);
    now = 10_001;
    await browseDirectories("C:\\", options);
    expect(probes).toBeGreaterThan(probesAfterFirst);
  });

  test("checks git markers with bounded concurrency", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ name: `d${index}`, isDirectory: () => true, isSymbolicLink: () => false }));
    let active = 0;
    let peak = 0;
    const listing = await browseDirectories("/srv", {
      platform: "linux",
      home: "/home/me",
      readdir: async () => entries,
      exists: async (path) => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(1);
        active -= 1;
        return path.endsWith("d7/.git");
      }
    });
    expect(listing.entries.filter((entry) => entry.isGitRepo).map((entry) => entry.name)).toEqual(["d7"]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
  });
});
