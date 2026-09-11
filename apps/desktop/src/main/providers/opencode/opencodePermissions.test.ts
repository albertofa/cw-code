import { describe, expect, it } from "vitest";
import {
  opencodePermissionReply,
  parseOpencodePermissionAsked,
  parseOpencodePermissionList,
  parseOpencodePermissionReplied,
  permissionApprovalOf,
  type ParsedOpencodePermission
} from "./opencodePermissions.js";

const liveV2Asked = {
  id: "evt_091918389001F3T0IitH5R8TF1",
  type: "permission.v2.asked",
  properties: {
    id: "per_091918388001GK2k7I6Ll0Ypv7",
    sessionID: "ses_f6e73c3dcffeem8bL2ncnZP01S",
    action: "edit",
    resources: ["Users/Alberto/scratchpad/opencode-probe/probe-manual.txt"],
    metadata: { filepath: "probe-manual.txt" }
  }
};

const liveV2Replied = {
  id: "evt_091922796001nrO2mMjlyKV6sb",
  type: "permission.v2.replied",
  properties: {
    sessionID: "ses_f6e73c3dcffeem8bL2ncnZP01S",
    requestID: "per_091918388001GK2k7I6Ll0Ypv7",
    reply: "once"
  }
};

const v1Asked = {
  id: "evt_1",
  type: "permission.asked",
  properties: {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["echo hi", "ls *"],
    metadata: { command: ["echo hi"], description: "greet" },
    always: ["echo *"],
    tool: { messageID: "msg_1", callID: "call_1" }
  }
};

describe("parseOpencodePermissionAsked", () => {
  it("normalizes the live v2 wire shape (action/resources, missing always/tool)", () => {
    expect(parseOpencodePermissionAsked(liveV2Asked)).toEqual({
      requestId: "per_091918388001GK2k7I6Ll0Ypv7",
      sessionID: "ses_f6e73c3dcffeem8bL2ncnZP01S",
      permission: "edit",
      patterns: ["Users/Alberto/scratchpad/opencode-probe/probe-manual.txt"],
      metadata: { filepath: "probe-manual.txt" },
      always: []
    });
  });

  it("normalizes the v1 shape (permission/patterns/always/tool)", () => {
    expect(parseOpencodePermissionAsked(v1Asked)).toEqual({
      requestId: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["echo hi", "ls *"],
      metadata: { command: ["echo hi"], description: "greet" },
      always: ["echo *"],
      tool: { messageID: "msg_1", callID: "call_1" }
    });
  });

  it("reads v2 fields from a data envelope with save/source.tool", () => {
    const parsed = parseOpencodePermissionAsked({
      id: "evt_2",
      type: "permission.v2.asked",
      data: {
        id: "per_2",
        sessionID: "ses_2",
        action: "external_directory",
        resources: ["/*"],
        save: ["/*"],
        metadata: {},
        source: { type: "tool", messageID: "msg_9", callID: "call_9" }
      }
    });
    expect(parsed).toMatchObject({
      requestId: "per_2",
      sessionID: "ses_2",
      permission: "external_directory",
      patterns: ["/*"],
      always: ["/*"],
      tool: { messageID: "msg_9", callID: "call_9" }
    });
  });

  it("defaults missing metadata/always/patterns instead of failing", () => {
    expect(
      parseOpencodePermissionAsked({
        type: "permission.asked",
        properties: { id: "per_3", sessionID: "ses_3", permission: "bash" }
      })
    ).toEqual({
      requestId: "per_3",
      sessionID: "ses_3",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: []
    });
  });

  it("rejects malformed payloads and other event types", () => {
    expect(parseOpencodePermissionAsked({ type: "session.updated", properties: {} })).toBeNull();
    expect(parseOpencodePermissionAsked({ type: "permission.asked", properties: { sessionID: "s", permission: "bash" } })).toBeNull();
    expect(parseOpencodePermissionAsked({ type: "permission.asked", properties: { id: "p", permission: "bash" } })).toBeNull();
    expect(parseOpencodePermissionAsked({ type: "permission.asked", properties: { id: "p", sessionID: "s" } })).toBeNull();
    expect(parseOpencodePermissionAsked(null)).toBeNull();
    expect(parseOpencodePermissionAsked([])).toBeNull();
  });
});

