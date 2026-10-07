import assert from "node:assert/strict";
import { chmodSync, statSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { OPEN_POLICY, packageSpec, toolHash, type Actor, type MachineTools, type ToolEntry } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { CODEGRAPH_MCP, CODEGRAPH_PACKAGE, NO_FEATURES, SUPERPOWERS_PLUGIN } from "#desktop/main/installer.ts";
import { claudeRunArgs, codexArgs, type ClaudeHookRun } from "#desktop/main/runner/command.ts";
import {
  APP_TOOLS,
  claudeToolServer,
  readyBrowserSecrets,
  claudeHooks,
  codexToolArgs,
  hookEnv,
  legacyPick,
  prepareTool,
  readyHooks,
  rtkGain,
  runTools,
  shellQuote,
  toolDirs,
  toolViews,
  trustOf,
  userClaudeSettings,
} from "#desktop/main/runner/tools.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };

const rtk = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  id: "rtk",
  name: "RTK",
  description: "",
  kind: "mcp",
  package: { registry: "npm", name: "rtk-mcp", version: "0.4.1" },
  mcp: { command: "npx", args: ["-y", "{package}", "--root", "{repo}"] },
  plugin: null,
  hooks: [],
  agents: ["claude", "codex"],
  check: null,
  install: null,
  prepare: null,
  env: { RTK_TELEMETRY: "0" },
  secretEnv: [],
  license: "MIT",
  homepage: null,
  handler: null,
  enabledByDefault: false,
  ...over,
});

const catalog = (entries: ToolEntry[], settings: MachineTools["projects"][string] = []): MachineTools => ({ entries, projects: { demo: settings } });
const on = (id: string, enabled: boolean | null = true) => ({ id, enabled, effective: enabled ?? false, required: false });

describe("the app's own tools (roadmap 28b)", () => {
  it("are the hub's seeds, command for command: machines running them before the catalog need not allow them", async () => {
    const seeds = await new SqliteHive(":memory:").call("tools.list", {}, admin);
    for (const seed of seeds.filter((s) => s.builtin)) {
      assert.equal(toolHash(seed), toolHash(APP_TOOLS[seed.handler!]), seed.id);
      assert.equal(trustOf(seed, {}), "app");
    }
    assert.equal(packageSpec(APP_TOOLS.codegraph.package!), CODEGRAPH_PACKAGE);
    assert.deepEqual(APP_TOOLS.codegraph.env, CODEGRAPH_MCP.env);
    assert.equal(APP_TOOLS.superpowers.plugin, SUPERPOWERS_PLUGIN);
  });

  it("pins the browser seed and gives both CLIs separate run paths and secret names", async () => {
    const entry = APP_TOOLS.browser;
    assert.equal(toolHash(entry), "18c77f067b491cc41c5c37465a2f3f157c05abdf283164e51692d717746dc62b");
    assert.equal(entry.enabledByDefault, false);
    assert.deepEqual(entry.agents, ["claude", "codex"]);
    const browser = { ...entry, secretEnv: ["TEST_PASSWORD"] };
    const runDir = testTmpDir(path.join(os.tmpdir(), "hive-browser-"));
    const password = "test-only\n\"quoted\"\\value";
    readyBrowserSecrets(browser, runDir, { TEST_PASSWORD: password });
    assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, "browser.json"), "utf8")), { secrets: { TEST_PASSWORD: password } });
    if (process.platform !== "win32") assert.equal(statSync(path.join(runDir, "browser.json")).mode & 0o777, 0o600);
    for (const kind of ["claude", "codex"] as const) {
      const c = catalog([browser], [on("browser")]);
      assert.equal(runTools(c, "demo", NO_FEATURES, kind, OPEN_POLICY, { browser: toolHash(browser) }, { TEST_PASSWORD: password }).tools.length, 1);
    }
    const server = claudeToolServer(browser, { runDir });
    assert.match(JSON.stringify(server), /browser-profile/);
    assert.doesNotMatch(JSON.stringify(server), /\{runDir\}/);
    assert.equal((server.env as Record<string, string>).TEST_PASSWORD, "${TEST_PASSWORD}");
    const args = codexToolArgs([browser], { runDir });
    assert.ok(args.includes('mcp_servers.browser.env_vars=["TEST_PASSWORD"]'));
    assert.ok(!args.join(" ").includes(password));
    assert.ok(!JSON.stringify(server).includes(password));
    assert.notDeepEqual(claudeToolServer(browser, { runDir: "/run-a" }), claudeToolServer(browser, { runDir: "/run-b" }));
  });

  it("asks again when a seed's commands change, and for any other entry until allowed as it is", () => {
    const bumped = { ...APP_TOOLS.codegraph, package: { ...APP_TOOLS.codegraph.package!, version: "1.6.1" } };
    assert.equal(trustOf(bumped, {}), "new");
    assert.equal(trustOf(bumped, { codegraph: toolHash(APP_TOOLS.codegraph) }), "changed");
    assert.equal(trustOf(bumped, { codegraph: toolHash(bumped) }), "trusted");
    assert.equal(trustOf({ ...rtk(), handler: "codegraph" }, {}), "new", "a handler alone is not the app's commands");
  });
});

