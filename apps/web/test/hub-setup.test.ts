import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { applySetupFile, checkSetupValues, readSetupFile, SetupGate, setupDefaults, writeSetupFile } from "#web/hub-setup.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hive-setup-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A hub in setup mode on a free port; `exits` counts the restarts it asked for. */
async function setupHub(env: NodeJS.ProcessEnv = {}) {
  const file = path.join(tmp(), "settings.json");
  const hive = new SqliteHive(":memory:");
  hive.seed("hub", { hub: true });
  const users = new UserStore(hive.db);
  const codes: string[] = [];
  let exits = 0;
  const gate = new SetupGate({ file, env, locked: applySetupFile(env, null), users, announce: (c) => void codes.push(c), onDone: () => void exits++ });
  const server = createHubApp({ hive, tokens: new TokenStore(hive.db), users, setup: gate }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-hive-csrf": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { result?: any; error?: { key?: string } } };
  };
  return { file, users, codes, send, exits: () => exits, close: () => server.close() };
}

describe("hub setup (roadmap 75)", () => {
  it("fills unset variables from the file and leaves the ones the environment set", () => {
    const env: NodeJS.ProcessEnv = { HIVE_ALLOWED_HOSTS: "hive.example.com", HIVE_TRUST_PROXY: "", HIVE_DB: "/data/hub.db" };
    const locked = applySetupFile(env, { done: true, values: { HIVE_ALLOWED_HOSTS: "other.example.com", HIVE_TRUST_PROXY: "1", HIVE_SEAWEEDFS_URL: "" } });
    assert.deepEqual(locked, ["HIVE_ALLOWED_HOSTS"], "an empty variable (compose's unset) is not locked");
    assert.equal(env.HIVE_ALLOWED_HOSTS, "hive.example.com");
    assert.equal(env.HIVE_TRUST_PROXY, "1");
    assert.equal(env.HIVE_SEAWEEDFS_URL, "", "an empty choice (files in the database) is kept as empty");
  });

  it("reads back only the known keys and writes the file private", () => {
    const file = path.join(tmp(), "settings.json");
    writeSetupFile(file, { done: true, values: { HIVE_LAN_HOSTS: "10.0.0.5" } });
    assert.deepEqual(readSetupFile(file), { done: true, values: { HIVE_LAN_HOSTS: "10.0.0.5" } });
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readSetupFile(path.join(tmp(), "none.json")), null);
  });

  it("checks each value and drops the locked ones", () => {
    assert.deepEqual(checkSetupValues({ HIVE_LAN_HOSTS: " 10.0.0.5, My-Server ", HIVE_BACKUP_HOURS: "12", HIVE_ALLOWED_HOSTS: "x.example.com" }, ["HIVE_ALLOWED_HOSTS"]), {
      HIVE_LAN_HOSTS: "10.0.0.5,my-server",
      HIVE_BACKUP_HOURS: "12",
    });
    for (const bad of [{ HIVE_LAN_HOSTS: "a b" }, { HIVE_PUBLIC_URL: "ftp://x" }, { HIVE_BACKUP_KEEP: "0" }, { HIVE_MEMORY_APPROVAL: "yes" }, { HIVE_OIDC_ISSUER: "http://idp" }]) {
      assert.throws(() => checkSetupValues(bad, []), /không hợp lệ/, JSON.stringify(bad));
    }
    assert.throws(() => checkSetupValues({ HIVE_OIDC_ISSUER: "https://idp.example.com" }, []), (e: { key?: string }) => e.key === "errors.setupOidc");
    assert.throws(
      () => checkSetupValues({ HIVE_OIDC_ISSUER: "https://idp.example.com", HIVE_OIDC_CLIENT_ID: "a", HIVE_OIDC_CLIENT_SECRET: "b" }, []),
      (e: { key?: string }) => e.key === "errors.setupOidcUrl",
    );
  });

  it("never offers a secret back as a default", () => {
    const d = setupDefaults({ HIVE_EMBED_KEY: "sk-secret", HIVE_OIDC_CLIENT_SECRET: "s", HIVE_EMBED_URL: "http://ollama:11434/v1" });
    assert.equal(d.HIVE_EMBED_KEY, undefined);
    assert.equal(d.HIVE_OIDC_CLIENT_SECRET, undefined);
    assert.equal(d.HIVE_EMBED_URL, "http://ollama:11434/v1");
  });

  it("closes the API until set up, then creates the admin, writes the settings and asks for a restart", async () => {
    const hub = await setupHub({ HIVE_ALLOWED_HOSTS: "hive.example.com" });
    try {
      assert.equal(hub.codes.length, 1);
      const state = await hub.send("/api/setup");
      assert.deepEqual([state.body.result.pending, state.body.result.locked], [true, ["HIVE_ALLOWED_HOSTS"]]);
      assert.equal((await hub.send("/api/health")).status, 200);
      const closed = await hub.send("/api/me");
      assert.deepEqual([closed.status, closed.body.error?.key], [503, "errors.setupPending"]);

      const admin = { username: "Duy", password: "a-long-passphrase" };
      const wrong = await hub.send("/api/setup", { code: "AAAA-AAAA-AAAA", admin, values: {} });
      assert.deepEqual([wrong.status, wrong.body.error?.key], [403, "errors.setupCode"]);
      const weak = await hub.send("/api/setup", { code: hub.codes[0], admin: { username: "duy", password: "short" }, values: {} });
      assert.equal(weak.status, 400);
      assert.equal(hub.users.count(), 0, "nothing created on a refused setup");

      const ok = await hub.send("/api/setup", { code: hub.codes[0]!.toLowerCase(), admin, values: { HIVE_LAN_HOSTS: "10.0.0.5", HIVE_ALLOWED_HOSTS: "evil.example.com" } });
      assert.deepEqual([ok.status, ok.body.result], [200, { restart: true }]);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(hub.exits(), 1);
      const user = hub.users.verify("duy", admin.password);
      assert.ok(user?.admin);
      assert.equal(user?.mustChangePassword, false, "the person chose this password");
      assert.deepEqual(readSetupFile(hub.file), { done: true, values: { HIVE_LAN_HOSTS: "10.0.0.5" } }, "the locked key is not written");
      assert.equal((await hub.send("/api/me")).status, 401, "open again: an ordinary signed-out answer");
      assert.equal((await hub.send("/api/setup", { code: hub.codes[0], admin, values: {} })).status, 409);
    } finally {
      hub.close();
    }
  });

  it("changes the code after ten wrong ones", async () => {
    const hub = await setupHub();
    try {
      for (let i = 0; i < 10; i++) await hub.send("/api/setup", { code: "nope", admin: { username: "a", password: "x" }, values: {} });
      assert.equal(hub.codes.length, 2);
      assert.notEqual(hub.codes[0], hub.codes[1]);
    } finally {
      hub.close();
    }
  });

  it("answers not pending on a hub not started for setup", async () => {
    const hive = new SqliteHive(":memory:");
    const server = createHubApp({ hive, tokens: new TokenStore(hive.db), users: new UserStore(hive.db) }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/setup`);
      assert.deepEqual(await res.json(), { result: { pending: false } });
    } finally {
      server.close();
    }
  });
});
