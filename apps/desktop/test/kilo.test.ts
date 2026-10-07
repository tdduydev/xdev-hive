import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { AGENT_TEMPLATES, agentProfileSchema, autonomyOf, DEFAULT_MODEL_ROUTER, OPEN_POLICY, selectModel, toolProblem } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { applyPolicy, buildCommand, routeProfile } from "#desktop/main/runner/command.ts";
import { checkUsage, loginParts } from "#desktop/main/runner/login.ts";
import { kiloAccountEnv, kiloLogin, kiloPaths, kiloPermission, KiloStream } from "#desktop/main/runner/kilo.ts";
import { kiloModels, ProfileModels } from "#desktop/main/runner/models.ts";
import { containerCommand } from "#desktop/main/runner/container.ts";
import { hubMcpEnv } from "#desktop/main/runner/container-mcp.ts";
import { cliCommand } from "#desktop/main/cli-open.ts";

const vars = { prompt: "--a multiline\nprompt", worktree: "/repo/wt", task: "T-1", project: "demo", branch: "ai/T-1", run: "R-1", kiloConfigRoot: "/runner/runs/R-1/config" };

it("builds native Kilo run with positional prompt, isolated config, free small model and Hive identity", () => {
  const p = agentProfileSchema.parse(AGENT_TEMPLATES.kilo);
  const c = buildCommand(p, vars);
  assert.equal(c.kiloStream, true);
  assert.equal(c.stdin, null);
  assert.equal(c.args[0], "run");
  assert.deepEqual(c.args.slice(-2), ["--", vars.prompt]);
  assert.ok(c.args.includes("kilo/kilo-auto/free"));
  const cfg = JSON.parse(c.env!.KILO_CONFIG_CONTENT!);
  assert.equal(cfg.small_model, "kilo/kilo-auto/free");
  assert.equal(cfg.share, "disabled");
  assert.equal(cfg.mcp["xdev-hive"].type, "local");
  assert.equal(cfg.mcp["xdev-hive"].environment.HIVE_AGENT, p.id);
  assert.equal(cfg.mcp["xdev-hive"].environment.HIVE_TASK, "T-1");
  assert.equal(cfg.mcp["xdev-hive"].environment.HIVE_RUN, "R-1");
  assert.equal(c.env!.XDG_CONFIG_HOME, vars.kiloConfigRoot);
  assert.equal(c.env!.KILO_TEST_HOME, vars.kiloConfigRoot);
  assert.equal(c.env!.KILO_DISABLE_EXTERNAL_SKILLS, "1");
  assert.equal(c.env!.KILO_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(c.env!.KILO_CONFIG, "");
  assert.equal(c.env!.KILO_CONFIG_DIR, "");
  assert.equal(JSON.parse(c.env!.KILO_PERMISSION!).external_directory, "deny");
  for (const flag of ["--attach=http://server", "--command", "--interactive", "--share"]) {
    assert.throws(() => buildCommand({ ...p, args: ["run", flag, "{prompt}"] }, vars), /bypass/);
  }
  assert.equal(buildCommand({ ...p, args: ["run"] }, vars).stdin, vars.prompt);
  const separated = buildCommand({ ...p, args: ["run", "--", "{prompt}"] }, vars);
  assert.equal(separated.args.filter((a) => a === "--").length, 1);
  assert.ok(separated.args.indexOf("--format") < separated.args.indexOf("--"));
  assert.deepEqual(separated.args.slice(-2), ["--", vars.prompt]);
});

it("lowers Kilo policy to read/propose/edit, preserves native denies under --auto, filters MCP", async () => {
  const p = { ...AGENT_TEMPLATES.kilo, args: ["run", "--auto", "{prompt}"] };
  const hive = new SqliteHive(":memory:");
  try {
    const tools = await hive.call("tools.list", {}, { name: "test", role: "admin" });
    const codegraph = { ...tools.find((t) => t.id === "codegraph")!, agents: ["kilo" as const] };
    for (const level of ["read", "propose", "edit", "full"] as const) {
      const fit = applyPolicy(p, { ...OPEN_POLICY, autonomy: level, mcp: [] });
      const c = buildCommand(fit.profile, vars, [codegraph], undefined, fit.mcp);
      const perm = JSON.parse(c.env!.KILO_PERMISSION!);
      assert.equal(c.args.includes("--auto"), level === "full");
      assert.equal(perm.edit, level === "read" || level === "propose" ? "deny" : "allow");
      assert.equal(perm.bash, level === "full" ? "allow" : level === "edit" ? "ask" : "deny");
      assert.equal(perm.external_directory, "deny");
      assert.equal(perm["xdev-hive_*"], "allow");
      assert.deepEqual(Object.keys(JSON.parse(c.env!.KILO_CONFIG_CONTENT!).mcp), ["xdev-hive"]);
    }
    assert.equal(autonomyOf("kilo", p.args), "full");
    const booleanFlag = { ...p, args: ["run", "--auto=true", "{prompt}"] };
    assert.equal(autonomyOf("kilo", booleanFlag.args), "full");
    assert.equal(autonomyOf("kilo", ["run", "--auto", "--auto=false"]), "edit");
    const narrowed = buildCommand(applyPolicy(booleanFlag, { ...OPEN_POLICY, autonomy: "read" }).profile, vars);
    assert.ok(!narrowed.args.includes("--auto") && !narrowed.args.includes("--auto=true"));
    assert.equal(JSON.parse(narrowed.env!.KILO_PERMISSION!).edit, "deny");
    assert.equal(autonomyOf("kilo", AGENT_TEMPLATES.kilo.args), "edit");
    assert.equal(kiloPermission("read", [])["*"], "deny");
    assert.equal(JSON.parse(buildCommand({ ...p, readOnly: true }, vars).env!.KILO_CONFIG_CONTENT!).mcp["xdev-hive"].environment.HIVE_READONLY, "1");
  } finally { hive.close(); }
});

it("reads completed Kilo parts across chunks, deduplicates usage, retains unknown diagnostics and session errors", () => {
  const stream = new KiloStream();
  const finish = { type: "step_finish", sessionID: "s1", part: { id: "p1", reason: "tool-calls", cost: 0.02, tokens: { input: 10, output: 3, cache: { read: 4, write: 2 } } } };
  const events = [
    { type: "step_start", sessionID: "s1", part: { id: "start" } },
    { type: "tool_use", part: { id: "tool", tool: "xdev-hive_skill_get", state: { status: "completed", input: { name: "review-pr" }, title: "Read review skill" } } },
    finish, finish,
    { type: "step_finish", part: { id: "p2", cost: 0.01, tokens: { input: 5, output: 8, cache: { read: 0, write: 0 } } } },
    { type: "text", part: { id: "text", text: "Đã làm xong" } },
    { type: "new_event", detail: "keep me" },
    { type: "error", error: { name: "APIError", data: { message: "429 rate limit exceeded" } } },
  ].map((e) => JSON.stringify(e)).join("\n");
  let log = stream.push("warning on stdout\n");
  for (let i = 0; i < events.length; i += 11) log += stream.push(events.slice(i, i + 11));
  log += stream.end();
  assert.equal(stream.sessionId, "s1");
  assert.equal(stream.lastText, "Đã làm xong");
  assert.equal(stream.error, "429 rate limit exceeded");
  assert.deepEqual(stream.usage, { text: "Đã làm xong", costUsd: 0.03, inputTokens: 15, outputTokens: 11, cacheReadTokens: 4, cacheWriteTokens: 2 });
  assert.ok(stream.skills.has("review-pr"));
  assert.match(log, /warning on stdout/);
  assert.match(log, /new_event/);
  assert.match(log, /429 rate limit/);
  const unknown = new KiloStream();
  unknown.push('{"type":"step_finish","part":{"tokens":{"input":-1,"output":"5"}}}\n');
  assert.equal(unknown.usage.inputTokens, null);
  assert.equal(unknown.usage.outputTokens, null);
});

it("isolates XDG credentials and login command without disclosing credential values or inventing quota", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-kilo-login-"));
  try {
    const env1 = kiloAccountEnv(path.join(root, "a")), env2 = kiloAccountEnv(path.join(root, "b"));
    const data = kiloPaths(env1)[1]!;
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, "auth.json"), JSON.stringify({ kilo: { type: "api", key: "fake-test-credential" } }));
    const p = { ...AGENT_TEMPLATES.kilo, env: { ...env1, KILO_API_KEY: "must-not-be-in-script" } };
    assert.equal(kiloLogin(env1).loggedIn, true);
    assert.equal(kiloLogin(env2).loggedIn, null);
    assert.deepEqual(loginParts(p), { args: ["auth", "login"], env: env1 });
    assert.doesNotMatch(JSON.stringify(kiloLogin(env1)), /fake-test-credential/);
    assert.equal(await checkUsage(p, {}, new Date(), async () => { throw new Error("must not invoke inference or stats as quota"); }), null);
    writeFileSync(path.join(data, "auth.json"), "broken");
    assert.equal(kiloLogin(env1).loggedIn, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("discovers provider/model ids, routes all default tiers to free pool, refuses unavailable model and respects pins", async () => {
  assert.deepEqual(kiloModels("INFO startup\nkilo/kilo-auto/free\nkilo/model-paid\n"), ["kilo/kilo-auto/free", "kilo/model-paid"]);
  assert.equal(kiloModels("Error fetching models"), null);
  const selection = selectModel(DEFAULT_MODEL_ROUTER, "demo", { kind: "feature", size: "l", risk: "high", role: "implement" })!;
  assert.equal(selection.models.kilo!.model, "kilo/kilo-auto/free");
  const p = AGENT_TEMPLATES.kilo;
  const routed = routeProfile(p, p, OPEN_POLICY, selection, null);
  assert.ok(routed.profile.args.includes("kilo/kilo-auto/free"));
  assert.throws(() => routeProfile(p, p, OPEN_POLICY, selection, ["kilo/model-paid"]), /unavailable/);
  assert.equal(routeProfile({ ...p, args: ["run", "-m", "kilo/my-pin"] }, p, OPEN_POLICY, selection, []).note!.includes("pinned"), true);
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-kilo-models-"));
  try {
    const bin = path.join(dir, "kilo");
    writeFileSync(bin, '#!/bin/sh\n[ "$1 $2" = "models kilo" ] || exit 1\nprintf "%s\\n" "kilo/kilo-auto/free"\n', { mode: 0o755 });
    const models = new ProfileModels(), profile = { ...p, bin };
    await models.refresh(profile, {});
    assert.deepEqual(models.snapshot(profile, {}), ["kilo/kilo-auto/free"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("ships a valid pinned Kilo catalog entry and container/interactive MCP wiring", async () => {
  const hive = new SqliteHive(":memory:");
  try {
    const tools = await hive.call("tools.list", {}, { name: "test", role: "admin" });
    const kilo = tools.find((e) => e.id === "kilo-cli")!;
    assert.equal(kilo.package!.version, "7.8.3");
    assert.equal(toolProblem(kilo, false), null);
    const interactive = cliCommand(AGENT_TEMPLATES.kilo, { ...vars, repo: "/repo", bin: "kilo", path: "/bin", shim: "/bin/hive-mcp", mcpFile: "/mcp.json", title: "Kilo", done: "done" });
    assert.equal(JSON.parse(interactive.command.env!.KILO_CONFIG_CONTENT!).mcp["xdev-hive"].environment.HIVE_AGENT, "kilo-1");
    const c = buildCommand(AGENT_TEMPLATES.kilo, { ...vars, kiloMcp: { "xdev-hive": { type: "http", url: "https://hub/mcp", headers: { authorization: "Bearer {env:HIVE_HUB_TOKEN}" } } } });
    assert.equal(JSON.parse(c.env!.KILO_CONFIG_CONTENT!).mcp["xdev-hive"].type, "remote");
    const box = containerCommand({ profile: { ...AGENT_TEMPLATES.kilo, container: { image: "hive-agent", network: "open", allow: [] } }, args: c.args, stdin: null, runId: "R-1", worktree: "/repo", gitDir: "/repo/.git", env: { ...kiloAccountEnv("/accounts/kilo"), ...c.env }, home: "/home/test", exists: () => true });
    assert.ok(box.args.includes("/accounts/kilo/data/kilo:/accounts/kilo/data/kilo"));
    assert.ok(box.args.includes("/runner/runs/R-1/config/kilo:/runner/runs/R-1/config/kilo"));
    assert.ok(box.args.includes("kilo"));
    assert.equal(hubMcpEnv({ url: "https://hub", token: "fake" }, { agent: "a", project: "demo", task: "T-1", run: "R-1", machine: "test", readOnly: false }, "kilo").HIVE_HUB_TOKEN, "fake");
  } finally { hive.close(); }
});
