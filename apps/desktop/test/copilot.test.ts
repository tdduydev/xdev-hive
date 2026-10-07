import assert from "node:assert/strict";
import { it } from "node:test";
import { AGENT_TEMPLATES, OPEN_POLICY, type ModelSelection } from "@xdev-hive/core";
import { applyPolicy, buildCommand, routeProfile, withoutModel } from "#desktop/main/runner/command.ts";
import { checkLogin, loginParts } from "#desktop/main/runner/login.ts";
import { ProfileModels } from "#desktop/main/runner/models.ts";
import { CopilotStream } from "#desktop/main/runner/stream.ts";

const vars = { prompt: "Fix the test", worktree: "/tmp/copilot-wt", task: "T-1", project: "demo", branch: "ai/T-1", run: "R-1" };

it("builds a headless Copilot command with the per-run Hive MCP and no credential values", () => {
  const cmd = buildCommand(AGENT_TEMPLATES.copilot, vars);
  assert.equal(cmd.copilotJson, true);
  assert.deepEqual(cmd.args.slice(0, 4), ["-p", vars.prompt, "--no-ask-user", "--no-auto-update"]);
  const at = cmd.args.indexOf("--additional-mcp-config");
  const config = JSON.parse(cmd.args[at + 1]!) as { mcpServers: Record<string, { command: string; env: Record<string, string>; tools: string[] }> };
  assert.deepEqual(Object.keys(config.mcpServers), ["xdev-hive"]);
  assert.deepEqual(config.mcpServers["xdev-hive"]!.tools, ["*"]);
  assert.deepEqual([config.mcpServers["xdev-hive"]!.env.HIVE_AGENT, config.mcpServers["xdev-hive"]!.env.HIVE_TASK, config.mcpServers["xdev-hive"]!.env.HIVE_RUN], ["copilot-1", "T-1", "R-1"]);
});

it("restricts a read-only Copilot policy and keeps Free routing on Auto", () => {
  const read = applyPolicy(AGENT_TEMPLATES.copilot, { ...OPEN_POLICY, autonomy: "read", mcp: [] });
  assert.equal(read.profile.readOnly, true);
  assert.ok(read.profile.args.includes("--deny-tool=write"));
  assert.ok(read.profile.args.includes("--available-tools=view,glob,grep,rg,skill,xdev-hive"));
  const selection: ModelSelection = { tier: "strong", reason: "feature/l", models: { copilot: { model: "auto", effort: null } } };
  const models = new ProfileModels().snapshot(AGENT_TEMPLATES.copilot, {});
  assert.deepEqual(models, ["auto"]);
  assert.ok(routeProfile(AGENT_TEMPLATES.copilot, AGENT_TEMPLATES.copilot, OPEN_POLICY, selection, models).profile.args.includes("auto"));
  assert.deepEqual(withoutModel({ ...AGENT_TEMPLATES.copilot, args: [...AGENT_TEMPLATES.copilot.args, "--model", "paid-model", "--reasoning-effort", "high"] }).args, AGENT_TEMPLATES.copilot.args);
});

it("offers Copilot browser and device login without claiming a status check", async () => {
  assert.deepEqual(loginParts(AGENT_TEMPLATES.copilot), { args: ["login", "--web-flow"], env: {} });
  assert.deepEqual(loginParts(AGENT_TEMPLATES.copilot, { device: true }), { args: ["login", "--device-code"], env: {} });
  const status = await checkLogin({ ...AGENT_TEMPLATES.copilot, bin: process.execPath }, { PATH: "" }, new Date("2026-10-07T00:00:00Z"), async () => { throw new Error("status command must not run"); });
  assert.equal(status.loggedIn, null);
});

it("reads Copilot JSONL messages, usage and in-stream errors across chunks", () => {
  const stream = new CopilotStream();
  assert.equal(stream.push('{"type":"assistant.message","sessionId":"s1","data":{"content":"Done"'), "");
  assert.equal(stream.push('}}\n{"type":"assistant.usage","data":{"inputTokens":20,"cacheReadTokens":4,"outputTokens":6}}\n'), "Done\n");
  assert.match(stream.push('{"type":"session.error","data":{"message":"quota exceeded"}}\n'), /quota exceeded/);
  assert.deepEqual([stream.lastText, stream.sessionId, stream.failure, stream.tokens.input, stream.tokens.output], ["Done", "s1", "quota exceeded", 20, 6]);
});
