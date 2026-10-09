import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HiveError, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor } from "#web/app.ts";
import { backupDatabase, backupFile, backupName, backupSettings, listBackups, setPinned } from "#web/backup.ts";
import { HubInfoSource } from "#web/hubinfo.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };
const tmp = () => testTmpDir(path.join(os.tmpdir(), "hive-backup-"));

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
    assert.deepEqual(readdirSync(dir).filter((f) => !f.endsWith(".json")).sort(), ["hub-2026-09-27T11-00-00-000Z.db", "hub-2026-09-27T12-00-00-000Z.db", "notes.txt"]);
    assert.ok(!existsSync(path.join(dir, "hub-2026-09-27T10-00-00-000Z.db.json")), "a removed snapshot's note goes with it");
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
    assert.deepEqual(backupSettings({ HIVE_BACKUP_DIR: "/data/backups" }), { dir: path.resolve("/data/backups"), hours: 24, keep: 7, pinDays: 180, pinMaxBytes: 20_480 * 1_048_576 });
    assert.deepEqual(
      (({ pinDays, pinMaxBytes }) => [pinDays, pinMaxBytes])(backupSettings({ HIVE_BACKUP_DIR: "/b", HIVE_BACKUP_PIN_DAYS: "0", HIVE_BACKUP_PIN_MAX_MB: "1" })!),
      [0, 1_048_576],
    );
    assert.throws(() => backupSettings({ HIVE_BACKUP_DIR: "/b", HIVE_BACKUP_PIN_DAYS: "-1" }), /HIVE_BACKUP_PIN_DAYS/);
    assert.throws(() => backupSettings({ HIVE_BACKUP_DIR: "/b", HIVE_BACKUP_KEEP: "0" }), /HIVE_BACKUP_KEEP/);
    assert.throws(() => backupSettings({ HIVE_BACKUP_DIR: "/b", HIVE_BACKUP_HOURS: "abc" }), /HIVE_BACKUP_HOURS/);
  });
});

