import { describe, expect, it } from "vitest";
import { ipcErrorMessage, isFileNotFound } from "./ipcError.js";

describe("ipcErrorMessage", () => {
  it("strips the Electron invoke prefix", () => {
    const err = new Error("Error invoking remote method 'turns.start': Error: Nothing to compact yet");
    expect(ipcErrorMessage(err)).toBe("Nothing to compact yet");
  });

  it("strips a typed error name after the prefix", () => {
    const err = new Error("Error invoking remote method 'commands.list': TypeError: bad cwd");
    expect(ipcErrorMessage(err)).toBe("bad cwd");
  });

  it("keeps messages without the prefix and stringifies non-errors", () => {
    expect(ipcErrorMessage(new Error("plain failure"))).toBe("plain failure");
    expect(ipcErrorMessage("text")).toBe("text");
  });
});

describe("isFileNotFound", () => {
  it("recognizes missing-file errors from the fs bridge", () => {
    expect(isFileNotFound(new Error("Error invoking remote method 'fs.readFile': Error: ENOENT: no such file or directory"))).toBe(true);
    expect(isFileNotFound(new Error("Error invoking remote method 'fs.previewFile': Error: file not found: C:\\tmp\\a.png"))).toBe(true);
    expect(isFileNotFound(new Error("EACCES: permission denied"))).toBe(false);
  });

  it("does not treat other not-found errors as a missing file", () => {
    expect(isFileNotFound(new Error("Error invoking remote method 'sessions.get': Error: Session not found"))).toBe(false);
    expect(isFileNotFound(new Error("git not found on PATH"))).toBe(false);
    expect(isFileNotFound(new Error("directory not found: src"))).toBe(false);
  });
});
