import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { lastGoodBackupPath, migrationBackupPath } from "./backups.js";
import { isMetadataDocument, MetadataError, type MetadataMigration } from "./metadataDocument.js";
import { LAST_GOOD_REFRESH_INTERVAL_MS, LastGoodRefresher, loadVersionedJson, type VersionedJsonOptions } from "./versionedJson.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "cw-versioned-")), "data.json");
}

function options(filePath: string, migrations: Record<number, MetadataMigration> = { 0: (raw) => ({ ...raw, migrated: true }) }): VersionedJsonOptions {
  return {
    filePath,
    kind: "sessions",
    currentVersion: 1,
    migrations,
    validate: (raw) => (isMetadataDocument(raw) && Array.isArray(raw.items) ? null : "items must be an array"),
    empty: () => ({ schemaVersion: 1, items: [] }),
    now: () => Date.parse("2026-02-03T04:05:06.789Z")
  };
}

function ageFile(path: string): number {
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(path, past, past);
  return statSync(path).mtimeMs;
}

function expectMetadataError(run: () => unknown, kind: MetadataError["kind"]): MetadataError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataError);
    expect((error as MetadataError).kind).toBe(kind);
    return error as MetadataError;
  }
  throw new Error("expected a MetadataError");
}

describe("loadVersionedJson", () => {
  it("reports a missing file without creating anything", () => {
    const file = tempFile();
    expect(loadVersionedJson(options(file))).toEqual({ status: "missing" });
    expect(readdirSync(join(file, ".."))).toEqual([]);
  });

  it("treats an unversioned file as schema 0, backs up the original bytes and writes the migrated file", () => {
    const file = tempFile();
    const original = '{ "items": [1, 2], "extra": "kept" }\n';
    writeFileSync(file, original, "utf8");

    const result = loadVersionedJson(options(file));

    expect(result).toEqual({
      status: "ok",
      data: { schemaVersion: 1, items: [1, 2], extra: "kept", migrated: true },
      fromVersion: 0,
      migrated: true
    });
    expect(readFileSync(migrationBackupPath(file, 0), "utf8")).toBe(original);
    expect(readFileSync(file, "utf8")).toBe('{"schemaVersion":1,"items":[1,2],"extra":"kept","migrated":true}');
    expect(readFileSync(lastGoodBackupPath(file), "utf8")).toBe(readFileSync(file, "utf8"));
  });

  it("does not rewrite a current-schema file on repeated loads", () => {
    const file = tempFile();
    writeFileSync(file, '{"items":[]}', "utf8");
    loadVersionedJson(options(file));
    const bytes = readFileSync(file);
    const mtime = ageFile(file);
    const backupMtime = ageFile(migrationBackupPath(file, 0));

    const second = loadVersionedJson(options(file));

    expect(second).toMatchObject({ status: "ok", fromVersion: 1, migrated: false });
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(statSync(migrationBackupPath(file, 0)).mtimeMs).toBe(backupMtime);
  });

  it("reruns safely after an interrupted migration, reusing the backup of the same bytes", () => {
    const file = tempFile();
    writeFileSync(file, '{"items":[3]}', "utf8");
    writeFileSync(migrationBackupPath(file, 0), '{"items":[3]}', "utf8");
    const staleTemp = `${file}.4242.deadbeef.tmp`;
    writeFileSync(staleTemp, '{"items":[', "utf8");

    const result = loadVersionedJson(options(file));

    expect(result).toMatchObject({ status: "ok", fromVersion: 0, migrated: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ schemaVersion: 1, items: [3], migrated: true });
    expect(readFileSync(staleTemp, "utf8")).toBe('{"items":[');
    expect(readdirSync(join(file, "..")).filter((name) => /\.v0\..+\.bak$/.test(name))).toEqual([]);
  });

  it("keeps an older schema-0 backup and adds a timestamped one when the source bytes differ", () => {
    const file = tempFile();
    writeFileSync(file, '{"items":[3]}', "utf8");
    writeFileSync(migrationBackupPath(file, 0), '{"items":["older original"]}', "utf8");

    loadVersionedJson(options(file));

    expect(readFileSync(migrationBackupPath(file, 0), "utf8")).toBe('{"items":["older original"]}');
    expect(readFileSync(`${file}.v0.2026-02-03T04-05-06-789Z.bak`, "utf8")).toBe('{"items":[3]}');

    writeFileSync(file, '{"items":[3]}', "utf8");
    loadVersionedJson(options(file));
    expect(readdirSync(join(file, "..")).filter((name) => name.startsWith("data.json.v0.")).sort()).toEqual([
      "data.json.v0.2026-02-03T04-05-06-789Z.bak",
      "data.json.v0.bak"
    ]);
  });

  it("refuses to start empty when the file is missing but a restorable backup exists", () => {
    const file = tempFile();
    writeFileSync(lastGoodBackupPath(file), '{"schemaVersion":1,"items":[1]}', "utf8");

    const error = expectMetadataError(() => loadVersionedJson(options(file)), "missing");

    expect(error.detail).toContain("1 restorable backup");
    expect(existsSync(file)).toBe(false);
  });

  it.each([
    ["a corrupt last-good backup", "data.json.last-good.bak", "corrupt{"],
    ["an unrestorable migration backup", "data.json.v0.bak", "corrupt{"],
    ["an unrestorable timestamped migration backup", "data.json.v0.2026-01-01T00-00-00-000Z.bak", "corrupt{"],
    ["an unrestorable archived last-good backup", "data.json.last-good.2026-01-01T00-00-00-000Z.bak", '{"schemaVersion":9,"items":[]}'],
    ["a before-repair copy", "data.json.before-repair.bak", '{"items":[]}'],
    ["a broken copy", "data.json.broken-2026-01-01T00-00-00-000Z", "corrupt{"]
  ])("refuses to start empty when the file is missing and only %s remains", (_label, name, content) => {
    const file = tempFile();
    writeFileSync(join(file, "..", name), content, "utf8");

    const error = expectMetadataError(() => loadVersionedJson(options(file)), "missing");

    expect(error.detail).toContain("none of its backups can be restored");
    expect(error.detail).toContain(name);
    expect(readdirSync(join(file, ".."))).toEqual([name]);
  });

  it("refuses to start empty when the file is missing and its last-good backup is a directory", () => {
    const file = tempFile();
    mkdirSync(lastGoodBackupPath(file));

    const error = expectMetadataError(() => loadVersionedJson(options(file)), "missing");

    expect(error.detail).toContain("none of its backups can be restored");
    expect(error.detail).toContain("data.json.last-good.bak");
  });

  it("treats a missing file as a first run when only temp files and other files' backups remain", () => {
    const file = tempFile();
    writeFileSync(`${file}.4242.deadbeef.tmp`, "{", "utf8");
    writeFileSync(join(file, "..", "other.json.last-good.bak"), '{"schemaVersion":1,"items":[]}', "utf8");
    expect(loadVersionedJson(options(file))).toEqual({ status: "missing" });
  });

  it("refuses a newer schema without writing anything", () => {
    const file = tempFile();
    const original = '{"schemaVersion":7,"items":[]}';
    writeFileSync(file, original, "utf8");

    const error = expectMetadataError(() => loadVersionedJson(options(file)), "future-schema");

    expect(error.foundVersion).toBe(7);
    expect(error.supportedVersion).toBe(1);
    expect(error.store).toBe("sessions");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(join(file, ".."))).toEqual(["data.json"]);
  });

  it("refuses corrupt JSON and leaves the file untouched", () => {
    const file = tempFile();
    writeFileSync(file, "not-json{{{", "utf8");

    const error = expectMetadataError(() => loadVersionedJson(options(file)), "corrupt");

    expect(error.file).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("not-json{{{");
    expect(readdirSync(join(file, ".."))).toEqual(["data.json"]);
  });

  it.each([
    ["a top-level array", "[]"],
    ["a failed shape validation", '{"items":"nope"}'],
    ["a non-integer schema version", '{"schemaVersion":"1","items":[]}'],
    ["a negative schema version", '{"schemaVersion":-1,"items":[]}']
  ])("refuses %s as an invalid shape", (_label, content) => {
    const file = tempFile();
    writeFileSync(file, content, "utf8");
    expectMetadataError(() => loadVersionedJson(options(file)), "invalid-shape");
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(existsSync(migrationBackupPath(file, 0))).toBe(false);
  });

  it("refuses a migration that throws or produces invalid data without touching the source", () => {
    const file = tempFile();
    writeFileSync(file, '{"items":[]}', "utf8");
    expectMetadataError(
      () => loadVersionedJson(options(file, { 0: () => { throw new Error("boom"); } })),
      "invalid-shape"
    );
    expectMetadataError(() => loadVersionedJson(options(file, { 0: () => ({ items: "broken" }) })), "invalid-shape");
    expect(readFileSync(file, "utf8")).toBe('{"items":[]}');
    expect(existsSync(migrationBackupPath(file, 0))).toBe(false);
  });

  it("aborts the migration when the backup cannot be created", () => {
    const file = tempFile();
    writeFileSync(file, '{"items":[]}', "utf8");
    mkdirSync(migrationBackupPath(file, 0));

    const error = expectMetadataError(() => loadVersionedJson(options(file)), "io");

    expect(error.foundVersion).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"items":[]}');
    expect(existsSync(lastGoodBackupPath(file))).toBe(false);
  });

  it.runIf(process.platform === "win32")("keeps the original file when the migrated write cannot replace it", () => {
    const file = tempFile();
    writeFileSync(file, '{"items":[]}', "utf8");
    chmodSync(file, 0o444);
    try {
      expectMetadataError(() => loadVersionedJson(options(file)), "io");
      expect(readFileSync(file, "utf8")).toBe('{"items":[]}');
      expect(readFileSync(migrationBackupPath(file, 0), "utf8")).toBe('{"items":[]}');
      expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("refreshes the last-good backup only when the file changed", () => {
    const file = tempFile();
    writeFileSync(file, '{"schemaVersion":1,"items":[1]}', "utf8");
    loadVersionedJson(options(file));
    expect(readFileSync(lastGoodBackupPath(file), "utf8")).toBe('{"schemaVersion":1,"items":[1]}');
    const unchangedMtime = ageFile(lastGoodBackupPath(file));

    loadVersionedJson(options(file));
    expect(statSync(lastGoodBackupPath(file)).mtimeMs).toBe(unchangedMtime);

    writeFileSync(file, '{"schemaVersion":1,"items":[2]}', "utf8");
    loadVersionedJson(options(file));
    expect(readFileSync(lastGoodBackupPath(file), "utf8")).toBe('{"schemaVersion":1,"items":[2]}');
  });

  it("warns instead of failing when the last-good backup cannot be refreshed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = tempFile();
    writeFileSync(file, '{"schemaVersion":1,"items":[]}', "utf8");
    mkdirSync(lastGoodBackupPath(file));

    expect(loadVersionedJson(options(file))).toMatchObject({ status: "ok" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("accepts a UTF-8 byte order mark", () => {
    const file = tempFile();
    writeFileSync(file, '﻿{"schemaVersion":1,"items":[]}', "utf8");
    expect(loadVersionedJson(options(file))).toMatchObject({ status: "ok", data: { items: [] } });
  });
});

describe("LastGoodRefresher", () => {
  function setup(): { file: string; clock: { now: number }; refresher: LastGoodRefresher } {
    const file = tempFile();
    writeFileSync(file, '{"schemaVersion":1,"items":[0]}', "utf8");
    loadVersionedJson(options(file));
    const clock = { now: 1_000_000 };
    return { file, clock, refresher: new LastGoodRefresher(file, () => clock.now) };
  }

  function lastGood(file: string): string {
    return readFileSync(lastGoodBackupPath(file), "utf8");
  }

  it("refreshes at most once per interval after the startup refresh and flushes the pending write", () => {
    const { file, clock, refresher } = setup();

    writeFileSync(file, '{"schemaVersion":1,"items":[1]}', "utf8");
    clock.now += LAST_GOOD_REFRESH_INTERVAL_MS - 1;
    refresher.afterPersist();
    expect(lastGood(file)).toBe('{"schemaVersion":1,"items":[0]}');

    clock.now += 1;
    refresher.afterPersist();
    expect(lastGood(file)).toBe('{"schemaVersion":1,"items":[1]}');

    writeFileSync(file, '{"schemaVersion":1,"items":[2]}', "utf8");
    clock.now += 10;
    refresher.afterPersist();
    expect(lastGood(file)).toBe('{"schemaVersion":1,"items":[1]}');

    refresher.flush();
    expect(lastGood(file)).toBe('{"schemaVersion":1,"items":[2]}');
  });

  it("does nothing on flush when no persist is pending", () => {
    const { file, refresher } = setup();
    const mtime = ageFile(lastGoodBackupPath(file));
    writeFileSync(file, '{"schemaVersion":1,"items":[9]}', "utf8");

    refresher.flush();

    expect(statSync(lastGoodBackupPath(file)).mtimeMs).toBe(mtime);
  });

  it("warns instead of throwing when a runtime refresh fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { file, clock, refresher } = setup();
    rmSync(lastGoodBackupPath(file));
    mkdirSync(lastGoodBackupPath(file));
    clock.now += LAST_GOOD_REFRESH_INTERVAL_MS;

    expect(() => refresher.afterPersist()).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
