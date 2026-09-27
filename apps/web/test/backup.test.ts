import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor } from "../src/app.ts";
import { backupDatabase, backupFile, backupName, backupSettings } from "../src/backup.ts";

const admin: Actor = { name: "duy", role: "admin" };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "hive-backup-"));

describe("hub backups", () => {
  it("snapshots a live database, keeps the newest and restores from a snapshot", async () => {
    const root = tmp();
    const hive = new SqliteHive(path.join(root, "hub.db"));
    await hive.call("docs.save", { key: "org/style", content: "Tabs, not spaces" }, admin);
    const dir = path.join(root, "backups");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "notes.txt"), "not a snapshot");
    let t = Date.parse("2026-09-27T09:00:00.000Z");
    const now = () => new Date((t += 3_600_000));

    const results = [1, 2, 3].map(() => backupDatabase(hive.db, { dir, keep: 2, now }));
    assert.deepEqual(readdirSync(dir).sort(), ["hub-2026-09-27T11-00-00-000Z.db", "hub-2026-09-27T12-00-00-000Z.db", "notes.txt"]);
    assert.deepEqual(results[2]!.removed, [path.join(dir, "hub-2026-09-27T10-00-00-000Z.db")]);

    await hive.call("docs.save", { key: "org/style", content: "Spaces after all" }, admin);
    hive.close();
    const restored = new SqliteHive(results[2]!.file);
    assert.equal((await restored.call("docs.get", { key: "org/style" }, admin))?.content, "Tabs, not spaces");
    restored.close();
  });

  it("skips a database that does not exist yet", () => {
    assert.equal(backupFile(path.join(tmp(), "missing.db"), { dir: tmp(), keep: 3 }), null);
  });

  it("names snapshots by time and validates settings", () => {
    assert.equal(backupName(new Date("2026-09-27T09:05:07.123Z")), "hub-2026-09-27T09-05-07-123Z.db");
    assert.equal(backupSettings({}), null);
    assert.deepEqual(backupSettings({ HIVE_BACKUP_DIR: "/data/backups" }), { dir: "/data/backups", hours: 24, keep: 7 });
    assert.throws(() => backupSettings({ HIVE_BACKUP_DIR: "/b", HIVE_BACKUP_KEEP: "0" }), /HIVE_BACKUP_KEEP/);
    assert.throws(() => backupSettings({ HIVE_BACKUP_DIR: "/b", HIVE_BACKUP_HOURS: "abc" }), /HIVE_BACKUP_HOURS/);
  });
});

describe("allowed hosts", () => {
  it("always accepts loopback next to the configured names", () => {
    assert.deepEqual(allowedHostsFor("hive.example.com, hive.lan", "0.0.0.0"), ["hive.example.com", "hive.lan", "localhost", "127.0.0.1", "[::1]"]);
    assert.deepEqual(allowedHostsFor(undefined, "127.0.0.1"), ["localhost", "127.0.0.1", "[::1]"]);
    assert.equal(allowedHostsFor("", "0.0.0.0"), undefined, "nothing configured on a public bind: no check (the server warns)");
  });
});
