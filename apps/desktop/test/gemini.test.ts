import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { containerCommand } from "#desktop/main/runner/container.ts";
import { AGENT_TEMPLATES, DEFAULT_MODEL_ROUTER, OPEN_POLICY, selectModel } from "@xdev-hive/core";
import { geminiLaunch } from "#desktop/main/runner/gemini-launch.ts";
import { GeminiStream, GEMINI_MODELS, geminiHome, geminiJson, geminiLogin, geminiUsage, prepareGeminiSettings } from "#desktop/main/runner/gemini.ts";
import { applyPolicy, buildCommand, routeProfile } from "#desktop/main/runner/command.ts";
import { checkLogin, checkUsage, loginCommand, loginParts } from "#desktop/main/runner/login.ts";
import { ProfileModels } from "#desktop/main/runner/models.ts";
import { planningProfile } from "#desktop/main/runner/plan-approval.ts";

const event = (e: object) => JSON.stringify(e) + "\n";
const stats = { input_tokens: 5000, cached: 4000, input: 1000, output_tokens: 300 };
it("parses fragmented Gemini messages, native tools, successful skills and aggregate stats without counting model stats twice", () => {
  const s = new GeminiStream();
  const text = event({ type: "init", session_id: "exact-session", model: "flash" }) +
    event({ type: "message", role: "user", content: "private prompt" }) +
    event({ type: "message", role: "assistant", content: "Looking…", delta: true }) +
    event({ type: "tool_use", tool_name: "mcp__xdev_hive__skill_get", tool_id: "1", parameters: { name: "review-pr" } }) +
    event({ type: "tool_result", tool_id: "1", status: "success", output: "instructions" }) +
    event({ type: "tool_use", tool_name: "read_file", tool_id: "2", parameters: { file_path: "skills/no-load/SKILL.md" } }) +
    event({ type: "tool_result", tool_id: "2", status: "error", error: { message: "not found" } }) +
    event({ type: "message", role: "assistant", content: "Đã ", delta: true }) +
    event({ type: "message", role: "assistant", content: "xong", delta: true }) +
    event({ type: "result", status: "success", stats: { ...stats, models: { flash: stats } } }).trimEnd();
  let log = "";
  for (let n = 0; n < text.length; n += 7) log += s.push(text.slice(n, n + 7));
  log += s.end();
  assert.match(log, /▶ mcp__xdev_hive__skill_get/);
  assert.match(log, /Đã xong/);
  assert.doesNotMatch(log, /private prompt/);
  assert.equal(s.sessionId, "exact-session");
  assert.equal(s.lastText, "Đã xong");
  assert.deepEqual([...s.skills], ["review-pr"]);
  assert.deepEqual(s.usage, { text: "Đã xong", costUsd: null, inputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: null, outputTokens: 300 });
  assert.equal(s.failure, null);
});

it("keeps terminal stream errors and missing results visible, preserves unknown output and sums resumed turns", () => {
  const s = new GeminiStream();
  assert.equal(s.push("CLI warning\n"), "CLI warning\n");
  s.push(event({ type: "init", session_id: "same" }) + event({ type: "error", severity: "warning", message: "retrying" }) + event({ type: "result", status: "success", stats }));
  s.end(); assert.equal(s.failure, null);
  s.push(event({ type: "init", session_id: "same" }) + event({ type: "message", role: "assistant", content: "second", delta: true }) + event({ type: "result", status: "success", stats }));
  s.end(); assert.equal(s.usage?.inputTokens, 2000); assert.equal(s.usage?.text, "second");
  const failed = new GeminiStream();
  failed.push(event({ type: "error", severity: "error", message: "QUOTA_EXHAUSTED" }) + event({ type: "result", status: "error" }));
  assert.equal(failed.failure, "QUOTA_EXHAUSTED");
  const truncated = new GeminiStream(); truncated.push(event({ type: "init" })); truncated.end();
  assert.match(truncated.failure!, /without a result/);
});

