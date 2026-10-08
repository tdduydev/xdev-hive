// A loopback-only rollout probe: never connects to an installed hub or changes its feature flag/local policy.
// These checks complement the regression suite; a failed AC produces a NO-GO receipt, not a green pilot.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_WS_PROTOCOL } from "@xdev-hive/core";
import { SqliteHive, TerminalRecorder, readTerminalTranscript, WsPeer } from "@xdev-hive/core/node";
import { MachineSocket } from "@xdev-hive/desktop/src/main/pty/machine-socket.ts";
import { MachineTerminalAgent } from "@xdev-hive/desktop/src/main/pty/relay-agent.ts";
import { ResourceLocks } from "@xdev-hive/desktop/src/main/resource-locks.ts";
import { createHubApp, terminalUpgrade } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

const outputFile = process.argv[2] && resolve(process.argv[2]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = performance.now() + ms;
  while (!check()) { if (performance.now() >= end) throw new Error("fixture deadline"); await sleep(20); }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hive-terminal-pilot-"));
  const master = randomBytes(32);
  const password = randomBytes(24).toString("base64url");
  const hive = new SqliteHive(":memory:");
  const users = new UserStore(hive.db);
  const tokens = new TokenStore(hive.db);
  let server, agent, machine, app;
  const browsers = [];
  async function close() {
    await agent?.stopAll(); agent?.dispose(); machine?.stop();
    app?.locals.terminalRelay?.stop();
    for (const b of browsers) b.peer.socket.destroy();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    hive.close(); rmSync(root, { recursive: true, force: true });
  }
  try {
  const { user, password: initial } = users.create({ username: "pilot-owner" });
  users.changePassword(user.id, initial, password);
  users.setGrants(user.id, { fixture: "member" });
  const cookie = users.startSession(user.id).token;
  const credential = tokens.create("pilot-machine", "member", user.id);
  const machineId = "runner.pilot@pilot-machine";
  app = createHubApp({
    hive, users, tokens, allowedHosts: ["127.0.0.1"], remoteTerminal: true,
    terminalIdentity: {
      isMachineActor: (id, actor) => hive.isMachineActor(id, actor),
      pinnedOwner: id => hive.machinePinnedOwner(id),
    },
  });
  server = app.listen(0, "127.0.0.1");
  server.on("upgrade", terminalUpgrade(app));
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  async function post(path, body, machine = false) {
    const headers = { "content-type": "application/json" };
    if (machine) Object.assign(headers, { authorization: `Bearer ${credential.token}`, "x-hive-agent": "runner.pilot", "x-hive-source": JSON.stringify({ via: "desktop" }) });
    else Object.assign(headers, { cookie: `hive_session=${cookie}`, "x-hive-csrf": "1", origin: base });
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  }
  const rpc = (method, input) => post("/api/rpc", { method, input });
  const cap = { protocol: 1, enabled: true, projects: ["fixture"], platforms: ["linux"], auditReady: true, guiReady: false };
  assert.equal((await post("/api/rpc", { method: "machines.heartbeat", input: { machine: "pilot", instance: "aaaaaaaa", projects: ["fixture"], terminal: cap } }, true)).status, 200);
  const canary = `synthetic-known-${randomBytes(12).toString("hex")}`;
  const ptys = [];
  const recorders = [];
  const frames = [];
  const locks = new ResourceLocks();
  // Scripted PTY permits deterministic output and kill timing. This does not prove native spawn or process cleanup.
  agent = new MachineTerminalAgent({
    locks, draining: () => false,
    recorder: sessionId => {
      const recorder = TerminalRecorder.open({ root, sessionId, master, known: [canary] });
      recorders.push(recorder);
      return recorder;
    },
    pty: cb => {
      const p = {
        stopped: false, written: [], cb,
        spawn(_project, cols, rows) { cb.audit({ type: "spawn", cols, rows }); },
        write(data) { cb.audit({ type: "sensitive-input", bytes: data.length }); this.written.push(data.toString()); },
        resize(cols, rows) { cb.audit({ type: "resize", cols, rows }); },
        pause() {}, resume() {},
        stop() { this.stopped = true; return Promise.resolve(); },
      };
      ptys.push(p);
      return p;
    },
  });
  machine = new MachineSocket({ hubUrl: base, token: () => credential.token, label: () => "runner.pilot", agent: {
    connected: send => agent.connected(f => { frames.push(f.type); return send(f); }),
    disconnected: () => agent.disconnected(),
    receive: f => agent.receive(f),
  } });
  machine.start();
  await until(() => machine.connected);
  async function browser(ticket) {
    const upgraded = await new Promise((res, rej) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/terminal/socket", headers: {
        connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-protocol": TERMINAL_WS_PROTOCOL, cookie: `hive_session=${cookie}`, origin: base,
      } });
      req.on("upgrade", (_res, socket, head) => res({ socket, head }));
      req.on("response", response => { response.resume(); rej(new Error("upgrade refused")); });
      req.on("error", rej); req.end();
    });
    const b = { frames: [], closed: false, peer: null };
    b.peer = new WsPeer(upgraded.socket, { maxPayload: 1 << 20, server: false,
      onText: text => {
        const f = JSON.parse(text); b.frames.push(f);
        if (f.type === "state" && f.state === "active") b.peer.send({ type: "ack", outputSeq: 0 });
      }, onClose: () => { b.closed = true; },
    }, upgraded.head);
    browsers.push(b); b.peer.send({ type: "auth", ticket });
    return b;
  }
  async function proof(operation, sessionId) {
    const p = await post("/api/terminal/step-up", { method: "password", password, operation, project: "fixture", machineId, ...(sessionId ? { sessionId } : {}) });
    assert.equal(p.status, 200); return p.result.stepUpId;
  }
  const created = await rpc("terminal.create", { project: "fixture", machineId, checkoutRef: "repo", mode: "shell", stepUpId: await proof("create"), reason: "isolated 69g probe", idempotencyKey: crypto.randomUUID() });
  assert.equal(created.status, 200);
  const id = created.result.session.id;
  const b = await browser(created.result.ticket);
  await until(() => b.frames.some(f => f.type === "state" && f.state === "active"));
  await sleep(50);
  const row = () => hive.db.prepare("SELECT state, last_reason FROM terminal_sessions WHERE id = ?").get(id);
  return { hive, users, tokens, credential, user, cookie, agent, machine, locks, canary, ptys, b, id, row, rpc, proof, browser, master, root, recorders, frames, close };
  } catch (error) { await close(); throw error; }
}

