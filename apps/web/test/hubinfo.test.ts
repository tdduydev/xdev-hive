import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { DeployLog } from "#web/deploy-log.ts";
import { HubInfoSource } from "#web/hubinfo.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";
import { adminSession, authHeaders } from "./session.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

async function serve(backup: { dir: string; hours: number; keep: number } | null) {
  const dir = testTmpDir(path.join(os.tmpdir(), "hive-hubinfo-"));
  const dbPath = path.join(dir, "hub.db");
  const hive = new SqliteHive(dbPath);
  hive.seed("hub", { hub: true });
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const admin = adminSession(users, "duy");
  const agent = tokens.create("duy-mbp", "agent").token;
  const deployLog = new DeployLog();
  deployLog.backup = backup ? "skipped" : "off";
  deployLog.record("error", `[xdev-hive] failed hive_${"a".repeat(32)}`);
  const hub = new HubInfoSource({ deployLog, hive, dbPath, users, backup, allowedHosts: ["hive.example.com"], publicUrl: "https://hive.example.com", trustProxy: true, commit: "fc7d41a" });
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1"], hub });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = async (token: string, method: string, input?: unknown) => {
    const res = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ method, input }) });
    return { status: res.status, body: (await res.json()) as { result?: any; error?: { key?: string } } };
  };
  const get = (token: string, url: string) => fetch(`${base}${url}`, { headers: { ...authHeaders(token) } });
  // The hive too: Windows will not remove a folder whose database is still open.
  return { rpc, get, hive, admin, agent, dbPath, close: () => (server.close(), hive.close()) };
}

describe("the Hub page", () => {
  it("tells hub admins what the hub is, and makes a backup on request", async () => {
    const dir = testTmpDir(path.join(os.tmpdir(), "hive-backups-"));
    const s = await serve({ dir, hours: 24, keep: 2 });
    try {
      const info = (await s.rpc(s.admin, "hub.info")).body.result;
      assert.match(info.version, /^\d+\.\d+\.\d+$/, "the app's version the hub was built from");
      assert.equal(info.commit, "fc7d41a");
      assert.equal(info.deployLog.backup, "skipped");
      assert.equal(info.deployLog.errors, 1);
      assert.match(info.deployLog.groups[0].message, /line hidden/);
      assert.ok(!JSON.stringify(info.deployLog).includes(`hive_${"a".repeat(32)}`));
      assert.equal(info.db.path, s.dbPath);
      assert.ok(info.db.bytes > 0);
      assert.ok(info.db.counts.docs > 0, "the seeded docs");
      assert.deepEqual([info.backup.last, info.backup.count, info.backup.keep], [null, 0, 2]);
      assert.deepEqual(info.hosts, { allowed: ["hive.example.com"], publicUrl: "https://hive.example.com", trustProxy: true });
      assert.equal(info.search.mode, "keyword");
      const made = (await s.rpc(s.admin, "hub.backup")).body.result;
      assert.match(made.file, /^hub-.*\.db$/);
      assert.ok(existsSync(path.join(dir, made.file)));
      await s.rpc(s.admin, "hub.backup");
      await s.rpc(s.admin, "hub.backup");
      // Asked for by hand, so pinned: the rotation of 2 leaves all three (ADM-backup-restore).
      assert.equal(readdirSync(dir).filter((f) => f.endsWith(".db")).length, 3);
      const after = (await s.rpc(s.admin, "hub.info")).body.result;
      assert.equal(after.backup.count, 3);
      assert.equal(after.backup.pinned, 3);
      assert.ok(after.backup.last);
      assert.equal((await s.rpc(s.agent, "hub.info")).status, 403);
      assert.equal((await s.rpc(s.agent, "hub.backup")).status, 403);
      assert.deepEqual(after.storage, { releases: null, artifacts: { count: 0, bytes: 0, days: 30 }, runLogDays: 30 });
      const cleaned = (await s.rpc(s.admin, "hub.cleanup")).body.result;
      assert.deepEqual([cleaned.releases, cleaned.artifacts], [null, { removed: 0, bytes: 0 }]);
      assert.ok(cleaned.db.after > 0 && cleaned.db.after <= cleaned.db.before, `VACUUM leaves a working database: ${JSON.stringify(cleaned.db)}`);
      assert.equal((await s.rpc(s.agent, "hub.cleanup")).status, 403);
    } finally {
      s.close();
    }
  });

  it("lists, pins, downloads and restores out of snapshots, for hub admins only", async () => {
    const dir = testTmpDir(path.join(os.tmpdir(), "hive-backups-"));
    const s = await serve({ dir, hours: 24, keep: 2 });
    try {
      const admin = { name: "duy", role: "admin" } as const;
      await s.hive.call("tasks.create", { id: "OLD-1", project: "old", title: "x" }, admin);
      const made = (await s.rpc(s.admin, "hub.backup")).body.result;
      const list = (await s.rpc(s.admin, "backups.list")).body.result;
      assert.deepEqual(list.backups.map((b: any) => [b.name, b.reason, b.pinned, b.pinnedBy]), [[made.file, "manual", true, "duy"]]);
      assert.deepEqual([list.keep, list.pinDays], [2, 180]);
      assert.equal((await s.rpc(s.admin, "backups.unpin", { name: made.file })).body.result.pinned, false);
      assert.equal((await s.rpc(s.admin, "backups.pin", { name: made.file })).body.result.pinned, true);
      assert.equal((await s.rpc(s.admin, "backups.pin", { name: "../hub.db" })).body.error?.key, "errors.backupNotFound");

      const file = await s.get(s.admin, `/api/backups/${made.file}`);
      assert.equal(file.status, 200);
      assert.match(file.headers.get("content-disposition") ?? "", /attachment/);
      assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
      assert.equal((await s.get(s.admin, "/api/backups/hub.db")).status, 404);
      assert.equal((await s.get(s.agent, `/api/backups/${made.file}`)).status, 403);

      assert.deepEqual((await s.rpc(s.admin, "backups.projects", { name: made.file })).body.result.map((p: any) => [p.project, p.live]), [["old", true]]);
      assert.equal((await s.rpc(s.admin, "backups.restoreProject", { name: made.file, project: "old", confirm: "0ld" })).body.error?.key, "errors.projectConfirm");
      assert.equal((await s.rpc(s.admin, "backups.restoreProject", { name: made.file, project: "old", confirm: "old" })).body.error?.key, "errors.restoreHasData");
      for (const method of ["backups.list", "backups.pin", "backups.unpin", "backups.projects", "backups.restoreProject"]) {
        assert.equal((await s.rpc(s.agent, method, { name: made.file, project: "old", confirm: "old" })).status, 403, method);
      }
    } finally {
      s.close();
    }
  });

  it("says so when backups are off", async () => {
    const s = await serve(null);
    try {
      assert.equal((await s.rpc(s.admin, "hub.info")).body.result.backup, null);
      assert.equal((await s.rpc(s.admin, "hub.backup")).body.error?.key, "errors.backupOff");
    } finally {
      s.close();
    }
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