describe("pinned backups (ADM-backup-restore)", () => {
  const policy = { pinDays: 180, pinMaxBytes: 0 };

  it("keeps a deletion's snapshot through 8 restarts, and restores the project out of it", async () => {
    const root = tmp();
    const dir = path.join(root, "backups");
    let t = Date.parse("2026-10-05T15:00:00.000Z");
    const now = () => new Date((t += 3_600_000));
    let hub: HubInfoSource | null = null;
    const hive = new SqliteHive(path.join(root, "hub.db"), { now, backup: async ({ project }) => hub!.backup(`delete:${project}`) });
    hub = new HubInfoSource({ hive, dbPath: path.join(root, "hub.db"), backup: { dir, hours: 24, keep: 7, ...policy }, now });
    for (const n of [1, 2, 3]) {
      await hive.call("tasks.create", { id: `EH-${n}`, project: "customer", title: `task ${n}` }, admin);
      await hive.call("memory.write", { project: "customer", kind: "gotcha", content: `gotcha ${n}` }, admin);
    }
    await hive.call("docs.save", { key: "project/customer/arch", content: "# customer" }, admin);
    const counts = async () => {
      const p = (await hive.call("projects.list", {}, admin)).find((x) => x.project === "customer")!;
      return { tasks: p.tasks, docs: p.docs, memory: p.memory, state: p.state };
    };
    const before = await counts();
    await hive.call("projects.archive", { project: "customer" }, admin);
    const deleted = await hive.call("projects.delete", { project: "customer", confirm: "customer" }, admin);
    assert.equal((await counts()).tasks, 0);

    // The incident of 2026-10-09: seven restarts were enough to rotate the deletion's snapshot away.
    for (let i = 0; i < 8; i++) backupDatabase(hive.db, { dir, keep: 7, now, reason: "start", ...policy });
    const list = hub.backups();
    const kept = list.backups.find((b) => b.name === deleted.backup);
    assert.ok(kept, "the deletion's snapshot survives the rotation");
    assert.deepEqual([kept.reason, kept.pinned, kept.expiresAt !== null], ["delete:customer", true, true]);
    assert.equal(list.backups.filter((b) => !b.pinned).length, 7, "the rotation still keeps its 7");
    assert.ok(list.pinnedBytes > 0);

    const inBackup = hub.projects(deleted.backup).find((p) => p.project === "customer")!;
    assert.deepEqual([inBackup.tasks, inBackup.docs, inBackup.memory, inBackup.live], [3, 1, 3, false]);
    const restored = await hub.restoreProject(deleted.backup, "customer", admin);
    assert.equal(restored.rows.tasks, 3);
    assert.deepEqual(await counts(), { ...before, state: null });
    await assert.rejects(hub.restoreProject(deleted.backup, "customer", admin), (e: unknown) => e instanceof HiveError && e.key === "errors.restoreHasData");
    assert.throws(() => hub!.file("../hub.db"), (e: unknown) => e instanceof HiveError && e.code === "not_found");
    hive.close();
  });

  it("lets a pin run out after its days, refuses a pin by hand past the cap, and rotates an unpinned one", () => {
    const root = tmp();
    const hive = new SqliteHive(path.join(root, "hub.db"));
    const dir = path.join(root, "backups");
    let t = Date.parse("2026-10-01T00:00:00.000Z");
    const now = () => new Date((t += 3_600_000));
    const pinned = backupDatabase(hive.db, { dir, keep: 1, now, reason: "manual", pin: true, pinDays: 2, by: "duy" });
    const name = path.basename(pinned.file);
    backupDatabase(hive.db, { dir, keep: 1, now, reason: "start", pinDays: 2 });
    backupDatabase(hive.db, { dir, keep: 1, now, reason: "start", pinDays: 2 });
    assert.ok(existsSync(pinned.file), "inside its 2 days the pin holds");
    const entry = listBackups(dir, 1, { pinDays: 2, pinMaxBytes: 0 }, new Date(t)).backups.find((b) => b.name === name)!;
    assert.deepEqual([entry.pinned, entry.pinnedBy, entry.expiresAt], [true, "duy", "2026-10-03T01:00:00.000Z"]);

    t += 3 * 86_400_000;
    const later = backupDatabase(hive.db, { dir, keep: 1, now, reason: "start", pinDays: 2 });
    assert.ok(!existsSync(pinned.file), "a pin that ran out is back in the rotation");
    assert.equal(listBackups(dir, 1, { pinDays: 2, pinMaxBytes: 0 }).backups.length, 1);

    const last = path.basename(later.file);
    assert.throws(() => setPinned(dir, last, true, { by: "duy", policy: { pinDays: 0, pinMaxBytes: 1 } }), (e: unknown) => e instanceof HiveError && e.key === "errors.backupPinFull");
    const forever = setPinned(dir, last, true, { by: "duy", policy: { pinDays: 0, pinMaxBytes: 0 } });
    assert.deepEqual([forever.pinned, forever.expiresAt], [true, null]);
    const unpinned = setPinned(dir, last, false, { by: "duy", policy: { pinDays: 0, pinMaxBytes: 0 } });
    assert.equal(unpinned.pinned, false);
    backupDatabase(hive.db, { dir, keep: 1, now, reason: "start" });
    assert.ok(!existsSync(later.file), "unpinned, it rotates like any other");
    hive.close();
  });
});

describe("allowed hosts", () => {
  it("always accepts loopback next to the configured names", () => {
    assert.deepEqual(allowedHostsFor("hive.example.com, hive.lan", "0.0.0.0"), ["hive.example.com", "hive.lan", "localhost", "127.0.0.1", "[::1]"]);
    assert.deepEqual(allowedHostsFor(undefined, "127.0.0.1"), ["localhost", "127.0.0.1", "[::1]"]);
    assert.equal(allowedHostsFor("", "0.0.0.0"), undefined, "nothing configured on a public bind: no check (the server warns)");
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
