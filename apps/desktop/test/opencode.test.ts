import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { AGENT_TEMPLATES, DEFAULT_MODEL_ROUTER, OPEN_POLICY, agentProfileSchema, modelTableSchema, selectModel } from "@xdev-hive/core";
import { applyPolicy, buildCommand, policyBlocks, routeProfile } from "#desktop/main/runner/command.ts";
import { checkLogin, checkUsage, loginParts } from "#desktop/main/runner/login.ts";
import { ProfileModels, opencodeModels } from "#desktop/main/runner/models.ts";
import { opencodeEnv, opencodeJson } from "#desktop/main/runner/opencode.ts";
import { OpenCodeStream } from "#desktop/main/runner/stream.ts";
import { containerCommand } from "#desktop/main/runner/container.ts";
import { hubMcpEnv } from "#desktop/main/runner/container-mcp.ts";
import { AGENT_CLIS, cliUpgrade } from "#desktop/main/setup.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "hive-opencode-"));
after(() => rmSync(home, { recursive: true, force: true }));
const base = { ...AGENT_TEMPLATES.opencode, enabled: true, opencode: { model: "test/model" } };
const profile = { ...base, env: opencodeEnv(base, home) };
const vars = { prompt: "-prompt with quotes\ntext", worktree: "/worktree", task: "T-1", project: "demo", branch: "ai/T-1", run: "R-1", hiveMcp: "/bin/hive-mcp", opencodeConfigDir: path.join(home, "run-config") };
const cfg = (cmd: ReturnType<typeof buildCommand>) => JSON.parse(cmd.env!.OPENCODE_CONFIG_CONTENT!);

it("isolates all four XDG homes for two profiles, including login scripts", async () => {
  const second = { ...base, id: "opencode-2" };
  const a = loginParts(profile)!;
  const b = loginParts({ ...second, env: opencodeEnv(second, home) })!;
  assert.deepEqual(a.args, ["auth", "login"]);
  for (const key of Object.keys(a.env)) assert.notEqual(a.env[key], b.env[key]);
  assert.equal(Object.keys(a.env).length, 4);
  const authDir = path.join(a.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(path.join(authDir, "auth.json"), '{"test":{"type":"api","key":"fake-key-never-returned"}}');
  const login = await checkLogin(profile, {}, new Date());
  assert.equal(login.loggedIn, null);
  assert.equal(login.method, "test · api");
  assert.equal((await checkLogin({ ...second, env: opencodeEnv(second, home) }, {}, new Date())).method, null);
  assert.ok(!JSON.stringify(login).includes("fake-key"));
  assert.equal(await checkUsage(profile, {}, new Date(), async () => { throw new Error("Must not run a model for quota"); }), null);
});

it("uses explicit models, a safe auxiliary model and native positional ordering", () => {
  const cmd = buildCommand(profile, vars);
  assert.equal(cmd.opencodeStream, true);
  assert.deepEqual(cmd.args.slice(-2), ["--", vars.prompt]);
  assert.equal(cfg(cmd).model, "test/model");
  assert.equal(cfg(cmd).small_model, "test/model");
  assert.equal(cfg(cmd).share, "disabled");
  assert.ok(buildCommand({ ...profile, args: ["run", "--session", "ses_1", "{prompt}"] }, vars).args.includes("ses_1"));
  assert.equal(cmd.env!.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.deepEqual(cfg(cmd).mcp["xdev-hive"].command, ["/bin/hive-mcp"]);
  assert.equal(cfg(cmd).mcp["xdev-hive"].environment.HIVE_AGENT, profile.id);
  assert.throws(() => buildCommand({ ...profile, opencode: undefined }, vars), /OpenCode/);
  assert.throws(() => buildCommand({ ...profile, args: ["run", "--attach", "http://remote", "{prompt}"] }, vars), /--attach/);
  assert.equal(agentProfileSchema.safeParse({ ...profile, opencode: { model: "missing-provider" } }).success, false);
});

it("narrows edit/full/read permissions, Hive identity, models and MCP", () => {
  const p = { ...profile, args: ["run", "--auto", "{prompt}"], opencode: { model: "test/model", smallModel: "other/paid" }, env: { ...profile.env, OPENCODE_PERMISSION: '{"bash":"allow"}', OPENCODE_CONFIG_CONTENT: '{"mcp":{"untrusted":{"type":"local","command":["bad"]},"allowed":{"type":"local","command":["good"]}}}' } };
  assert.ok(policyBlocks(p, { ...OPEN_POLICY, models: { opencode: ["test/model"] } }));
  const policy = { ...OPEN_POLICY, autonomy: "read" as const, mcp: ["allowed"] };
  const fitted = applyPolicy(p, policy);
  const cmd = buildCommand(fitted.profile, vars, [], undefined, fitted.mcp);
  const c = cfg(cmd);
  assert.equal(c.permission.edit, "deny");
  assert.equal(c.permission.bash, "deny");
  assert.equal(c.permission.task, "deny");
  assert.equal(c.mcp.untrusted.enabled, false);
  assert.equal(c.mcp.allowed.command[0], "good");
  assert.equal(c.mcp["xdev-hive"].environment.HIVE_READONLY, "1");
  assert.ok(!cmd.args.includes("--auto"));
  assert.equal(JSON.parse(cmd.env!.OPENCODE_PERMISSION!).bash, "deny");
  assert.equal(cfg(buildCommand(p, vars)).permission.bash, "allow");
});

it("routes qualified IDs only after explicit hub choices, keeps pins and refuses unknown fallback", () => {
  const router = structuredClone(DEFAULT_MODEL_ROUTER);
  assert.equal(selectModel(router, "demo", { kind: "feature", size: "m", risk: "normal", role: "implement" })!.models.opencode, null);
  router.tiers.standard.opencode = { model: "test/model", effort: null };
  assert.ok(modelTableSchema.safeParse(router.tiers).success);
  const selection = selectModel(router, "demo", { kind: "feature", size: "m", risk: "normal", role: "implement" })!;
  const noPin = { ...profile, opencode: undefined };
  const routed = routeProfile(noPin, noPin, OPEN_POLICY, selection, ["test/model"]);
  assert.ok(routed.profile.args.includes("test/model"));
  assert.ok(!routed.profile.args.includes("--effort"));
  assert.match(routeProfile(profile, profile, OPEN_POLICY, selection, []).note!, /pinned/);
  assert.throws(() => routeProfile(noPin, noPin, OPEN_POLICY, selection, ["other/paid"]), /fallback is disabled/);
});

it("probes the profile-specific model catalog with a fake executable", async () => {
  assert.deepEqual(opencodeModels("Heading\ntest/model\ntest/model\nother/model/sub\nError: no login"), ["test/model", "other/model/sub"]);
  const bin = path.join(home, "opencode");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s/model\\n" "$(basename "$(dirname "$XDG_DATA_HOME")")"\n');
  chmodSync(bin, 0o755);
  const models = new ProfileModels();
  const a = { ...base, bin }, b = { ...base, bin, id: "opencode-2" };
  await models.refresh(a, { HOME: home }); await models.refresh(b, { HOME: home });
  assert.deepEqual(models.snapshot(a, { HOME: home }), ["opencode-1/model"]);
  assert.deepEqual(models.snapshot(b, { HOME: home }), ["opencode-2/model"]);
});

it("parses native chunks, deduplicates steps, retains unknown lines and sticky error state", () => {
  const stream = new OpenCodeStream();
  const step = JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { id: "p1", cost: 0.01, tokens: { input: 3, output: 5, cache: { read: 8, write: 2 } } } });
  const text = JSON.stringify({ type: "text", sessionID: "ses_1", part: { id: "text", text: "Done" } });
  stream.push(step.slice(0, 20)); stream.push(step.slice(20) + "\n" + step + "\n" + text + "\n");
  assert.equal(stream.sessionId, "ses_1");
  assert.deepEqual(stream.usage(), { text: "Done", costUsd: 0.01, inputTokens: 3, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2 });
  assert.match(stream.push('{"type":"new-event"}\nwarning\n'), /new-event.*\nwarning/);
  stream.push('{"type":"error","error":{"data":{"message":"Too Many Requests","statusCode":429}}}');
  assert.match(stream.end(), /429/);
  stream.push(text + "\n");
  assert.match(stream.failure!, /429/);
  const unknown = new OpenCodeStream(); unknown.push('{"type":"step_finish","part":{"tokens":{"input":-1,"output":"10"}}}\n');
  assert.equal(unknown.usage().inputTokens, null);
  assert.equal(unknown.usage().outputTokens, null);
});

