import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHiveMcpServer } from "@xdev-hive/mcp";
import { AGENT_TEMPLATES, type Actor, type AgentProfile } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { ChatWorker, codexChatArgs } from "#desktop/main/runner/chat.ts";
import { leaderRepoScript } from "#desktop/main/runner/leader-repo.ts";

const admin: Actor = { name: "test", role: "admin" };
const machine: Actor = { name: "runner@test", role: "agent" };
const fixture = path.join(import.meta.dirname, "fixtures/fake-agent.mjs");

async function setup(mode = "codex-chat", local = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-leader-codex-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(path.join(repo, "README.md"), "demo");
  const bin = path.join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
  const record = path.join(dir, "calls.jsonl");
  const profile: AgentProfile = { ...AGENT_TEMPLATES.codex, id: "codex-1", bin, env: { FAKE_MODE: mode, FAKE_RECORD: record } };
  const profiles = [profile];
  const hive = new SqliteHive(":memory:", { local });
  const reported = { id: profile.id, label: profile.id, kind: "codex", priority: 10, enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 };
  if (local) hive.setChatMachine(() => ({ id: machine.name, machine: "test", profiles: [reported], projects: ["demo"], online: true, acceptsRuns: true, duplicate: false, owner: null, version: "", lastSeen: "", runs: [], profileChanges: [] }));
  const beat = () => hive.call("machines.heartbeat", { machine: "test", instance: "1234abcd", projects: ["demo"], acceptsRuns: true, profiles: profiles.map((p) => ({ ...reported, id: p.id, kind: p.kind, priority: p.priority })) }, machine);
  if (!local) await beat();
  let replyId = 0;
  const transports = new Set<StreamableHTTPServerTransport>();
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fake-chat-grant");
    assert.equal(req.headers["x-hive-agent"], "codex-1.test");
    assert.equal(req.headers["x-hive-run"], `chat-${replyId}`);
    const mcp = createHiveMcpServer(hive, { ...machine, agent: "codex-1.test", chatReply: replyId }, { defaultProject: "demo" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transports.add(transport);
    res.on("close", () => { transports.delete(transport); void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hubUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const worker = new ChatWorker({ backend: () => hive, actor: () => machine, machine: () => "test", projects: () => [{ name: "demo", repo }], profiles: () => profiles, env: () => process.env, hubUrl: () => hubUrl, local: () => local }, { dataDir: dir, progressMs: 10 });
  const send = async (text: string, threadId?: number) => {
    const sent = await hive.call("chat.send", { project: "demo", machineId: machine.name, threadId, text }, admin);
    replyId = sent.reply.id;
    const requests = await hive.call("chat.poll", {}, machine);
    worker.take(requests.map((r) => ({ ...r, grant: "fake-chat-grant" })));
    return sent;
  };
  const calls = () => readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((r) => typeof r.chat === "string" || r.args?.[0] === "exec");
  const reply = async (id: number) => (await hive.call("chat.get", { threadId: id }, admin))!.messages.at(-1)!;
  const close = async () => { worker.stop(); await worker.settle(); for (const transport of transports) await transport.close(); await new Promise<void>((resolve) => server.close(() => resolve())); hive.close(); rmSync(dir, { recursive: true, force: true }); };
  return { profile, profiles, beat, worker, hive, dir, repo, send, calls, reply, close };
}

it("creates and resumes the exact Codex leader session, streams text and proposes through the reply's MCP grant", async () => {
  const a = await setup();
  try {
    a.profile.env.FAKE_PROPOSE = "1";
    const first = await a.send("- propose work");
    await a.worker.settle();
    const reply = await a.reply(first.thread.id);
    assert.equal(reply.status, "done", reply.error?.message);
    assert.equal(reply.text, "Answer: - propose work");
    assert.equal(reply.author, "codex-1@test");
    assert.deepEqual(reply.tokens, { inputTokens: 80, cacheReadTokens: 20, outputTokens: 30 });
    assert.equal(reply.costUsd, null, "subscription CLI supplies tokens, no USD amount");
    assert.equal(reply.actions[0]?.kind, "task.create");
    assert.equal((await a.hive.call("tasks.list", { project: "demo" }, admin)).some((t) => t.id === "CHAT-62a"), false, "a proposal is not a direct write");
    const [call] = a.calls();
    assert.equal(call.cwd, realpathSync(a.repo));
    assert.equal(call.args.at(-1), "-");
    assert.ok(call.args.includes("read-only"));
    assert.ok(call.args.includes("features.shell_tool=false"));
    assert.ok(call.args.includes("features.hooks=false"));
    assert.ok(call.args.includes("features.codex_hooks=false"));
    assert.ok(!call.args.join(" ").includes("fake-chat-grant"), "grant stays in the environment");
    assert.ok(call.args.find((v: string) => v.startsWith("mcp_servers=")).includes('"required"=true'));
    a.profile.env.FAKE_PROPOSE = "0";
    await a.send("continue", first.thread.id);
    await a.worker.settle();
    const second = a.calls()[1];
    assert.deepEqual(second.args.slice(-3), ["resume", "fake-chat-thread", "-"]);
    assert.equal(second.prompt, "continue");
    assert.equal((await a.reply(first.thread.id)).status, "done");
    assert.deepEqual(readdirSync(path.join(a.dir, "runs")), [], "reply files are removed");
  } finally { await a.close(); }
});

it("switches a quota-failed Claude thread to Codex only at the next user turn, carrying its conversation", async () => {
  const a = await setup();
  try {
    a.profiles.unshift({ ...AGENT_TEMPLATES.claude, id: "claude-1", priority: 1, bin: a.profile.bin, env: { FAKE_MODE: "chat", FAKE_CHAT_QUOTA: "1", FAKE_RECORD: path.join(a.dir, "calls.jsonl") } });
    await a.beat();
    await a.hive.call("chat.setDefaults", { project: "demo", machineId: machine.name, profileId: "claude-1", model: "opus", effort: "high" }, admin);
    const first = await a.send("Plan this service");
    await a.worker.settle();
    assert.equal((await a.reply(first.thread.id)).status, "failed");
    assert.equal(a.calls().length, 1, "no provider change inside a reply");
    const next = await a.send("Continue the plan", first.thread.id);
    assert.equal(next.thread.profileId, "codex-1");
    assert.equal(next.thread.model, null, "Claude aliases must not be passed to Codex");
    assert.equal(next.thread.effort, null);
    await a.worker.settle();
    const reply = await a.reply(first.thread.id);
    assert.equal(reply.status, "done", reply.error?.message);
    assert.equal(reply.switchedFrom, "claude-1");
    const switched = a.calls()[1];
    assert.ok(!switched.args.includes("resume"));
    assert.match(switched.prompt, /user: Plan this service/);
    assert.match(switched.prompt, /assistant: Partial Claude reply/);
    assert.match(switched.prompt, /Current message:\nContinue the plan/);
    await a.send("And next?", first.thread.id); await a.worker.settle();
    assert.deepEqual(a.calls()[2].args.slice(-3), ["resume", "fake-chat-thread", "-"]);
  } finally { await a.close(); }
});

it("reports partial Codex text before completion and cancels the process", async () => {
  const a = await setup("codex-chat-slow");
  try {
    const sent = await a.send("slow");
    for (let i = 0; i < 100 && !(await a.reply(sent.thread.id)).text; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await a.reply(sent.thread.id)).text, "Reading Hive…");
    await a.hive.call("chat.cancel", { replyId: sent.reply.id }, admin);
    await a.worker.settle();
    assert.equal((await a.reply(sent.thread.id)).status, "cancelled");
  } finally { await a.close(); }
});

it("fails a Codex turn.failed event even when the CLI exits zero", async () => {
  const a = await setup("codex-chat-failed");
  try { const sent = await a.send("fail"); await a.worker.settle(); assert.equal((await a.reply(sent.thread.id)).status, "failed"); }
  finally { await a.close(); }
});

it("gives a local Codex leader the local shim's reply identity, without a hub token", async () => {
  const a = await setup("codex-chat", true);
  try {
    const sent = await a.send("read local"); await a.worker.settle();
    assert.equal((await a.reply(sent.thread.id)).status, "done");
    const config = a.calls()[0].args.find((v: string) => v.startsWith("mcp_servers="));
    assert.ok(config.includes('"HIVE_CHAT_REPLY"="' + sent.reply.id + '"'));
    assert.ok(config.includes('"HIVE_AGENT"="codex-1"'));
    assert.ok(!config.includes("bearer_token_env_var"));
  } finally { await a.close(); }
});

it("keeps Codex model, effort and safety overrides on resume", () => {
  const args = codexChatArgs({ sessionId: "thread-62a", model: "test-model", effort: "high", servers: {}, brief: "read only" });
  assert.deepEqual(args.slice(-3), ["resume", "thread-62a", "-"]);
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes("test-model"));
  assert.ok(!args.includes("--last") && !args.includes("--full-auto"));
});

it("enforces repo boundaries and permitted argv prefixes in the Codex leader's repo MCP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-leader-repo-"));
  const repo = path.join(dir, "service with spaces");
  mkdirSync(repo);
  const outside = path.join(dir, "outside.txt");
  writeFileSync(outside, "outside");
  writeFileSync(path.join(repo, "README.md"), "inside");
  symlinkSync(outside, path.join(repo, "escape"));
  execFileSync("git", ["init", "-q", repo]);
  const script = path.join(dir, "repo.mjs");
  writeFileSync(script, leaderRepoScript({ roots: [repo], cwd: dir, commands: ["git status", "git diff", "git status; touch bad"], repos: [repo] }));
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script] }));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    assert.equal((await call("read_file", { path: path.join(repo, "README.md") })).isError, undefined);
    for (const file of [outside, path.join(repo, "escape")]) assert.equal((await call("read_file", { path: file })).isError, true);
    assert.equal((await call("command", { argv: ["git", "-C", repo, "status", "--short"] })).isError, undefined);
    for (const argv of [["git", "status"], ["sh", "-c", "touch bad"], ["git", "-C", repo, "diff", "--output=" + outside], ["git", "-C", repo, "diff", "--out=" + outside], ["git", "-C", repo, "diff", "--ext-diff"], ["git", "-C", repo, "diff", "--ext-d"], ["git", "-C", repo, "status", "-C", dir]]) {
      assert.equal((await call("command", { argv })).isError, true, JSON.stringify(argv));
    }
    assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