describe("runTools", () => {
  const pick = (c: MachineTools, over: { kind?: "claude" | "codex" | "gemini"; mcp?: string[] | null; trust?: Record<string, string>; env?: Record<string, string>; features?: typeof NO_FEATURES } = {}) =>
    runTools(c, "demo", over.features ?? NO_FEATURES, over.kind ?? "claude", { ...OPEN_POLICY, mcp: over.mcp ?? null }, over.trust ?? {}, over.env ?? {});

  it("takes what the project turned on, for the profile's CLI", () => {
    const entry = rtk();
    const trust = { rtk: toolHash(entry) };
    assert.deepEqual(pick(catalog([entry], [on("rtk")]), { trust }).tools.map((e) => e.id), ["rtk"]);
    assert.deepEqual(pick(catalog([entry], [on("rtk", false)]), { trust }).tools, []);
    assert.deepEqual(pick(catalog([entry], [on("rtk", null)]), { trust }).tools, [], "null follows the default: off");
    assert.deepEqual(pick(catalog([{ ...entry, enabledByDefault: true }], []), { trust }).tools.map((e) => e.id), ["rtk"], "a project the hub sent no line for follows the default");
    assert.deepEqual(pick(catalog([{ ...entry, agents: ["claude"] }], [on("rtk")]), { trust, kind: "codex" }).tools, [], "not for this CLI");
    assert.deepEqual(pick(catalog([entry], [on("rtk")]), { trust, mcp: ["codegraph"] }).tools, [], "the policy leaves it out");
    assert.deepEqual(pick(catalog([entry], [on("rtk")]), { trust, mcp: ["rtk"] }).tools.map((e) => e.id), ["rtk"]);
  });

  it("counts a seed the repo turned on the old way, unless the project chose", () => {
    const c = (enabled: boolean | null) => catalog([APP_TOOLS.codegraph, APP_TOOLS.superpowers], [on("codegraph", enabled), on("superpowers", enabled)]);
    const features = { codegraph: true, superpowers: true };
    assert.deepEqual(pick(c(null), { features }).tools.map((e) => e.id), ["codegraph", "superpowers"]);
    assert.deepEqual(pick(c(false), { features }).tools, []);
    assert.deepEqual(pick(c(null)).tools, [], "nothing in the repo either");
  });

  it("logs what waits for the user or a variable, by name only", () => {
    const entry = rtk({ secretEnv: ["RTK_API_KEY"] });
    const c = catalog([entry], [on("rtk")]);
    assert.deepEqual(pick(c).notes, ["tool rtk: chờ người dùng máy cho phép (Cài đặt máy)"]);
    const trust = { rtk: toolHash(entry) };
    const missing = pick(c, { trust, env: { RTK_API_KEY: "" } });
    assert.deepEqual([missing.tools, missing.notes], [[], ["tool rtk: thiếu RTK_API_KEY"]]);
    assert.deepEqual(pick(c, { trust, env: { RTK_API_KEY: "k-123" } }).tools.map((e) => e.id), ["rtk"]);
  });

  it("prepares a tool for every CLI, starts it only for its own; hooks and plain CLIs change nothing yet", () => {
    const c = catalog(
      [APP_TOOLS.codegraph, APP_TOOLS.speckit, rtk({ id: "hooked", kind: "hook", mcp: null, hooks: [{ event: "Stop", matcher: "", command: ["rtk"] }] })],
      [on("codegraph"), on("speckit"), on("hooked")],
    );
    const codex = pick(c, { kind: "codex" });
    assert.deepEqual([codex.tools, codex.prepare.map((e) => e.id), codex.notes], [[], ["codegraph"], []]);
  });

  it("without a catalog: Claude gets the repo's tools, every CLI the index", () => {
    const features = { codegraph: true, superpowers: true };
    assert.deepEqual(legacyPick(features, "claude", null).tools.map((e) => e.id), ["codegraph", "superpowers"]);
    assert.deepEqual(legacyPick(features, "codex", null).tools, []);
    assert.deepEqual(legacyPick(features, "codex", null).prepare.map((e) => e.id), ["codegraph"]);
    assert.deepEqual(legacyPick(features, "claude", []).prepare, [], "the policy leaves codegraph out");
  });
});

