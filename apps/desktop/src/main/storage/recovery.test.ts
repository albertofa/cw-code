import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBackups, restoreBackup } from "./recovery.js";
import { isMetadataDocument, lastGoodBackupPath, migrationBackupPath, type MetadataSchema } from "./versionedJson.js";

const schema: MetadataSchema = {
  kind: "settings",
  currentVersion: 1,
  validate: (raw) => (isMetadataDocument(raw) && Array.isArray(raw.items) ? null : "items must be an array")
};

function setup(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-recovery-"));
  return { dir, file: join(dir, "cw-settings.json") };
}

describe("listBackups", () => {
  it("lists only this file's backups with their validity, last good first", () => {
    const { dir, file } = setup();
    writeFileSync(file, "broken{", "utf8");
    writeFileSync(migrationBackupPath(file, 0), '{"items":["v0"]}', "utf8");
    writeFileSync(lastGoodBackupPath(file), '{"schemaVersion":1,"items":["good"]}', "utf8");
    writeFileSync(join(dir, "cw-settings.json.broken-2026-01-01T00-00-00-000Z"), '{"items":[]}', "utf8");
    writeFileSync(join(dir, "cw-settings.json.123.abc.tmp"), '{"items":[]}', "utf8");
    writeFileSync(join(dir, "other.json.last-good.bak"), '{"items":[]}', "utf8");

    const backups = listBackups(file, schema);

    expect(backups.map((b) => [basename(b.path), b.label, b.valid])).toEqual([
      ["cw-settings.json.last-good.bak", "last good", true],
      ["cw-settings.json.v0.bak", "migration v0", true]
    ]);
    expect(backups.every((b) => b.modifiedAt > 0 && b.reason === undefined)).toBe(true);
  });

  it("marks corrupt, invalid, newer-schema and non-file backups as not restorable with a reason", () => {
    const { file } = setup();
    writeFileSync(lastGoodBackupPath(file), '{"schemaVersion":2,"items":[]}', "utf8");
    writeFileSync(migrationBackupPath(file, 0), "nope", "utf8");
    writeFileSync(migrationBackupPath(file, 1), '{"schemaVersion":1,"items":"x"}', "utf8");
    mkdirSync(migrationBackupPath(file, 2));

    const byLabel = new Map(listBackups(file, schema).map((b) => [b.label, b]));

    expect(byLabel.get("last good")).toMatchObject({ valid: false, reason: expect.stringContaining("newer schema") });
    expect(byLabel.get("migration v0")).toMatchObject({ valid: false, reason: expect.stringContaining("corrupt JSON") });
    expect(byLabel.get("migration v1")).toMatchObject({ valid: false, reason: expect.stringContaining("items must be an array") });
    expect(byLabel.get("migration v2")).toMatchObject({ valid: false, reason: "not a regular file" });
  });
});

describe("restoreBackup", () => {
  it("keeps the current file as a .broken copy and restores the backup bytes", () => {
    const { dir, file } = setup();
    writeFileSync(file, "broken{", "utf8");
    const backup = lastGoodBackupPath(file);
    const backupBytes = '{"schemaVersion":1,"items":["good"]}';
    writeFileSync(backup, backupBytes, "utf8");

    const result = restoreBackup(file, backup, schema, Date.parse("2026-02-03T04:05:06.789Z"));

    expect(readFileSync(file, "utf8")).toBe(backupBytes);
    expect(readFileSync(backup, "utf8")).toBe(backupBytes);
    expect(result.brokenPath).toBe(`${file}.broken-2026-02-03T04-05-06-789Z`);
    expect(readFileSync(result.brokenPath!, "utf8")).toBe("broken{");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never overwrites an earlier .broken copy", () => {
    const { file } = setup();
    const now = Date.parse("2026-02-03T04:05:06.789Z");
    writeFileSync(migrationBackupPath(file, 0), '{"items":[]}', "utf8");
    writeFileSync(file, "first{", "utf8");
    const first = restoreBackup(file, migrationBackupPath(file, 0), schema, now);
    writeFileSync(file, "second{", "utf8");
    const second = restoreBackup(file, migrationBackupPath(file, 0), schema, now);

    expect(second.brokenPath).not.toBe(first.brokenPath);
    expect(readFileSync(first.brokenPath!, "utf8")).toBe("first{");
    expect(readFileSync(second.brokenPath!, "utf8")).toBe("second{");
  });

  it("restores when the current file is missing", () => {
    const { file } = setup();
    writeFileSync(migrationBackupPath(file, 0), '{"items":[1]}', "utf8");
    expect(restoreBackup(file, migrationBackupPath(file, 0), schema).brokenPath).toBeNull();
    expect(readFileSync(file, "utf8")).toBe('{"items":[1]}');
  });

  it("rejects paths that are not backups of this file", () => {
    const { dir, file } = setup();
    writeFileSync(file, "broken{", "utf8");
    const elsewhere = mkdtempSync(join(tmpdir(), "cw-recovery-foreign-"));
    const candidates = [
      join(elsewhere, "cw-settings.json.last-good.bak"),
      join(dir, "other.json.last-good.bak"),
      join(dir, "cw-settings.json.broken-2026-01-01T00-00-00-000Z"),
      join(dir, "cw-settings.json.vx.bak"),
      join(dir, "nested", "cw-settings.json.last-good.bak")
    ];
    mkdirSync(join(dir, "nested"));
    for (const candidate of candidates) {
      writeFileSync(candidate, '{"items":[]}', "utf8");
      expect(() => restoreBackup(file, candidate, schema)).toThrow(/is not a backup of cw-settings\.json/);
    }
    expect(() => restoreBackup(file, file, schema)).toThrow(/is not a backup of cw-settings\.json/);
    expect(readFileSync(file, "utf8")).toBe("broken{");
    expect(readdirSync(dir).filter((name) => name.startsWith("cw-settings.json.broken-"))).toEqual([
      "cw-settings.json.broken-2026-01-01T00-00-00-000Z"
    ]);
  });

  it.each([
    ["an invalid", "corrupt{"],
    ["a newer-schema", '{"schemaVersion":2,"items":[]}'],
    ["a wrong-shape", '{"schemaVersion":1,"items":{}}']
  ])("rejects %s backup and leaves the current file in place", (_label, content) => {
    const { dir, file } = setup();
    writeFileSync(file, "broken{", "utf8");
    writeFileSync(lastGoodBackupPath(file), content, "utf8");

    expect(() => restoreBackup(file, lastGoodBackupPath(file), schema)).toThrow(/cannot be restored/);
    expect(readFileSync(file, "utf8")).toBe("broken{");
    expect(readdirSync(dir).some((name) => name.includes(".broken-"))).toBe(false);
  });

  it("rejects a missing backup", () => {
    const { file } = setup();
    writeFileSync(file, "broken{", "utf8");
    expect(() => restoreBackup(file, lastGoodBackupPath(file), schema)).toThrow(/cannot be restored/);
    expect(existsSync(file)).toBe(true);
  });
});
