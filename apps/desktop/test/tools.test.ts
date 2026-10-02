import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OPEN_POLICY, packageSpec, toolHash, type Actor, type MachineTools, type ToolEntry } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { CODEGRAPH_MCP, CODEGRAPH_PACKAGE, NO_FEATURES, SUPERPOWERS_PLUGIN } from "#desktop/main/installer.ts";
import { codexArgs } from "#desktop/main/runner/command.ts";
import { APP_TOOLS, codexToolArgs, legacyPick, prepareTool, runTools, toolDirs, toolViews, trustOf } from "#desktop/main/runner/tools.ts";

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
    for (const seed of seeds) {
      assert.equal(toolHash(seed), toolHash(APP_TOOLS[seed.handler!]), seed.id);
      assert.equal(trustOf(seed, {}), "app");
    }
    assert.equal(packageSpec(APP_TOOLS.codegraph.package!), CODEGRAPH_PACKAGE);
    assert.deepEqual(APP_TOOLS.codegraph.env, CODEGRAPH_MCP.env);
    assert.equal(APP_TOOLS.superpowers.plugin, SUPERPOWERS_PLUGIN);
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
    const wt = mkdtempSync(path.join(os.tmpdir(), "hive-prep-"));
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
      { entries: [entry, APP_TOOLS.codegraph, APP_TOOLS.superpowers], projects: { demo: [on("rtk")], web: [] } },
      [
        { name: "demo", features: NO_FEATURES },
        { name: "web", features: { codegraph: true, superpowers: false } },
      ],
      {},
    );
    assert.deepEqual(views.map((v) => [v.id, v.trust, v.projects]), [
      ["rtk", "new", ["demo"]],
      ["codegraph", "app", ["web"]],
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
