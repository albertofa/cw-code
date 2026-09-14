import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./SessionStore.js";

function makeStore(): SessionStore {
  return new SessionStore(join(mkdtempSync(join(tmpdir(), "cw-store-")), "test.db"));
}

describe("SessionStore", () => {
  it("lists all sessions across projects", () => {
    const store = makeStore();
    const p1 = store.addProject("C:/proj1");
    const p2 = store.addProject("C:/proj2");
    store.createSession(p1.id, "claude", "a");
    store.createSession(p2.id, "codex", "b");
    expect(store.listAllSessions()).toHaveLength(2);
  });
});
