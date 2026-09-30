import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { HubInfoSource } from "#web/hubinfo.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

async function serve(backup: { dir: string; hours: number; keep: number } | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-hubinfo-"));
  const dbPath = path.join(dir, "hub.db");
  const hive = new SqliteHive(dbPath);
  hive.seed("hub", { hub: true });
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const admin = tokens.create("duy", "admin").token;
  const agent = tokens.create("duy-mbp", "agent").token;
  const hub = new HubInfoSource({ hive, dbPath, users, backup, allowedHosts: ["hive.example.com"], publicUrl: "https://hive.example.com", trustProxy: true, commit: "fc7d41a" });
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1"], hub });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = async (token: string, method: string) => {
    const res = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ method }) });
    return { status: res.status, body: (await res.json()) as { result?: any; error?: { key?: string } } };
  };
  return { rpc, admin, agent, dbPath, close: () => server.close() };
}

describe("the Hub page", () => {
  it("tells hub admins what the hub is, and makes a backup on request", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-backups-"));
    const s = await serve({ dir, hours: 24, keep: 2 });
    try {
      const info = (await s.rpc(s.admin, "hub.info")).body.result;
      assert.match(info.version, /^\d+\.\d+\.\d+$/, "the app's version the hub was built from");
      assert.equal(info.commit, "fc7d41a");
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
      assert.equal(readdirSync(dir).length, 2, "keeps as many as it is told");
      const after = (await s.rpc(s.admin, "hub.info")).body.result;
      assert.equal(after.backup.count, 2);
      assert.ok(after.backup.last);
      assert.equal((await s.rpc(s.agent, "hub.info")).status, 403);
      assert.equal((await s.rpc(s.agent, "hub.backup")).status, 403);
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
