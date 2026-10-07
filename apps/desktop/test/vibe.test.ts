import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { AGENT_TEMPLATES, OPEN_POLICY, autonomyOf, modelTierRowSchema } from "@xdev-hive/core";
import { buildCommand, applyPolicy, routeProfile, policyBlocks, withoutModel } from "#desktop/main/runner/command.ts";
import { checkLogin, checkUsage, loginParts } from "#desktop/main/runner/login.ts";
import { VibeStream, readVibeSession, vibeModels, vibeAgentUnverified } from "#desktop/main/runner/vibe.ts";
import { hubMcpEnv } from "#desktop/main/runner/container-mcp.ts";
import { cliCommand } from "#desktop/main/cli-open.ts";
import { ProfileModels } from "#desktop/main/runner/models.ts";
import { terminalScript } from "#desktop/main/terminal.ts";

const profile = AGENT_TEMPLATES.vibe;
const vars = { prompt: "A multiline\nprompt with quotes ' and $()", project: "demo", task: "T-1", run: "R-1", branch: "ai/T-1", worktree: "/tmp/work tree" };
const message = { type: "message", id: "answer", sessionId: "session-1", generationStatus: "completed", role: "assistant", content: [{ type: "text", text: "Done." }] };

it("Vibe decodes completed native entries across chunks, ignores replay/user/reasoning, keeps final text and errors", () => {
  const parser = new VibeStream("/wt");
  const entries = [
    { ...message, id: "user", role: "user", content: [{ type: "text", text: "hidden prompt" }] },
    { ...message, id: "partial", generationStatus: "streaming" },
    { ...message, id: "reason", type: "reasoning", role: undefined, text: "private reasoning" },
    { id: "call", sessionId: "session-1", type: "effect", generationStatus: "completed", detail: { toolName: "read_file", input: { path: "a.ts" } }, state: { status: "completed", outputText: "file content" } },
    message, message,
    { type: "notice", id: "error", generationStatus: "completed", level: "error", message: "quota exceeded" },
  ].map((e) => JSON.stringify(e)).join("\n");
  let log = "";
  for (let i = 0; i < entries.length; i += 13) log += parser.push(entries.slice(i, i + 13));
  log += parser.end();
  assert.match(log, /read_file/);
  assert.equal((log.match(/Done\./g) ?? []).length, 1);
  assert.doesNotMatch(log, /hidden prompt|private reasoning/);
  assert.equal(parser.lastText, "Done.");
  assert.equal(parser.sessionId, "session-1");
  assert.equal(parser.failure, "quota exceeded");
  const json = new VibeStream("/wt", "json");
  json.push(JSON.stringify([message]));
  assert.match(json.end(), /Done\./);
  assert.equal(json.lastText, "Done.");
  const legacy = new VibeStream("/wt");
  legacy.push('{"role":"assistant","content":"Legacy answer"}\nwarning\n');
  assert.equal(legacy.lastText, "Legacy answer");
});

it("Vibe command isolates MCP identity, preserves prompt argv and narrows read-only tools without bypass", () => {
  const command = buildCommand(profile, vars);
  assert.equal(command.args[command.args.indexOf("--prompt") + 1], vars.prompt);
  assert.equal(command.vibeOutput, "streaming");
  assert.equal(command.stdin, null);
  const mcp = JSON.parse(command.env!.VIBE_MCP_SERVERS!)[0];
  assert.deepEqual(mcp.env, { HIVE_AGENT: profile.id, HIVE_PROJECT: "demo", HIVE_TASK: "T-1", HIVE_RUN: "R-1" });
  assert.equal(JSON.parse(command.env!.VIBE_TOOLS!)["xdev-hive_task_claim"].permission, "always");
  assert.doesNotMatch(command.args.join(" "), /API_KEY|MISTRAL_API_KEY/);
  const fitted = applyPolicy({ ...profile, args: [...profile.args, "--auto-approve"] }, { ...OPEN_POLICY, autonomy: "read" });
  const read = buildCommand(fitted.profile, vars);
  assert.equal(autonomyOf("vibe", read.args), "read");
  assert.ok(read.args.includes("read_file"));
  assert.ok(!read.args.includes("--auto-approve"));
  assert.equal(JSON.parse(read.env!.VIBE_MCP_SERVERS!)[0].env.HIVE_READONLY, "1");
  assert.ok(policyBlocks(profile, { ...OPEN_POLICY, mcp: [] }));
  assert.ok(policyBlocks({ ...profile, args: ["--agent", "custom-agent"] }, { ...OPEN_POLICY, autonomy: "edit" }));
  const propose = applyPolicy(profile, { ...OPEN_POLICY, autonomy: "propose" }).profile;
  assert.equal(propose.readOnly, true);
  assert.ok(buildCommand(propose, vars).args.includes("read_file"));
});

