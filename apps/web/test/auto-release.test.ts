import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { ReleaseStore } from "#web/releases.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";
import { adminSession, authHeaders } from "./session.ts";

it("allows the pinned Gate machine to roll out only the hub operator's app service", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-auto-rollout-")); const h = new SqliteHive(":memory:");
  const tokens = new TokenStore(h.db); const { token, info } = tokens.create("gate", "agent"); const users = new UserStore(h.db); const adminToken = adminSession(users, "admin");
  const store = new ReleaseStore(h.db, dir);
  const app = createHubApp({ hive: h, tokens, users, releases: store, autoReleaseProject: "app", allowedHosts: ["127.0.0.1"] });
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = async (method: string, input: unknown) => {
    const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(token), "x-hive-agent": "runner.gate" }, body: JSON.stringify({ method, input }) });
    return { status: response.status, body: await response.json() };
  };
  const admin = { name: "admin", role: "admin" as const }; const gate = { name: "runner.gate@gate", role: "agent" as const, tokenId: info.id };
  try {
    // Machine-only methods need the token the machine is paired with, which its first heartbeat records.
    assert.equal((await rpc("machines.heartbeat", { machine: "gate", instance: "aaaaaaaa", projects: ["app", "another"] })).status, 200);
    for (const project of ["app", "another"]) {
      await h.call("tasks.create", { id: `T-${project}`, project, title: "Green" }, admin);
      await h.call("tasks.update", { id: `T-${project}`, status: "done" }, admin);
      await h.call("sdlc.setProject", { project, settings: { gates: { release: "auto" }, releaseMachine: gate.name } }, admin);
      await h.call("autoRelease.green", { project, batchId: "green", sha: "a".repeat(40), version: "1.2.3", taskIds: [`T-${project}`], landed: true, checks: [{ name: "all", passed: true }] }, gate);
    }
    assert.equal((await rpc("autoRelease.rollout", { project: "app", batchId: "green" })).status, 403, "a queued release cannot roll out");
    await h.call("autoRelease.take", { project: "app" }, gate);
    await h.call("autoRelease.take", { project: "another" }, gate);
    assert.equal((await rpc("autoRelease.rollout", { project: "app", batchId: "green" })).status, 403, "release must reach the rollout stage first");
    for (const project of ["app", "another"]) for (const step of ["prepare", "release", "rollout"] as const) await h.call("autoRelease.progress", { project, batchId: "green", step }, gate);
    const query = new URLSearchParams({ version: "1.2.3", channel: "stable", platform: "mac", arch: "arm64", kind: "zip", name: "fixture.zip" });
    const uploaded = await fetch(`${base}/api/releases/upload?${query}`, { method: "POST", headers: { ...authHeaders(adminToken), "content-type": "application/octet-stream" }, body: new TextEncoder().encode("fixture bytes") });
    assert.equal(uploaded.status, 200);
    assert.equal((await rpc("autoRelease.rollout", { project: "another", batchId: "green" })).status, 403, "service managers cannot change another service's global app rollout");
    assert.equal((await rpc("autoRelease.rollout", { project: "app", batchId: "green" })).status, 200);
    assert.equal(store.rollout().percent, 100); assert.equal(store.rollout().target, "1.2.3"); assert.equal(store.rollout().installWhen, "idle"); assert.equal(store.rollout().autoDownload, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); h.close(); rmSync(dir, { recursive: true, force: true }); }
});
