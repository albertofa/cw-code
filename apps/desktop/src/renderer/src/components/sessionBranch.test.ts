import { describe, expect, it } from "bun:test";
import { keepLabel, mismatchSentence, parseBranchMismatchError, sendHereLabel } from "./sessionBranch.js";

describe("mismatch wording", () => {
  it("names the folder branch", () => {
    const mismatch = { sessionBranch: "cw/a", folderBranch: "main", folderHead: "main" };
    expect(mismatchSentence("widgets", mismatch)).toBe("widgets is on main, not this session's branch cw/a.");
    expect(keepLabel(mismatch)).toBe("Keep working on main");
    expect(sendHereLabel(mismatch)).toBe("Send on main");
  });

  it("describes a detached HEAD", () => {
    const mismatch = { sessionBranch: "cw/a", folderBranch: "HEAD", folderHead: "HEAD" };
    expect(mismatchSentence("widgets", mismatch)).toBe("widgets is in a detached HEAD state, not on this session's branch cw/a.");
    expect(keepLabel(mismatch)).toBe("Keep working here");
    expect(sendHereLabel(mismatch)).toBe("Send here");
  });
});

describe("parseBranchMismatchError", () => {
  const sentence = "widgets is on main, not this session's branch cw/a.";

  it("extracts the text after the marker", () => {
    expect(parseBranchMismatchError(`[cw-branch-mismatch] ${sentence}`)).toEqual({ text: sentence });
  });

  it("drops the Electron invoke prefix", () => {
    const message = `Error invoking remote method 'turn:start': Error: [cw-branch-mismatch] ${sentence}`;
    expect(parseBranchMismatchError(message)).toEqual({ text: sentence });
  });

  it("stops at the end of the line", () => {
    expect(parseBranchMismatchError(`[cw-branch-mismatch] ${sentence}
    at stack`)).toEqual({ text: sentence });
  });

  it("is null for other errors", () => {
    expect(parseBranchMismatchError("Error invoking remote method 'turn:start': Error: boom")).toBeNull();
    expect(parseBranchMismatchError("")).toBeNull();
  });

  it("is null when the marker has no text", () => {
    expect(parseBranchMismatchError("[cw-branch-mismatch]  ")).toBeNull();
  });
});