describe("parseOpencodePermissionReplied", () => {
  it("maps the live v2.replied shape", () => {
    expect(parseOpencodePermissionReplied(liveV2Replied)).toEqual({
      requestID: "per_091918388001GK2k7I6Ll0Ypv7",
      sessionID: "ses_f6e73c3dcffeem8bL2ncnZP01S",
      reply: "once"
    });
  });

  it("maps v1 replied and legacy updated shapes", () => {
    expect(
      parseOpencodePermissionReplied({ type: "permission.replied", properties: { sessionID: "s", requestID: "per_1", reply: "always" } })
    ).toEqual({ requestID: "per_1", sessionID: "s", reply: "always" });
    expect(
      parseOpencodePermissionReplied({
        type: "permission.updated",
        properties: { id: "per_2", sessionID: "s", type: "bash", pattern: "echo *", messageID: "m", callID: "c", response: "reject" }
      })
    ).toEqual({ requestID: "per_2", sessionID: "s", reply: "reject" });
    expect(parseOpencodePermissionReplied({ type: "permission.replied", properties: { sessionID: "s" } })).toBeNull();
    expect(parseOpencodePermissionReplied({ type: "session.updated", properties: {} })).toBeNull();
  });
});

describe("parseOpencodePermissionList", () => {
  const entry = liveV2Asked.properties;

  it("unwraps data envelopes and bare arrays", () => {
    expect(parseOpencodePermissionList({ data: [entry] })).toHaveLength(1);
    expect(parseOpencodePermissionList([entry])).toHaveLength(1);
    expect(parseOpencodePermissionList({ data: [entry] })[0]).toMatchObject({ requestId: entry.id, permission: "edit" });
  });

  it("returns empty for empty or non-list payloads", () => {
    expect(parseOpencodePermissionList({ data: [] })).toEqual([]);
    expect(parseOpencodePermissionList([])).toEqual([]);
    expect(parseOpencodePermissionList("<!doctype html>")).toEqual([]);
    expect(parseOpencodePermissionList(null)).toEqual([]);
    expect(parseOpencodePermissionList({ data: [null, { id: "x" }] })).toEqual([]);
  });
});

describe("opencodePermissionReply", () => {
  it("maps all four decisions to server reply values", () => {
    expect(opencodePermissionReply("accept")).toBe("once");
    expect(opencodePermissionReply("acceptForSession")).toBe("once");
    expect(opencodePermissionReply("acceptGlobal")).toBe("always");
    expect(opencodePermissionReply("decline")).toBe("reject");
    expect(opencodePermissionReply("cancel")).toBe("reject");
  });
});

describe("permissionApprovalOf", () => {
  const base: ParsedOpencodePermission = {
    requestId: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["rm -rf /tmp/x", "ls *"],
    metadata: {},
    always: ["ls *"]
  };

  it("maps command kinds and carries permission detail", () => {
    const event = permissionApprovalOf(base, "turn-1", "C:\\proj");
    expect(event.type).toBe("approval.request");
    if (event.type !== "approval.request") throw new Error("expected approval.request");
    expect(event.turnId).toBe("turn-1");
    expect(event.request.kind).toBe("command");
    expect(event.request.decisions).toEqual(["accept", "acceptForSession", "acceptGlobal", "decline"]);
    expect(event.request.title).toContain("bash");
    expect(event.request.title).toContain("rm -rf /tmp/x");
    expect(event.request.details).toContain("bash");
    expect(event.request.details).toContain("rm -rf /tmp/x");
    expect(event.request.details).toContain("Always would allow:");
    expect(event.request.details).toContain("ls *");
    expect(event.request.permission).toBe("bash");
    expect(event.request.patterns).toEqual(["rm -rf /tmp/x", "ls *"]);
    expect(event.request.always).toEqual(["ls *"]);
    expect(event.request.toolName).toBe("bash");
    expect(event.request.cwd).toBe("C:\\proj");
  });

  it("maps fileChange kinds by prefix", () => {
    for (const permission of ["edit", "write", "patch"]) {
      const event = permissionApprovalOf({ ...base, permission, patterns: ["a.txt"], always: [] }, "t");
      if (event.type !== "approval.request") throw new Error("expected approval.request");
      expect(event.request.kind).toBe("fileChange");
    }
  });

  it("maps shell/command prefixes to command and everything else to permissions", () => {
    for (const permission of ["shell", "command"]) {
      const event = permissionApprovalOf({ ...base, permission, patterns: [], always: [] }, "t");
      if (event.type !== "approval.request") throw new Error("expected approval.request");
      expect(event.request.kind).toBe("command");
    }
    const event = permissionApprovalOf({ ...base, permission: "external_directory", patterns: ["/*"], always: [] }, "t");
    if (event.type !== "approval.request") throw new Error("expected approval.request");
    expect(event.request.kind).toBe("permissions");
    expect(event.request.title).toContain("external_directory");
  });
});
