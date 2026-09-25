import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMetadataStores } from "./metadataStores.js";

function paths(): { dir: string; dbPath: string; settingsPath: string; sessionsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-metadata-"));
  return { dir, dbPath: join(dir, "cw-code.db"), settingsPath: join(dir, "cw-settings.json"), sessionsFile: join(dir, "cw-code.db.json") };
}

describe("openMetadataStores", () => {
  it("opens both stores when their files are valid or missing", () => {
    const { dbPath, settingsPath } = paths();
    const opened = openMetadataStores({ dbPath, settingsPath });
    expect(opened.ok).toBe(true);
  });

  it("reports every broken file with its backups instead of opening either store", () => {
    const { dbPath, settingsPath, sessionsFile } = paths();
    const first = openMetadataStores({ dbPath, settingsPath });
    if (!first.ok) throw new Error("expected the initial open to succeed");
    first.sessionStore.addProject("/fixture/project");
    const valid = openMetadataStores({ dbPath, settingsPath });
    expect(valid.ok).toBe(true);
    writeFileSync(sessionsFile, "broken{", "utf8");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 5 }), "utf8");

    const opened = openMetadataStores({ dbPath, settingsPath });

    if (opened.ok) throw new Error("expected recovery issues");
    expect(opened.issues.map((issue) => [issue.store, issue.kind, issue.file])).toEqual([
      ["settings", "future-schema", settingsPath],
      ["sessions", "corrupt", sessionsFile]
    ]);
    expect(opened.issues[0]).toMatchObject({ foundVersion: 5, supportedVersion: 1 });
    expect(opened.issues[1].backups).toEqual([
      expect.objectContaining({ path: `${sessionsFile}.last-good.bak`, label: "last good", valid: true })
    ]);
    expect(JSON.parse(readFileSync(`${sessionsFile}.last-good.bak`, "utf8"))).toMatchObject({ projects: [{ rootPath: "/fixture/project" }] });
    expect(readFileSync(sessionsFile, "utf8")).toBe("broken{");
  });

  it("reports a single broken file while leaving the valid one usable on the next start", () => {
    const { dbPath, settingsPath, sessionsFile } = paths();
    writeFileSync(sessionsFile, '{"projects":"nope","sessions":[]}', "utf8");

    const opened = openMetadataStores({ dbPath, settingsPath });

    if (opened.ok) throw new Error("expected recovery issues");
    expect(opened.issues).toHaveLength(1);
    expect(opened.issues[0]).toMatchObject({ store: "sessions", kind: "invalid-shape", backups: [] });
  });
});