describe("tool config per CLI", () => {
  it("gives Codex each MCP tool by -c, secrets by name", () => {
    const args = codexToolArgs([rtk({ secretEnv: ["RTK_API_KEY"] }), APP_TOOLS.superpowers], { worktree: "/wt", repo: "/repo" });
    assert.deepEqual(args, [
      "-c",
      'mcp_servers.rtk.command="npx"',
      "-c",
      'mcp_servers.rtk.args=["-y","rtk-mcp@0.4.1","--root","/repo"]',
      "-c",
      'mcp_servers.rtk.env={RTK_TELEMETRY="0"}',
      "-c",
      'mcp_servers.rtk.env_vars=["RTK_API_KEY"]',
      "-c",
      'mcp_servers.rtk.default_tools_approval_mode="approve"',
    ]);
    // After Hive's own overrides, only for `codex exec`.
    const exec = codexArgs(["exec", "{prompt}"], undefined, [rtk()], { repo: "/repo" });
    assert.equal(exec[0], "exec");
    assert.ok(exec.indexOf('mcp_servers.rtk.command="npx"') > exec.indexOf('mcp_servers.xdev-hive.default_tools_approval_mode="approve"'));
    assert.deepEqual(codexArgs(["/opt/wrap.sh", "{prompt}"], undefined, [rtk()]), ["/opt/wrap.sh", "{prompt}"]);
    // A codegraph server ends with its agent here too.
    assert.ok(codexToolArgs([{ ...APP_TOOLS.codegraph, agents: ["codex"] }], {}).includes('mcp_servers.codegraph.env={CODEGRAPH_TELEMETRY="0",CODEGRAPH_NO_UPDATE_CHECK="1",CODEGRAPH_NO_DAEMON="1"}'));
  });

  it("keeps the folders tools prepare out of the commit, never a path outside the worktree", () => {
    const prep = (marker: string) => rtk({ prepare: { init: ["x"], sync: ["x"], marker } });
    assert.deepEqual(toolDirs([APP_TOOLS.codegraph, prep("./.rtk/index.db"), prep("rtk.lock"), prep("../up/x"), prep("/abs/x"), prep(".codegraph/other")]), [".codegraph", ".rtk", "rtk.lock"]);
  });
});

