import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBackups } from "./backups.js";
import { metadataSchemaFor, openMetadataStores } from "./metadataStores.js";
import { restoreBackup, startFresh } from "./recovery.js";

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

  it("turns an unexpected error while opening a store into a visible io issue", () => {
    const { dir } = paths();
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "", "utf8");

    const opened = openMetadataStores({ dbPath: join(blocker, "cw-code.db"), settingsPath: join(dir, "cw-settings.json") });

    if (opened.ok) throw new Error("expected recovery issues");
    expect(opened.issues).toHaveLength(1);
    expect(opened.issues[0]).toMatchObject({ store: "sessions", kind: "io", file: join(blocker, "cw-code.db.json") });
    expect(opened.issues[0].message).toMatch(/could not open the file: E[A-Z]+/);
  });

  it.runIf(process.platform === "win32")("reports a locked file that cannot be rewritten during load instead of throwing", () => {
    const { dbPath, settingsPath, sessionsFile } = paths();
    const content = JSON.stringify({
      schemaVersion: 1,
      projects: [],
      sessions: [{ id: "sess_a", projectId: "proj_a", status: "working", driver: "claude", title: "a", resumeCursor: "", createdAt: 1, updatedAt: 1 }]
    });
    writeFileSync(sessionsFile, content, "utf8");
    chmodSync(sessionsFile, 0o444);
    try {
      const opened = openMetadataStores({ dbPath, settingsPath });

      if (opened.ok) throw new Error("expected recovery issues");
      expect(opened.issues[0]).toMatchObject({ store: "sessions", kind: "io", file: sessionsFile });
      expect(opened.issues[0].message).toMatch(/EPERM|EACCES/);
      expect(readFileSync(sessionsFile, "utf8")).toBe(content);
    } finally {
      chmodSync(sessionsFile, 0o644);
    }
  });

  it.each([
    ["corrupt", (file: string) => writeFileSync(file, "broken{", "utf8")],
    ["missing", (file: string) => rmSync(file)]
  ])("keeps the previous last-good backup restorable after starting a %s file fresh", (kind, breakFile) => {
    const { dbPath, settingsPath, sessionsFile } = paths();
    const first = openMetadataStores({ dbPath, settingsPath });
    if (!first.ok) throw new Error("expected the initial open to succeed");
    first.sessionStore.addProject("/fixture/kept");
    expect(openMetadataStores({ dbPath, settingsPath }).ok).toBe(true);
    breakFile(sessionsFile);
    const broken = openMetadataStores({ dbPath, settingsPath });
    if (broken.ok) throw new Error("expected recovery issues");
    expect(broken.issues[0]).toMatchObject({ store: "sessions", kind });

    const fresh = startFresh(sessionsFile, metadataSchemaFor("sessions"));
    const reopened = openMetadataStores({ dbPath, settingsPath });

    if (!reopened.ok) throw new Error("expected the fresh store to open");
    expect(reopened.sessionStore.listProjects()).toEqual([]);
    const archived = listBackups(sessionsFile, metadataSchemaFor("sessions")).find((backup) => backup.path === fresh.archivedLastGood);
    expect(archived).toMatchObject({ valid: true, label: expect.stringMatching(/^last good \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/) });

    restoreBackup(sessionsFile, archived!.path, metadataSchemaFor("sessions"));
    const restored = openMetadataStores({ dbPath, settingsPath });
    if (!restored.ok) throw new Error("expected the restored store to open");
    expect(restored.sessionStore.listProjects().map((project) => project.rootPath)).toEqual(["/fixture/kept"]);
  });
});
