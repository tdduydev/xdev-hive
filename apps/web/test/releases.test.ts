import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { compareVersions } from "@xdev-hive/core";
import { createHubApp } from "../src/app.ts";
import { bucket, ReleaseStore } from "../src/releases.ts";
import { TokenStore } from "../src/tokens.ts";
import { UserStore } from "../src/users.ts";

let base = "";
let close: () => void;
let store: ReleaseStore;
const tok = { admin: "", machine: "" };

before(async () => {
  const hive = new SqliteHive(":memory:");
  hive.seed();
  const tokens = new TokenStore(hive.db);
  tok.admin = tokens.create("duy", "admin").token;
  tok.machine = tokens.create("duy-mbp", "agent").token;
  store = new ReleaseStore(hive.db, path.join(mkdtempSync(path.join(os.tmpdir(), "hive-releases-")), "releases"));
  const app = createHubApp({ hive, tokens, users: new UserStore(hive.db), allowedHosts: ["127.0.0.1"], releases: store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

async function rpc(token: string, method: string, input?: unknown, agent = "runner.duy-mbp") {
  const res = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-hive-agent": agent },
    body: JSON.stringify({ method, input }),
  });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: { code: string; key?: string } } };
}

const upload = (token: string, q: Record<string, string>, body: Uint8Array) =>
  fetch(`${base}/api/releases/upload?${new URLSearchParams(q)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body });

const beat = (version: string, update: unknown = null) =>
  rpc(tok.machine, "machines.heartbeat", { machine: "duy-mbp", instance: "abcdef0123", version, runs: [], platform: "mac", arch: "arm64", update });

describe("app releases", () => {
  it("compares versions the way the rollout needs", () => {
    assert.ok(compareVersions("0.9.10", "0.9.2") > 0);
    assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
    assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
    assert.ok(bucket("runner.a") >= 0 && bucket("runner.a") < 100);
    assert.equal(bucket("runner.a"), bucket("runner.a"), "the same machine always lands in the same share");
  });

  it("takes builds from hub admins only, and offers the target to older machines in the heartbeat", async () => {
    const bytes = new TextEncoder().encode("zip bytes of 0.80.0");
    const q = { version: "0.80.0", channel: "stable", platform: "mac", arch: "arm64", kind: "zip", name: "xdev-hive-0.80.0-mac-arm64.zip" };
    assert.equal((await upload(tok.machine, q, bytes)).status, 403, "a machine token cannot upload");
    const up = await upload(tok.admin, q, bytes);
    const file = ((await up.json()) as { result: { id: number; sha256: string; size: number } }).result;
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(file.size, bytes.length);
    assert.equal((await rpc(tok.admin, "releases.notes", { version: "0.80.0", notes: "## Thay đổi\n- tự cập nhật" })).status, 200);

    // No target yet: nothing offered.
    assert.equal((await beat("0.75.0")).body.result.update, null);
    const set = await rpc(tok.admin, "releases.setRollout", { target: "0.80.0", percent: 100, installWhen: "ask" });
    assert.equal(set.body.result.target, "0.80.0");
    assert.equal((await rpc(tok.machine, "releases.setRollout", { target: null })).status, 403, "only hub admins set the rollout");

    const offer = (await beat("0.75.0", { state: "idle", version: null, percent: null, error: null })).body.result.update;
    assert.equal(offer.version, "0.80.0");
    assert.equal(offer.file.kind, "zip");
    assert.equal(offer.notes, "## Thay đổi\n- tự cập nhật");
    assert.equal((await beat("0.80.0")).body.result.update, null, "a machine on the target is offered nothing");

    // The machine downloads with its own token.
    const dl = await fetch(`${base}${offer.url}`, { headers: { authorization: `Bearer ${tok.machine}` } });
    assert.equal(dl.status, 200);
    assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), bytes);
    assert.equal(dl.headers.get("x-hive-sha256"), file.sha256);
    assert.equal((await fetch(`${base}${offer.url}`)).status, 401, "not without a token");

    // Admins see how each machine's update goes.
    await beat("0.75.0", { state: "downloading", version: "0.80.0", percent: 42, error: null });
    const list = (await rpc(tok.admin, "releases.list")).body.result;
    assert.deepEqual(list.releases.map((r: { version: string }) => r.version), ["0.80.0"]);
    assert.deepEqual(list.machines.map((m: { current: string; state: string; percent: number }) => [m.current, m.state, m.percent]), [["0.75.0", "downloading", 42]]);
  });

  it("offers nothing while paused or outside the rollout's share, or for a platform without a build", async () => {
    await rpc(tok.admin, "releases.setRollout", { paused: true });
    assert.equal((await beat("0.75.0")).body.result.update, null);
    await rpc(tok.admin, "releases.setRollout", { paused: false, percent: 0 });
    assert.equal((await beat("0.75.0")).body.result.update, null, "0% reaches no machine");
    await rpc(tok.admin, "releases.setRollout", { percent: 100 });
    const win = await rpc(tok.machine, "machines.heartbeat", { machine: "duy-mbp", instance: "abcdef0123", version: "0.75.0", runs: [], platform: "win", arch: "x64" });
    assert.equal(win.body.result.update, null, "no Windows build was uploaded");
    assert.equal((await rpc(tok.admin, "releases.setRollout", { target: "9.9.9" })).body.error?.key, "errors.releaseNotFound");
  });

  it("gives no runs to a machine older than the minimum version", async () => {
    await rpc(tok.admin, "releases.setRollout", { minVersion: "0.80.0" });
    await beat("0.75.0");
    const [m] = (await rpc(tok.admin, "machines.list", {})).body.result as Array<{ id: string }>;
    const res = await rpc(tok.admin, "runs.dispatch", { machineId: m!.id, project: "demo", taskId: "T-1", role: "implement", profileId: null, reviewAfter: false, candidates: 1, instructions: "" });
    assert.equal(res.body.error?.key, "errors.machineTooOld");
    await rpc(tok.admin, "releases.setRollout", { minVersion: null });
  });
});
