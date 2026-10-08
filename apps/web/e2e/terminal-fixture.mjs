import { randomBytes } from "node:crypto";
import { request } from "node:http";
import path from "node:path";
import express from "express";
import { SqliteHive, WsPeer } from "@xdev-hive/core/node";
import { TERMINAL_MACHINE_WS_PROTOCOL } from "@xdev-hive/core";
import { createHubApp, terminalUpgrade } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

/** Isolated loopback hub with real cookie auth/RPC/WS and a scripted machine. It never spawns a process/PTY. */
export async function terminalFixture() {
  const hive = new SqliteHive(":memory:");
  const users = new UserStore(hive.db), tokens = new TokenStore(hive.db);
  const created = users.create({ username: "terminal-user", admin: true });
  const password = "Synthetic-terminal-69!";
  users.changePassword(created.user.id, created.password, password);
  const token = tokens.create("terminal-machine", "member", created.user.id).token;
  const app = createHubApp({ hive, users, tokens, remoteTerminal: true, allowedHosts: ["127.0.0.1"],
    // The hub's own wiring (server.ts): the row runner.terminal-fixture@terminal-machine is pinned at its first heartbeat.
    terminalIdentity: { isMachineActor: (id, actor) => hive.isMachineActor(id, actor), pinnedOwner: id => hive.machinePinnedOwner(id) },
  });
  const state = { inputs: [], resizes: [], opens: 0, epoch: 0, kills: 0 };
  const sockets = new Set();
  let peer, sessionId, outputSeq = 0, replaying = false;
  const report = (type, reason) => peer.send({ type: "report", sessionId, epoch: state.epoch, state: type, reason, exitCode: type === "closed" ? 0 : null, auditSeq: 0, cleanupUncertain: false });
  const output = text => peer.send({ type: "output", sessionId, epoch: state.epoch, outputSeq: ++outputSeq, data: Buffer.from(text).toString("base64") });
  app.get("/__terminal/state", (_req, res) => res.json(state));
  app.post("/__terminal/drop", (_req, res) => { for (const socket of sockets) socket.destroy(); res.json({ ok: true }); });
  app.post("/__terminal/gap", (_req, res) => { peer.send({ type: "gap", sessionId, firstAvailableSeq: outputSeq + 2 }); outputSeq++; output("\r\nAFTER-GAP\r\n"); res.json({ ok: true }); });
  app.post("/__terminal/escapes", (_req, res) => { output("\x1b]52;c;c3ludGhldGlj\x07\x1b]8;;javascript:alert(1)\x07UNSAFE-LINK\x1b]8;;\x07"); res.json({ ok: true }); });
  app.use(express.static(path.resolve(import.meta.dirname, "../dist/client")));
  const server = app.listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/terminal/socket") { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); }
    terminalUpgrade(app)(req, socket, head);
  });
  await new Promise(resolve => server.once("listening", resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  // The machine's calls carry the runner's label, as the desktop's do: with the token's name that is the machine row.
  const RUNNER = { "x-hive-agent": "runner.terminal-fixture", "x-hive-source": JSON.stringify({ via: "desktop" }) };
  const rpc = async (method, input, bearer = token) => {
    const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...(bearer === token ? RUNNER : {}) }, body: JSON.stringify({ method, input }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.key ?? j.error.message); return j.result;
  };
  const cap = { protocol: 1, enabled: true, projects: ["demo"], platforms: ["linux"], auditReady: true, guiReady: true, osUser: "synthetic-os-user" };
  const beat = () => rpc("machines.heartbeat", { machine: "terminal-fixture", instance: "eeee0069", version: "0.146.2", projects: ["demo"], terminal: cap });
  app.post("/__terminal/opt-out", async (_req, res) => { cap.enabled = false; await beat(); res.json({ ok: true }); });
  const admin = tokens.create("fixture-admin", "admin", created.user.id).token;
  await rpc("docs.save", { key: "project/demo/guide", title: "Fixture", content: "Synthetic terminal fixture", baseVersion: 0 }, admin);
  await rpc("tasks.create", { id: "TERM-1", project: "demo", title: "Terminal fixture task" }, admin);
  await beat();
  await rpc("runs.push", { machine: "terminal-fixture", runs: [{ runId: "R-terminal", project: "demo", taskId: "TERM-1", taskTitle: "Terminal fixture run", role: "implement", status: "succeeded", profileId: null, createdAt: new Date().toISOString() }] });
  const machine = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/terminal/machine-socket", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), authorization: `Bearer ${token}`, ...RUNNER, "sec-websocket-protocol": TERMINAL_MACHINE_WS_PROTOCOL } });
    req.on("upgrade", (_res, socket, head) => resolve({ socket, head }));
    req.on("response", res => { res.resume(); reject(new Error(`fixture machine upgrade ${res.statusCode}`)); }); req.on("error", reject); req.end();
  });
  peer = new WsPeer(machine.socket, { server: false, maxPayload: 1 << 20, onClose: () => undefined, onText: raw => {
    const f = JSON.parse(raw);
    if (f.type === "ping") peer.send({ type: "pong", nonce: f.nonce });
    else if (f.type === "open") { sessionId = f.sessionId; state.epoch = f.epoch; state.opens++; report("active", "spawned"); }
    else if (f.type === "lease") state.epoch = f.epoch;
    else if (f.type === "replay") { replaying = true; if (outputSeq === 0) output("READY · Tiếng Việt\r\n\x1b[?2004h"); }
    else if (f.type === "detach") replaying = false;
    else if (f.type === "input") {
      if (f.epoch !== state.epoch) throw new Error("fixture received input before epoch lease");
      const text = Buffer.from(f.data, "base64").toString(); state.inputs.push({ epoch: f.epoch, seq: f.inputSeq, text });
      peer.send({ type: "inputAck", sessionId, epoch: f.epoch, inputSeq: f.inputSeq });
      if (replaying) output(text.replace(/[\x00-\x1f]/g, c => c === "\r" ? "\r\n" : ""));
    } else if (f.type === "resize") state.resizes.push({ cols: f.cols, rows: f.rows });
    else if (f.type === "kill") { state.kills++; report("closed", "userClosed"); }
  } }, machine.head);
  peer.send({ type: "hello", protocol: 1, sessions: [] });
  const timer = setInterval(() => void beat(), 30_000);
  return { base, username: "terminal-user", password, machineId: "runner.terminal-fixture@terminal-machine", close: () => { clearInterval(timer); app.locals.terminalRelay?.stop(); machine.socket.destroy(); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); hive.close(); } };
}
