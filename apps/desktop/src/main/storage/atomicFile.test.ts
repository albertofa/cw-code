import { mkdtempSync, readFileSync, type OpenMode, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "./atomicFile.js";

const DIRECTORY_FD = 987_654;

const directorySync = vi.hoisted(() => ({
  dir: null as string | null,
  fsyncError: null as string | null,
  opened: 0,
  synced: 0,
  closed: 0
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn((path: PathLike, flags: OpenMode) => {
      if (directorySync.dir !== null && path === directorySync.dir) {
        directorySync.opened += 1;
        expect(flags).toBe("r");
        return DIRECTORY_FD;
      }
      return actual.openSync(path, flags);
    }),
    fsyncSync: vi.fn((fd: number) => {
      if (fd !== DIRECTORY_FD) return actual.fsyncSync(fd);
      directorySync.synced += 1;
      if (directorySync.fsyncError) throw Object.assign(new Error(directorySync.fsyncError), { code: directorySync.fsyncError });
    }),
    closeSync: vi.fn((fd: number) => {
      if (fd === DIRECTORY_FD) directorySync.closed += 1;
      else actual.closeSync(fd);
    })
  };
});

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function tempTarget(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-atomic-"));
  directorySync.dir = dir;
  return { dir, file: join(dir, "data.json") };
}

afterEach(() => {
  setPlatform(realPlatform);
  Object.assign(directorySync, { dir: null, fsyncError: null, opened: 0, synced: 0, closed: 0 });
});

describe("writeFileAtomic", () => {
  it("fsyncs the parent directory after the rename on POSIX", () => {
    setPlatform("linux");
    const { file } = tempTarget();

    writeFileAtomic(file, "{}");

    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(directorySync).toMatchObject({ opened: 1, synced: 1, closed: 1 });
  });

  it.each(["EISDIR", "EINVAL", "EPERM", "ENOTSUP"])("ignores %s from the directory fsync and still closes it", (code) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPlatform("darwin");
    const { file } = tempTarget();
    directorySync.fsyncError = code;

    expect(() => writeFileAtomic(file, "{}")).not.toThrow();

    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(directorySync).toMatchObject({ opened: 1, synced: 1, closed: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns about other directory fsync failures and still reports the committed write as successful", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPlatform("linux");
    const { dir, file } = tempTarget();
    directorySync.fsyncError = "EIO";

    expect(() => writeFileAtomic(file, "{}")).not.toThrow();

    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(directorySync.closed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dir));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EIO"));
    warn.mockRestore();
  });

  it("does not open the parent directory on Windows", () => {
    setPlatform("win32");
    const { file } = tempTarget();

    writeFileAtomic(file, "{}");

    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(directorySync).toMatchObject({ opened: 0, synced: 0, closed: 0 });
  });
});
