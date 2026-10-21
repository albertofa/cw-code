import { beforeEach, describe, expect, it } from "vitest";
import {
  clearComposerDraft,
  loadComposerDraft,
  MAX_COMPOSER_DRAFTS,
  resetComposerDraftsForTests,
  saveComposerDraft
} from "./composerDrafts.js";

describe("composer drafts", () => {
  beforeEach(resetComposerDraftsForTests);

  it("returns nothing for a session that has no draft", () => {
    expect(loadComposerDraft("sess_a")).toBeNull();
  });

  it("keeps the text and attachments of each session separately", () => {
    saveComposerDraft("sess_a", "fix the login", ["src/a.ts"]);
    saveComposerDraft("sess_b", "write docs", []);
    expect(loadComposerDraft("sess_a")).toEqual({ text: "fix the login", attachments: ["src/a.ts"] });
    expect(loadComposerDraft("sess_b")).toEqual({ text: "write docs", attachments: [] });
  });

  it("keeps a draft that only has attachments", () => {
    saveComposerDraft("sess_a", "", ["shot.png"]);
    expect(loadComposerDraft("sess_a")).toEqual({ text: "", attachments: ["shot.png"] });
  });

  it("drops the entry when the draft becomes empty or blank", () => {
    saveComposerDraft("sess_a", "something", []);
    saveComposerDraft("sess_a", "  \n ", []);
    expect(loadComposerDraft("sess_a")).toBeNull();
  });

  it("does not let later edits of a loaded draft change the stored one", () => {
    saveComposerDraft("sess_a", "text", ["x.ts"]);
    const loaded = loadComposerDraft("sess_a");
    loaded?.attachments.push("y.ts");
    expect(loadComposerDraft("sess_a")?.attachments).toEqual(["x.ts"]);
  });

  it("clears one session without touching the others", () => {
    saveComposerDraft("sess_a", "a", []);
    saveComposerDraft("sess_b", "b", []);
    clearComposerDraft("sess_a");
    expect(loadComposerDraft("sess_a")).toBeNull();
    expect(loadComposerDraft("sess_b")?.text).toBe("b");
  });

  it("forgets the least recently saved drafts beyond the cap", () => {
    for (let i = 0; i < MAX_COMPOSER_DRAFTS + 5; i += 1) saveComposerDraft(`sess_${i}`, `draft ${i}`, []);
    expect(loadComposerDraft("sess_0")).toBeNull();
    expect(loadComposerDraft("sess_4")).toBeNull();
    expect(loadComposerDraft("sess_5")?.text).toBe("draft 5");
    expect(loadComposerDraft(`sess_${MAX_COMPOSER_DRAFTS + 4}`)?.text).toBe(`draft ${MAX_COMPOSER_DRAFTS + 4}`);
  });
});