it("reads single-JSON per-model telemetry and rejects invalid token numbers", () => {
  const j = geminiJson(JSON.stringify({ response: "done", stats: { models: { flash: { tokens: { prompt: 40, cached: 25, candidates: 8 } }, pro: { tokens: { prompt: 30, cached: 10, candidates: 2 } } } } }));
  assert.equal(j?.usage?.inputTokens, 35); assert.equal(j?.usage?.cacheReadTokens, 35); assert.equal(j?.usage?.outputTokens, 10);
  assert.equal(geminiUsage({ input_tokens: -1, output_tokens: "unknown" }, null), null);
  assert.equal(geminiJson('{"error":{"message":"denied"}}')?.failure, "denied");
});

it("checks account-local credentials without invoking the model or exposing a key in login parts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-gemini-auth-"));
  try {
    const p = { ...AGENT_TEMPLATES.gemini, bin: process.execPath, env: { GEMINI_CLI_HOME: root } };
    const base = { PATH: path.dirname(process.execPath), HOME: root };
    const run = async () => { throw new Error("must not invoke CLI for login or quota"); };
    assert.equal(geminiHome(p.env), path.join(root, ".gemini"));
    assert.equal((await checkLogin(p, base, new Date(), run)).loggedIn, false);
    mkdirSync(path.join(root, ".gemini"));
    writeFileSync(path.join(root, ".gemini/settings.json"), '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    writeFileSync(path.join(root, ".gemini/oauth_creds.json"), '{"refresh_token":"fake-fixture"}');
    assert.deepEqual(geminiLogin(p.env), { loggedIn: null, method: "Google OAuth" });
    assert.equal((await checkLogin(p, base, new Date(), run)).method, "Google OAuth");
    assert.equal(await checkUsage(p, base, new Date(), run), null);
    const keyed = { ...p, env: { ...p.env, GEMINI_API_KEY: "fake-fixture" } };
    assert.deepEqual(loginParts(keyed), { args: [], env: { GEMINI_CLI_HOME: root } });
    assert.doesNotMatch(loginCommand(keyed)!, /fake-fixture|API_KEY/);
    assert.equal(geminiLogin(keyed.env).loggedIn, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("routes Gemini aliases without effort, honours pins and forces native plan permissions for read-only", async () => {
  const selection = selectModel(DEFAULT_MODEL_ROUTER, "demo", { kind: "feature", size: "m", risk: "normal", role: "implement" })!;
  const p = AGENT_TEMPLATES.gemini;
  assert.equal(selection.models.gemini?.model, "auto");
  const routed = routeProfile(p, p, OPEN_POLICY, { ...selection, models: { gemini: { model: "flash", effort: "high" } } }, GEMINI_MODELS);
  assert.ok(routed.profile.args.includes("flash")); assert.ok(!routed.profile.args.includes("--effort"));
  const args = ["-p", "{prompt}", "--approval-mode", "yolo", "--yolo=true", "--allowed-tools", "run_shell_command"];
  const lowered = applyPolicy({ ...p, args: [...args, "write_file"] }, { ...OPEN_POLICY, autonomy: "read" }).profile;
  assert.ok(!lowered.args.includes("run_shell_command")); assert.ok(!lowered.args.includes("write_file"));
  const restricted = applyPolicy({ ...p, args: [...p.args, "--allowed-mcp-server-names", "bad", "evil"] }, { ...OPEN_POLICY, mcp: [] });
  assert.ok(!restricted.profile.args.includes("bad")); assert.ok(!restricted.profile.args.includes("evil"));
  const cmd = buildCommand({ ...p, args, readOnly: true }, { prompt: "line1\nline2".repeat(2000), worktree: "/tmp/work", task: "T", project: "demo", branch: "ai/T" });
  assert.equal(cmd.stdin?.length, 22000); assert.ok(!cmd.args.includes(cmd.stdin!)); assert.ok(cmd.geminiStream);
  assert.ok(cmd.args.includes("plan")); assert.ok(!cmd.args.includes("yolo")); assert.ok(!cmd.args.includes("--yolo=true"));
  assert.ok(planningProfile(p).readOnly);
});

it("writes worktree-local MCP identity and read-only context, leaving secrets as env references", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-gemini-mcp-"));
  try {
    mkdirSync(path.join(root, ".gemini"));
    writeFileSync(path.join(root, ".gemini/settings.json"), '{"mcpServers":{"other":{"command":"other"}},"general":{"plan":{"enabled":false}}}');
    prepareGeminiSettings(root, { agent: "gemini-2", project: "demo", task: "T-1", id: "R-test", readOnly: true }, [], []);
    const j = JSON.parse(readFileSync(path.join(root, ".gemini/settings.json"), "utf8"));
    assert.deepEqual(Object.keys(j.mcpServers), ["xdev-hive"]);
    assert.equal(j.mcpServers["xdev-hive"].env.HIVE_AGENT, "gemini-2");
    assert.equal(j.mcpServers["xdev-hive"].env.HIVE_RUN, "R-test");
    assert.equal(j.mcpServers["xdev-hive"].env.HIVE_READONLY, "1");
    assert.ok(j.general.plan.enabled); assert.ok(j.context.fileName.includes("AGENTS.md")); assert.ok(j.context.fileName.includes("GEMINI.md"));
    writeFileSync(path.join(root, ".gemini/settings.json"), "invalid");
    assert.throws(() => prepareGeminiSettings(root, { agent: "a", project: "demo", task: "T", id: "R", readOnly: false }, [], null), /Cannot read Gemini settings/);
    assert.equal(readFileSync(path.join(root, ".gemini/settings.json"), "utf8"), "invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("advertises native model aliases only after a version probe, never inference", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-gemini-models-"));
  try {
    const bin = path.join(root, "gemini");
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = --version ] || exit 1\necho 0.63.0\n', { mode: 0o755 });
    const models = new ProfileModels(), p = { ...AGENT_TEMPLATES.gemini, bin };
    assert.equal(models.snapshot(p, {}), null);
    await models.refresh(p, {}); assert.deepEqual(models.snapshot(p, {}), GEMINI_MODELS);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


it("runs Windows npm Gemini through its official JS entry, keeping shell syntax inert", () => {
  const bin = "C:\\Users\\test\\npm\\gemini.cmd";
  const args = ["--model", "flash", "--prompt", "", "--output-format", "stream-json", "--policy", "a&b%PATH%.toml"];
  const launch = geminiLaunch(bin, args, { PATH: "fixture" }, "win32", (p) => p.endsWith("node_modules\\@google\\gemini-cli\\bundle\\gemini.js"));
  assert.equal(launch.bin, process.execPath);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(launch.args.slice(1), args);
  assert.ok(launch.args[0]!.endsWith("gemini.js"));
  assert.throws(() => geminiLaunch(bin, args, {}, "win32", () => false), /reinstall/);
  assert.deepEqual(geminiLaunch("gemini", args, {}, "linux"), { bin: "gemini", args, env: {} });
});


it("adds Gemini tiers to an older persisted router without changing its existing choices", async () => {
  const hive = new SqliteHive(":memory:");
  try {
    const tiers = JSON.parse(JSON.stringify(DEFAULT_MODEL_ROUTER.tiers));
    for (const row of Object.values(tiers) as Array<Record<string, unknown>>) delete row.gemini;
    tiers.light.claude = { model: "user-pin", effort: null };
    hive.db.prepare("INSERT INTO settings(key,value) VALUES ('modelRouter',?)").run(JSON.stringify({ ...DEFAULT_MODEL_ROUTER, tiers }));
    const settings = await hive.call("modelRouter.get", {}, { name: "test", role: "admin" });
    assert.equal(settings.tiers.light.claude?.model, "user-pin");
    assert.equal(settings.tiers.light.gemini?.model, "flash");
    assert.equal(settings.tiers.strong.gemini?.model, "pro");
  } finally { hive.close(); }
});

it("mounts only the selected Gemini account in a container", () => {
  const profile = { ...AGENT_TEMPLATES.gemini, env: { GEMINI_CLI_HOME: "/accounts/gemini-2" }, container: { image: "hive:fake", network: "open" as const, allow: [] } };
  const box = containerCommand({ profile, args: [], stdin: "prompt", runId: "R-test", worktree: "/work", gitDir: "/git", home: "/home/fixture", env: profile.env, user: null, exists: () => true });
  assert.ok(box.args.includes("/accounts/gemini-2/.gemini:/accounts/gemini-2/.gemini"));
  assert.ok(!box.args.some((a) => a.startsWith("/home/fixture/.gemini:")));
  assert.equal(box.env.GEMINI_CLI_HOME, "/accounts/gemini-2");
});