it("Vibe routes configured aliases through env, honors pins/policy and supports pre-provider model settings", () => {
  const selection = { tier: "light" as const, reason: "docs/s", models: { vibe: { model: "small", effort: "high" as const } } };
  const routed = routeProfile(profile, profile, OPEN_POLICY, selection, ["small"]);
  assert.equal(routed.profile.env.VIBE_ACTIVE_MODEL, "small");
  assert.deepEqual(routed.profile.args, profile.args);
  const pin = { ...profile, env: { VIBE_ACTIVE_MODEL: "local" } };
  assert.equal(routeProfile(pin, pin, OPEN_POLICY, selection, ["small", "local"]).profile.env.VIBE_ACTIVE_MODEL, "local");
  assert.equal(withoutModel(pin).env.VIBE_ACTIVE_MODEL, undefined);
  assert.throws(() => routeProfile(profile, profile, { ...OPEN_POLICY, models: { vibe: ["small"] } }, selection, null));
  assert.deepEqual(vibeModels('[[models]]\nname="backend/model"\nalias="small"\nprovider="mistral"\n[[models]]\nname="local"\nprovider="llamacpp"'), ["small", "local"]);
  assert.equal(vibeModels('[[models]]\nalias=""'), null);
  assert.equal(modelTierRowSchema.parse({ claude: null, codex: null, antigravity: null }).vibe, null);
});