const results = [];
async function observeStop(f) {
  const started = performance.now();
  while (!f.ptys[0].stopped && performance.now() - started < 2000) await sleep(20);
  const elapsed = performance.now() - started;
  const stoppedWithin2s = f.ptys[0].stopped && elapsed <= 2000;
  await sleep(Math.max(0, 2100 - elapsed));
  return { pass: stoppedWithin2s, stoppedWithin2s, stateAfter2100ms: f.row().state };
}
async function probe(name, ac, run) {
  let f;
  try { f = await fixture(); results.push({ name, ac, ...await run(f) }); }
  catch (error) { results.push({ name, ac, pass: false, error: "fixture/probe failed; inspect environment separately", errorClass: error.constructor.name }); }
  finally { await f?.close(); }
}

await probe("known secret in live/replay output", "AC06", async f => {
  f.ptys[0].cb.output(f.canary.slice(0, 10)); f.ptys[0].cb.output(f.canary.slice(10) + "\n");
  await until(() => f.b.frames.some(frame => frame.type === "output")); await sleep(100);
  const live = f.b.frames.filter(frame => frame.type === "output").map(frame => Buffer.from(frame.data, "base64").toString()).join("");
  f.b.peer.socket.destroy(); await until(() => f.row().state === "detached");
  const attached = await f.rpc("terminal.attach", { sessionId: f.id, stepUpId: await f.proof("attach", f.id), lastOutputSeq: 0, takeControl: true });
  assert.equal(attached.status, 200);
  const resumed = await f.browser(attached.result.ticket);
  await until(() => resumed.frames.some(frame => frame.type === "output")); await sleep(100);
  const replay = resumed.frames.filter(frame => frame.type === "output").map(frame => Buffer.from(frame.data, "base64").toString()).join("");
  await f.agent.stopAll();
  const transcript = JSON.stringify(readTerminalTranscript(f.root, f.id, f.master));
  return { pass: !live.includes(f.canary) && !replay.includes(f.canary) && !transcript.includes(f.canary), liveCanaryExposed: live.includes(f.canary), replayCanaryExposed: replay.includes(f.canary), transcriptCanaryExposed: transcript.includes(f.canary) };
});
await probe("project revoke while detached", "AC04", async f => {
  f.b.peer.socket.destroy(); await until(() => f.row().state === "detached");
  f.users.setGrants(f.user.id, {});
  return observeStop(f);
});
await probe("machine parent credential revoke online", "AC04", async f => {
  f.tokens.revoke(f.credential.info.id);
  return { ...await observeStop(f), machineSocketClosed: !f.machine.connected };
});
await probe("revoke during browser reconnect", "AC08", async f => {
  f.b.peer.socket.destroy(); await until(() => f.row().state === "detached");
  const attached = await f.rpc("terminal.attach", { sessionId: f.id, stepUpId: await f.proof("attach", f.id), lastOutputSeq: 0, takeControl: true });
  assert.equal(attached.status, 200);
  f.users.endSession(f.cookie);
  let refused = false;
  try { const b = await f.browser(attached.result.ticket); await until(() => b.closed); refused = !b.frames.some(frame => frame.type === "state" && frame.state === "active"); } catch { refused = true; }
  await until(() => f.ptys[0].stopped);
  return { pass: refused, staleReconnectRefused: refused, stopped: f.ptys[0].stopped };
});
await probe("emergency stop and input after stop", "AC04", async f => {
  const started = performance.now();
  assert.equal((await f.rpc("terminal.terminate", { sessionId: f.id, reason: "emergencyStop" })).status, 200);
  await until(() => f.ptys[0].stopped);
  const stopMs = Math.round(performance.now() - started);
  f.agent.receive({ type: "input", sessionId: f.id, epoch: 0, inputSeq: 1, data: Buffer.from("blocked").toString("base64") });
  await until(() => !f.agent.busy);
  return { pass: stopMs <= 2000 && f.ptys[0].written.length === 0 && !f.locks.has("terminal"), stopMs, inputWrittenAfterStop: f.ptys[0].written.length, lockReleased: !f.locks.has("terminal") };
});
const receipt = { status: results.every(r => r.pass) ? "LOCAL_PROBES_PASS" : "NO_GO", generatedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" }).trim(), probeSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), scope: "loopback HTTP/WS + production pinned identity + machine agent + encrypted recorder; scripted PTY, no GUI/Cloudflare/physical phone evidence", platform: process.platform, arch: process.arch, node: process.version, results };
if (outputFile) writeFileSync(outputFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
process.exitCode = results.every(r => r.pass) ? 0 : 1;