it("parses provider JSONC without corrupting URLs, strings or trailing commas", () => {
  assert.deepEqual(opencodeJson('{/* comment */ "provider":{"local":{"options":{"baseURL":"http://host/x//y",},},}, // line\n "x":",}",}'), { provider: { local: { options: { baseURL: "http://host/x//y" } } }, x: ",}" });
});

it("mounts isolated login dirs in containers and sends remote Hive tokens by environment", () => {
  const p = { ...profile, container: { image: "hive-agent", network: "open" as const, allow: [] } };
  const command = containerCommand({ profile: p, args: [], stdin: null, runId: "R-1", worktree: "/wt", gitDir: "/git", env: {}, exists: () => true, home, user: null });
  for (const dir of Object.values(opencodeEnv(p))) assert.ok(command.args.includes(`${dir}:${dir}`));
  const mcp = hubMcpEnv({ url: "https://hub", token: "fake-token" }, { agent: p.id, project: "demo", machine: "test", task: "T-1", run: "R-1", readOnly: true }, "opencode", JSON.stringify(cfg(buildCommand(profile, vars))));
  const remote = JSON.parse(mcp.OPENCODE_CONFIG_CONTENT!).mcp["xdev-hive"];
  assert.equal(remote.type, "remote");
  assert.equal(remote.headers.authorization, "Bearer {env:HIVE_HUB_TOKEN}");
  assert.equal(remote.headers["x-hive-readonly"], "1");
  assert.equal(mcp.HIVE_HUB_TOKEN, "fake-token");
  const cli = AGENT_CLIS.find((cli) => cli.kind === "opencode")!;
  assert.equal(cli.pkg, "opencode-ai");
  assert.deepEqual(cliUpgrade(cli, "/home/person/.opencode/bin/opencode", "/bin/opencode")?.args, ["upgrade"]);
});