it("Vibe setup never probes inference, exposes only directory env and clears inherited account keys", async () => {
  const account = { ...profile, env: { VIBE_HOME: "/tmp/second-account", MISTRAL_API_KEY: "fixture-only-never-real" } };
  const parts = loginParts(account)!;
  assert.deepEqual(parts.args, ["--setup"]);
  assert.equal(parts.env.MISTRAL_API_KEY, undefined);
  assert.deepEqual(parts.unsetEnv, ["MISTRAL_API_KEY"]);
  for (const platform of ["linux", "win32"] as const) {
    const script = terminalScript(platform, { title: "login", bin: "vibe", ...parts, done: "done" }).content;
    assert.doesNotMatch(script, /fixture-only/);
    assert.match(script, platform === "linux" ? /unset MISTRAL_API_KEY/ : /set "MISTRAL_API_KEY="/);
  }
  const cli = cliCommand(account, { project: "demo", repo: "/wt", bin: "vibe", path: null, shim: "/tmp/hive-mcp", mcpFile: "/tmp/not-used", title: "CLI", done: "Done" });
  const windows = terminalScript("win32", cli.command).content;
  assert.match(windows, /setlocal DisableDelayedExpansion/);
  assert.match(windows, /set "VIBE_MCP_SERVERS=\[\{/);
  assert.doesNotMatch(windows, /fixture-only/);
  assert.throws(() => terminalScript("win32", { ...cli.command, env: { VIBE_MCP_SERVERS: '{"name":"x"}&calc' } }), /cmd\.exe/);
  const noRun = async () => { throw new Error("must not call the provider"); };
  assert.equal((await checkLogin(account, {}, new Date(), noRun)).loggedIn, null);
  assert.equal(await checkUsage(account, {}, new Date(), noRun), null);
  const hub = hubMcpEnv({ url: "http://hub", token: "fake-hub-token" }, { agent: "vibe-2", machine: "host", project: "demo", task: "T-1", run: "R-1", readOnly: true }, "vibe");
  assert.doesNotMatch(hub.VIBE_MCP_SERVERS!, /fake-hub-token/);
  assert.equal(JSON.parse(hub.VIBE_MCP_SERVERS!)[0].auth.api_key_env, "HIVE_HUB_TOKEN");
});

it("Vibe session stats are local to the exact root session; costs, missing and ambiguous stats stay unknown", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-vibe-"));
  try {
    const write = (folder: string, data: object) => { mkdirSync(path.join(dir, folder)); writeFileSync(path.join(dir, folder, "meta.json"), JSON.stringify(data)); };
    const metadata = { session_id: "session-1", environment: { working_directory: "/wt" }, stats: { session_prompt_tokens: 100, session_cached_tokens: 30, session_completion_tokens: 12, session_cost: 99 } };
    write("one", metadata);
    write("child", { ...metadata, session_id: "child", parent_session_id: "session-1" });
    write("other-account", { ...metadata, session_id: "other", environment: { working_directory: "/other" } });
    assert.deepEqual(readVibeSession(dir, "/wt", "session-1", "Done")?.usage, { text: "Done", costUsd: null, inputTokens: 70, cacheReadTokens: 30, cacheWriteTokens: null, outputTokens: 12 });
    assert.equal(readVibeSession(dir, "/wt", "missing", null), null);
    write("two", { ...metadata, session_id: "session-2", stats: {} });
    assert.equal(readVibeSession(dir, "/wt", null, null), null);
    assert.equal(readVibeSession(dir, "/wt", "session-2", null)?.usage, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads root-session usage when the CLI resolves a worktree directory alias", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-vibe-alias-"));
  try {
    const worktree = path.join(dir, "worktree");
    const alias = path.join(dir, "alias");
    mkdirSync(worktree);
    symlinkSync(worktree, alias, "junction");
    mkdirSync(path.join(dir, "session"));
    writeFileSync(path.join(dir, "session", "meta.json"), JSON.stringify({
      session_id: "root", environment: { working_directory: worktree },
      stats: { session_prompt_tokens: 100, session_cached_tokens: 30, session_completion_tokens: 12 },
    }));
    assert.equal(readVibeSession(dir, alias, "root", "Done")?.usage?.inputTokens, 70);
    assert.equal(readVibeSession(dir, dir, "root", "Done"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("Vibe model discovery uses the account directory, handles invalid config as unknown and never probes inference", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "hive-vibe-models-"));
  try {
    const models = new ProfileModels();
    const account = { ...profile, env: { VIBE_HOME: home } };
    assert.equal(models.snapshot(account, {}), null);
    assert.equal(vibeAgentUnverified("/wt", { VIBE_HOME: home }, profile.args), false);
    mkdirSync(path.join(home, "agents"));
    writeFileSync(path.join(home, "agents", "accept-edits.toml"), 'bypass_tool_permissions = true');
    assert.equal(vibeAgentUnverified("/wt", { VIBE_HOME: home }, profile.args), true);
    assert.equal(vibeAgentUnverified("/wt", { VIBE_HOME: home }, ["--agent", "auto-approve"]), false);
    writeFileSync(path.join(home, "config.toml"), '[[models]]\nname="backend/model"\nalias="my-model"\nprovider="mistral"');
    assert.ok(models.snapshot(account, {})?.includes("my-model"));
    assert.equal(models.snapshot({ ...account, env: { ...account.env, VIBE_MODELS: "bad-json" } }, {}), null);
    assert.deepEqual(models.snapshot({ ...account, env: { ...account.env, VIBE_MODELS: '[{"alias":"test-model"}]' } }, {}), ["test-model"]);
    assert.equal(models.snapshot({ ...account, container: { image: "hive-agent", network: "open", allow: [] } }, {}), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
