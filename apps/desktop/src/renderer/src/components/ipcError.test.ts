import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "./ipcError.js";

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