describe("prepareTool", () => {
  it("runs init without the marker and sync with it, with the entry's env", async () => {
    const wt = testTmpDir(path.join(os.tmpdir(), "hive-prep-"));
    const seen: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = async (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => (seen.push({ bin, args, env: opts.env }), { ok: true, output: "" });
    const entry = rtk({ prepare: { init: ["rtk", "init", "{worktree}", "{repo}"], sync: ["rtk", "sync"], marker: ".rtk/db" } });
    let t = 0;
    assert.equal(await prepareTool(entry, wt, { repo: "/repo" }, (b) => `/bin/${b}`, { PATH: "/bin" }, run, () => (t += 1500)), "# rtk: init 1.5 s");
    assert.deepEqual(seen[0]!.args, ["init", wt, "/repo"]);
    assert.equal(seen[0]!.bin, "/bin/rtk");
    assert.equal(seen[0]!.env.RTK_TELEMETRY, "0");
    mkdirSync(path.join(wt, ".rtk"));
    writeFileSync(path.join(wt, ".rtk", "db"), "");
    assert.match(await prepareTool(entry, wt, {}, (b) => b, {}, run), /^# rtk: sync \d+\.\d s$/);
    assert.equal(await prepareTool(entry, wt, {}, () => null, {}, run), "# rtk: rtk not found, not prepared for this run");
    assert.equal(seen.length, 2);
  });
});

describe("toolViews", () => {
  it("lists the tools this machine's projects have on, commands written out but for the run's paths", () => {
    const entry = rtk({ secretEnv: ["RTK_API_KEY"], install: ["npm", "i", "-g", "{package}"] });
    const views = toolViews(
      { entries: [entry, APP_TOOLS.codegraph, APP_TOOLS.superpowers], projects: { demo: [{ ...on("rtk"), required: true }], web: [] } },
      [
        { name: "demo", features: NO_FEATURES },
        { name: "web", features: { codegraph: true, superpowers: false } },
      ],
      {},
    );
    assert.deepEqual(views.map((v) => [v.id, v.trust, v.projects, v.handler, v.required]), [
      ["rtk", "new", ["demo"], null, ["demo"]],
      ["codegraph", "app", ["web"], "codegraph", []],
    ]);
    assert.deepEqual(views[0]!.commands, [
      { field: "mcp", argv: ["npx", "-y", "rtk-mcp@0.4.1", "--root", "{repo}"] },
      { field: "install", argv: ["npm", "i", "-g", "rtk-mcp@0.4.1"] },
    ]);
    assert.deepEqual(views[0]!.secretEnv, ["RTK_API_KEY"]);
    assert.equal(views[0]!.hash, toolHash(entry));
    assert.deepEqual(toolViews(null, [{ name: "demo", features: NO_FEATURES }], {}), [], "local mode");
  });
});

// ── hooks (roadmap 28d) ──────────────────────────────────────────────────────

/** RTK as the 28d migration puts it in the catalog. */
const RTK: ToolEntry = {
  id: "rtk",
  name: "RTK",
  description: "",
  kind: "hook",
  package: { registry: "brew", name: "rtk", version: "0.50.0" },
  mcp: null,
  plugin: null,
  hooks: [{ event: "PreToolUse", matcher: "Bash", command: ["rtk", "hook", "claude"] }],
  agents: ["claude"],
  check: ["rtk", "--version"],
  install: ["brew", "install", "{package}"],
  prepare: null,
  env: { RTK_TELEMETRY_DISABLED: "1", RTK_SUPPRESS_HOOK_WARNING: "1", RTK_DB_PATH: "{runDir}/rtk.db" },
  secretEnv: [],
  license: "Apache-2.0",
  homepage: "https://github.com/rtk-ai/rtk",
  handler: null,
  enabledByDefault: false,
};

/** A folder (a space in its name, for quoting) with an rtk that prints `version`; `gain` prints RTK's JSON or fails. */
export function fakeRtk(version = "0.50.0", gain: "ok" | "fail" | "junk" = "ok"): { bin: string; dir: string; calls: () => string[] } {
  const dir = testTmpDir(path.join(os.tmpdir(), "hive rtk-"));
  const log = path.join(dir, "calls.log");
  const out =
    gain === "ok"
      ? `echo 'warning: something first'; echo '{"summary":{"total_commands":42,"total_input":50000,"total_output":8000,"total_saved":42000,"avg_savings_pct":84.0}}'`
      : gain === "junk"
        ? "echo 'not json'"
        : "echo 'gain: no database' >&2; exit 1";
  writeFileSync(
    path.join(dir, "rtk"),
    `#!/bin/sh\necho "$*|$RTK_DB_PATH|$RTK_TELEMETRY_DISABLED" >> "${log}"\ncase "$1" in\n  --version) echo "rtk ${version}";;\n  gain) ${out};;\nesac\n`,
  );
  chmodSync(path.join(dir, "rtk"), 0o755);
  return { bin: path.join(dir, "rtk"), dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("hooks of the catalog (roadmap 28d)", () => {
  const pick = (c: MachineTools, kind: "claude" | "codex" = "claude", trust: Record<string, string> = { rtk: toolHash(RTK) }) =>
    runTools(c, "demo", NO_FEATURES, kind, { ...OPEN_POLICY }, trust, {});

  it("picks approved RTK for Claude and Codex, with no other Claude hooks translated", () => {
    const c = catalog([RTK], [on("rtk")]);
    const got = pick(c);
    assert.deepEqual([got.tools, got.prepare, got.hooks?.map((e) => e.id)], [[], [], ["rtk"]]);
    assert.deepEqual(pick(c, "codex").hooks, [RTK]);
    assert.equal(pick(catalog([{ ...RTK, id: "other-hook" }], [on("other-hook")]), "codex").hooks, undefined);
    assert.equal(pick(catalog([RTK], [on("rtk", null)])).hooks, undefined, "off by default");
    const untrusted = pick(c, "claude", {});
    assert.deepEqual([untrusted.hooks, untrusted.notes], [undefined, ["tool rtk: chờ người dùng máy cho phép (Cài đặt máy)"]]);
    assert.deepEqual(pick(c, "codex", {}).notes, untrusted.notes);
  });

  it("lists a hook on the Setup card with its commands, so it can be allowed", () => {
    const [view] = toolViews(catalog([RTK], [on("rtk")]), [{ name: "demo", features: NO_FEATURES }], {});
    assert.equal(view!.kind, "hook");
    assert.equal(view!.trust, "new");
    assert.deepEqual(view!.commands, [
      { field: "hooks.0", argv: ["rtk", "hook", "claude"] },
      { field: "check", argv: ["rtk", "--version"] },
      { field: "install", argv: ["brew", "install", "rtk"] },
    ]);
  });

  it("is ready at autonomy full, the pinned version found, with the program's full path", async () => {
    const rtk = fakeRtk();
    const resolve = (b: string) => (b === "rtk" ? rtk.bin : null);
    const ok = await readyHooks([RTK], { autonomy: "full", resolve, env: {}, platform: "darwin" });
    assert.deepEqual(ok.notes, []);
    assert.deepEqual(ok.ready.map((r) => r.hooks), [[{ event: "PreToolUse", matcher: "Bash", argv: [rtk.bin, "hook", "claude"] }]]);
    assert.deepEqual(rtk.calls(), ["--version||1"], "the check gets the entry's env, without what needs {runDir}");

    const edit = await readyHooks([RTK], { autonomy: "edit", resolve, env: {}, platform: "darwin" });
    assert.deepEqual([edit.ready, edit.notes], [[], ["tool rtk: chỉ chạy với autonomy full"]]);
    const win = await readyHooks([RTK], { autonomy: "full", resolve, env: {}, platform: "win32" });
    assert.deepEqual([win.ready, win.notes], [[], ["tool rtk: hook chưa chạy trên Windows"]]);
    const newer = fakeRtk("0.51.0");
    const other = await readyHooks([RTK], { autonomy: "full", resolve: () => newer.bin, env: {}, platform: "darwin" });
    assert.deepEqual([other.ready, other.notes], [[], ["tool rtk: máy có 0.51.0, danh mục duyệt 0.50.0, run không dùng hook"]]);
    const none = await readyHooks([RTK], { autonomy: "full", resolve: () => null, env: {}, platform: "darwin" });
    assert.deepEqual([none.ready, none.notes], [[], ["tool rtk: không tìm thấy rtk, run không dùng hook"]]);
  });

  it("writes the hooks for Claude Code's settings, each command one quoted shell line", () => {
    assert.equal(shellQuote("/usr/local/bin/rtk"), "/usr/local/bin/rtk");
    assert.equal(shellQuote("/tmp/hive rtk/it's"), String.raw`'/tmp/hive rtk/it'\''s'`);
    const ready = [{ entry: RTK, hooks: [{ event: "PreToolUse" as const, matcher: "Bash", argv: ["/opt/my tools/rtk", "hook", "claude"] }] }];
    assert.deepEqual(claudeHooks(ready), {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/opt/my tools/rtk' hook claude", timeout: 10 }] }],
    });
    assert.deepEqual(hookEnv(ready, "/data/runs/R-1"), { RTK_TELEMETRY_DISABLED: "1", RTK_SUPPRESS_HOOK_WARNING: "1", RTK_DB_PATH: "/data/runs/R-1/rtk.db" });
  });

  it("takes only the listed keys of the user's settings, from CLAUDE_CONFIG_DIR when set", () => {
    const home = testTmpDir(path.join(os.tmpdir(), "hive-home-"));
    mkdirSync(path.join(home, ".claude"));
    const full = {
      permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./.env)"], ask: ["Bash(git push:*)"], defaultMode: "plan" },
      env: { SOME_FLAG: "1", BAD: 3 },
      apiKeyHelper: "~/bin/key.sh",
      model: "opus",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "evil" }] }] },
      disableAllHooks: false,
      enabledPlugins: { "x@y": true },
      statusLine: { type: "command", command: "evil" },
      cleanupPeriodDays: 1,
    };
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(full));
    assert.deepEqual(userClaudeSettings({}, home), {
      settings: { permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./.env)"], ask: ["Bash(git push:*)"] }, env: { SOME_FLAG: "1" }, apiKeyHelper: "~/bin/key.sh", model: "opus" },
      note: null,
    });
    // A 24b account's folder, written with ~ as profiles do.
    mkdirSync(path.join(home, "acct2"));
    writeFileSync(path.join(home, "acct2", "settings.json"), JSON.stringify({ model: "sonnet" }));
    assert.deepEqual(userClaudeSettings({ CLAUDE_CONFIG_DIR: "~/acct2" }, home).settings, { model: "sonnet" });
    assert.deepEqual(userClaudeSettings({ CLAUDE_CONFIG_DIR: path.join(home, "none") }, home), { settings: {}, note: null }, "no file: nothing to take");
    writeFileSync(path.join(home, "acct2", "settings.json"), "{ broken");
    const broken = userClaudeSettings({ CLAUDE_CONFIG_DIR: path.join(home, "acct2") }, home);
    assert.deepEqual(broken.settings, {});
    assert.match(broken.note!, /^không đọc được .*acct2\/settings\.json \(.+\): run không chép gì/);
  });

  it("starts Claude with no setting source, the catalog's hooks and the user's keys, and the old flags without hooks", () => {
    const run = { project: "demo", task: "T-1", worktree: "/w/T-1" };
    const before = claudeRunArgs("claude-a", run, []);
    assert.deepEqual(claudeRunArgs("claude-a", run, [], undefined, null, { worktree: run.worktree }, null), before, "no hook: the flags as before");
    assert.deepEqual(claudeRunArgs("claude-a", run, [], undefined, null, { worktree: run.worktree }, { ready: [], env: {}, user: { model: "opus" } }), before, "none ready: as before");
    assert.equal(before[before.indexOf("--setting-sources") + 1], "user");

    const hooks: ClaudeHookRun = {
      ready: [{ entry: RTK, hooks: [{ event: "PreToolUse", matcher: "Bash", argv: ["/opt/homebrew/bin/rtk", "hook", "claude"] }] }],
      env: { RTK_DB_PATH: "/data/runs/R-1/rtk.db" },
      user: { permissions: { allow: ["Bash(npm test:*)", "mcp__xdev-hive"], deny: ["Read(./.env)"], ask: ["Bash(git push:*)"] }, model: "opus", apiKeyHelper: "/k.sh", env: { SECRET_ONE: "value-0042" } },
    };
    const args = claudeRunArgs("claude-a", { ...run, references: [{ project: "old", path: "/r/old", branch: "main", sha: "abc" }] }, [], undefined, null, { worktree: run.worktree }, hooks);
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), {
      apiKeyHelper: "/k.sh",
      model: "opus",
      permissions: {
        allow: ["Bash(npm test:*)", "mcp__xdev-hive"],
        deny: ["Read(./.env)", "Write(/r/old/**)", "Edit(/r/old/**)", "MultiEdit(/r/old/**)", "NotebookEdit(/r/old/**)", "Write(//r/old/**)", "Edit(//r/old/**)", "MultiEdit(//r/old/**)", "NotebookEdit(//r/old/**)"],
        ask: ["Bash(git push:*)"],
      },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/homebrew/bin/rtk hook claude", timeout: 10 }] }] },
    });
    assert.equal(args.join(" ").includes("value-0042"), false, "the user's env goes to the process, not the command line");
  });

  it("reads RTK's numbers for the run, and null when it cannot tell", async () => {
    const ready = (bin: string) => [{ entry: RTK, hooks: [{ event: "PreToolUse" as const, matcher: "Bash", argv: [bin, "hook", "claude"] }] }];
    const ok = fakeRtk();
    const env = { ...process.env, RTK_DB_PATH: "/data/runs/R-1/rtk.db" };
    assert.deepEqual(await rtkGain(ready(ok.bin), env), { tool: "rtk", commands: 42, input: 50000, output: 8000, saved: 42000 });
    assert.deepEqual(ok.calls(), ["gain --format json|/data/runs/R-1/rtk.db|"]);
    assert.equal(await rtkGain(ready(fakeRtk("0.50.0", "fail").bin), env), null);
    assert.equal(await rtkGain(ready(fakeRtk("0.50.0", "junk").bin), env), null);
    assert.equal(await rtkGain([], env), null, "no RTK in the run");
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
