import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { expandPackage, HiveError, packageSpec, sha256Hex, toolArgv, toolEnv, toolHash, toolProblem, versionIn, versionMatches, type Actor, type HiveEvent, type ToolEntry } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
/** An admin with per-project grants is not a hub admin. */
const projectAdmin: Actor = { name: "an", role: "admin", access: { projects: { app: "lead" } } };
/** Lead of app, member of web, nothing on billing. */
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "lead", web: "member" } } };
const leadAgent: Actor = { name: "claude.lan-mbp@lan-mbp", role: "agent", access: lead.access };
const webViewer: Actor = { name: "pm", role: "viewer", access: { projects: { web: "viewer" } } };

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

/** A valid MCP entry to break one field of at a time. */
/** An MCP stand-in: "rtk" itself is the 28d migration's hook entry. */
const rtk = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  id: "rtk-mcp",
  name: "RTK",
  description: "Shorter command output for agents.",
  kind: "mcp",
  package: { registry: "npm", name: "rtk-mcp", version: "0.4.1" },
  mcp: { command: "npx", args: ["-y", "{package}"] },
  plugin: null,
  hooks: [],
  agents: ["claude"],
  check: null,
  install: null,
  prepare: null,
  env: { RTK_TELEMETRY: "0" },
  secretEnv: ["RTK_API_KEY"],
  license: "MIT",
  homepage: "https://example.com/rtk",
  handler: null,
  enabledByDefault: false,
  ...over,
});

describe("tool catalog (roadmap 28a)", () => {
  it("seeds codegraph, superpowers and Spec Kit as machines ran them on 2/10", async () => {
    const hive = new SqliteHive(":memory:");
    // RTK (28d) comes in later, as an entry an admin could have added: not built in.
    const list = (await hive.call("tools.list", {}, admin)).filter((t) => t.builtin);
    assert.deepEqual(list.map((t) => t.id).sort(), ["codegraph", "speckit", "superpowers"]);
    for (const t of list) {
      assert.equal(t.builtin, true);
      assert.equal(t.version, 1);
      assert.equal(t.updatedBy, "hive");
      assert.equal(t.license, "MIT");
      assert.equal(t.handler, t.id);
      assert.equal(t.enabledByDefault, false);
      assert.equal(toolProblem(t, true), null, `${t.id} passes its own checks`);
    }
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    const codegraph = byId.codegraph!;
    assert.equal(codegraph.kind, "mcp");
    assert.deepEqual(codegraph.package, { registry: "npm", name: "@colbymchenry/codegraph", version: "1.6.0" });
    assert.deepEqual(codegraph.mcp, { command: "npx", args: ["-y", "{package}", "serve", "--mcp"] });
    assert.deepEqual(expandPackage(codegraph.mcp!.args, codegraph.package), ["-y", "@colbymchenry/codegraph@1.6.0", "serve", "--mcp"], "what the app pins today");
    assert.deepEqual(codegraph.prepare, {
      init: ["npx", "-y", "{package}", "init", "{worktree}"],
      sync: ["npx", "-y", "{package}", "sync", "{worktree}"],
      marker: ".codegraph/codegraph.db",
    });
    assert.deepEqual(codegraph.env, { CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" });
    assert.deepEqual(codegraph.agents, ["claude"]);

    const superpowers = byId.superpowers!;
    assert.equal(superpowers.kind, "plugin");
    assert.equal(superpowers.plugin, "superpowers@claude-plugins-official");
    assert.deepEqual(superpowers.package, { registry: "claude-plugin", name: "superpowers@claude-plugins-official", version: "6.4.2" });
    assert.deepEqual(superpowers.agents, ["claude"]);

    const speckit = byId.speckit!;
    assert.equal(speckit.kind, "cli");
    assert.deepEqual(speckit.package, { registry: "git", name: "https://github.com/github/spec-kit.git", version: "v1.0.13" });
    assert.deepEqual(speckit.check, ["specify", "--version"]);
    assert.deepEqual(expandPackage(speckit.install!, speckit.package), ["uv", "tool", "install", "specify-cli", "--from", "git+https://github.com/github/spec-kit.git@v1.0.13"]);
    assert.deepEqual(speckit.agents, ["claude", "codex"]);
  });

  it("writes {package} out per registry", () => {
    assert.equal(packageSpec({ registry: "npm", name: "a", version: "1.0.0" }), "a@1.0.0");
    assert.equal(packageSpec({ registry: "pypi", name: "a", version: "1.0.0" }), "a==1.0.0");
    assert.equal(packageSpec({ registry: "git", name: "https://x.test/a.git", version: "v1.0.0" }), "git+https://x.test/a.git@v1.0.0");
    assert.deepEqual(expandPackage(["--from={package}"], { registry: "pypi", name: "a", version: "2.0.0" }), ["--from=a==2.0.0"]);
  });

  it("refuses an entry whose version is not pinned, or that names its package instead of {package}", async () => {
    const hive = new SqliteHive(":memory:");
    const save = (entry: ToolEntry) => refusal(hive.call("tools.save", { entry }, admin));
    assert.equal(await save(rtk({ package: { registry: "npm", name: "rtk-mcp", version: "latest" } })), "errors.toolVersionPin");
    assert.equal(await save(rtk({ package: { registry: "npm", name: "rtk-mcp", version: "^1.2.0" } })), "errors.toolVersionPin");
    assert.equal(await save(rtk({ package: { registry: "npm", name: "rtk-mcp", version: "1.2" } })), "errors.toolVersionPin");
    assert.equal(await save(rtk({ package: null, mcp: { command: "npx", args: ["-y", "rtk-mcp@latest"] } })), "errors.toolUnpinned");
    assert.equal(await save(rtk({ package: null, mcp: { command: "npx", args: ["-y", "rtk-mcp", "~1.2"] } })), "errors.toolUnpinned");
    assert.equal(await save(rtk({ install: ["npm", "i", "-g", "latest"] })), "errors.toolUnpinned");
    assert.equal(await save(rtk({ mcp: { command: "npx", args: ["-y", "rtk-mcp@0.4.1"] } })), "errors.toolPackageName");
    assert.equal(await save(rtk({ mcp: { command: "npx", args: ["-y", "rtk-mcp"] } })), "errors.toolPackageName");
    // The program may be called like its package: that is a binary, not a package spec.
    const saved = await hive.call("tools.save", { entry: rtk({ check: ["rtk-mcp", "--version"] }) }, admin);
    assert.deepEqual(saved.check, ["rtk-mcp", "--version"]);
  });

  it("refuses secrets and hidden characters in env, bad names, and a kind without its field", async () => {
    const hive = new SqliteHive(":memory:");
    const save = (entry: ToolEntry) => refusal(hive.call("tools.save", { entry }, admin));
    assert.equal(await save(rtk({ env: { RTK_TOKEN: "ghp_" + "a".repeat(36) } })), "errors.toolSecret");
    assert.equal(await save(rtk({ env: { RTK_MODE: "fast​" } })), "errors.toolHidden");
    assert.equal(await save(rtk({ description: "safe‮txet" })), "errors.toolHidden");
    assert.equal(await save(rtk({ env: { "rtk-mode": "1" } })), "errors.toolEnvName");
    assert.equal(await save(rtk({ secretEnv: ["1KEY"] })), "errors.toolEnvName");
    assert.equal(await save(rtk({ mcp: null })), "errors.toolKindField");
    assert.equal(await save(rtk({ kind: "plugin", mcp: null })), "errors.toolKindField");
    assert.equal(await save(rtk({ kind: "hook" })), "errors.toolKindField");
    assert.equal(await save(rtk({ kind: "cli" })), "errors.toolKindField");
    assert.equal(await save(rtk({ id: "RTK" })), "errors.toolId");
    assert.equal(await save(rtk({ id: "-rtk" })), "errors.toolId");
    assert.equal(await save(rtk({ homepage: "http://example.com" })), "errors.toolHomepage");
    assert.equal(await save(rtk({ license: " " })), "errors.toolLicense");
    assert.equal(await save(rtk({ handler: "codegraph" })), "errors.toolHandler", "only seeds have the app's code");
    // The field it is about, for the Tool page to show the message under it.
    assert.equal(toolProblem(rtk({ package: { registry: "npm", name: "rtk-mcp", version: "latest" } }), false)?.vars?.field, "package.version");
    assert.equal(toolProblem(rtk({ prepare: { init: ["npx", "{package}"], sync: ["npx", "@latest"], marker: ".rtk" } }), false)?.vars?.field, "prepare.sync");
  });

  it("adds, changes with the version read, and refuses an old one", async () => {
    const hive = new SqliteHive(":memory:");
    const created = await hive.call("tools.save", { entry: rtk() }, admin);
    assert.equal(created.version, 1);
    assert.equal(created.builtin, false);
    assert.equal(created.updatedBy, "duy");
    assert.equal(await refusal(hive.call("tools.save", { entry: rtk() }, admin)), "errors.toolExists", "no baseVersion: a new entry only");
    assert.equal(await refusal(hive.call("tools.save", { entry: rtk({ id: "nope" }), baseVersion: 1 }, admin)), "errors.toolNotFound");

    const changed = await hive.call("tools.save", { entry: rtk({ name: "RTK 2", package: { registry: "npm", name: "rtk-mcp", version: "0.5.0" } }), baseVersion: 1 }, admin);
    assert.equal(changed.version, 2);
    assert.equal(changed.package?.version, "0.5.0");
    assert.equal(await refusal(hive.call("tools.save", { entry: rtk({ name: "stale" }), baseVersion: 1 }, admin)), "errors.toolVersion");
    assert.equal((await hive.call("tools.list", {}, admin)).find((t) => t.id === "rtk-mcp")?.name, "RTK 2");
  });

  it("lets a seed change but not its id, kind or handler, and never removes it", async () => {
    const hive = new SqliteHive(":memory:");
    const seed = (await hive.call("tools.list", {}, admin)).find((t) => t.id === "codegraph")!;
    const { builtin: _b, version: _v, updatedAt: _a, updatedBy: _u, projects: _p, ...entry } = seed;
    const bumped = await hive.call("tools.save", { entry: { ...entry, enabledByDefault: true }, baseVersion: 1 }, admin);
    assert.equal(bumped.version, 2);
    assert.equal(bumped.builtin, true, "still a seed");
    assert.equal(bumped.handler, "codegraph");
    assert.equal(await refusal(hive.call("tools.save", { entry: { ...entry, handler: null }, baseVersion: 2 }, admin)), "errors.toolBuiltinFixed");
    assert.equal(await refusal(hive.call("tools.save", { entry: { ...entry, kind: "cli", check: ["codegraph"] }, baseVersion: 2 }, admin)), "errors.toolBuiltinFixed");
    assert.equal(await refusal(hive.call("tools.remove", { id: "codegraph" }, admin)), "errors.toolBuiltin");

    await hive.call("tools.save", { entry: rtk() }, admin);
    await hive.call("tools.setProject", { id: "rtk-mcp", project: "app", enabled: true, required: false }, admin);
    assert.deepEqual(await hive.call("tools.remove", { id: "rtk-mcp" }, admin), { removed: true });
    assert.deepEqual(await hive.call("tools.remove", { id: "rtk-mcp" }, admin), { removed: false });
    // Its projects' settings went with it: an entry of the same id starts clean.
    const again = await hive.call("tools.save", { entry: rtk() }, admin);
    assert.deepEqual(again.projects, []);
  });

  it("lets only a hub admin change the catalog", async () => {
    const hive = new SqliteHive(":memory:");
    assert.equal(await refusal(hive.call("tools.save", { entry: rtk() }, projectAdmin)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("tools.remove", { id: "codegraph" }, projectAdmin)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("tools.save", { entry: rtk() }, lead)), "errors.roleTooLow");
    assert.equal(await refusal(hive.call("tools.remove", { id: "codegraph" }, lead)), "errors.roleTooLow");
  });

  it("lets a project manager set their project, not another one, and never an agent token", async () => {
    const hive = new SqliteHive(":memory:");
    const view = await hive.call("tools.setProject", { id: "codegraph", project: "app", enabled: true, required: true }, lead);
    assert.deepEqual(view.projects, [{ project: "app", enabled: true, required: true, effective: true }]);
    assert.equal(await refusal(hive.call("tools.setProject", { id: "codegraph", project: "web", enabled: true, required: false }, lead)), "errors.need.projectSettings");
    assert.equal(await refusal(hive.call("tools.setProject", { id: "codegraph", project: "billing", enabled: true, required: false }, lead)), "errors.notFound");
    assert.equal(await refusal(hive.call("tools.setProject", { id: "codegraph", project: "app", enabled: false, required: false }, leadAgent)), "errors.need.projectSettings");
    assert.equal(await refusal(hive.call("tools.setProject", { id: "nope", project: "app", enabled: true, required: false }, lead)), "errors.toolNotFound");
  });

  it("works out effective from the three states and the default", async () => {
    const hive = new SqliteHive(":memory:");
    const set = (enabled: boolean | null) => hive.call("tools.setProject", { id: "speckit", project: "app", enabled, required: false }, admin);
    const effective = async () => (await hive.call("tools.list", { project: "app" }, admin)).find((t) => t.id === "speckit")!.projects;
    assert.deepEqual(await effective(), [{ project: "app", enabled: null, required: false, effective: false }], "no row: the default (off)");
    await set(true);
    assert.deepEqual(await effective(), [{ project: "app", enabled: true, required: false, effective: true }]);
    await set(false);
    assert.deepEqual(await effective(), [{ project: "app", enabled: false, required: false, effective: false }]);
    await set(null);
    assert.equal((await hive.call("tools.list", {}, admin)).find((t) => t.id === "speckit")!.projects.length, 0, "null and not required: the row is gone");

    // With the default on, a project off stays off and the others follow.
    const seed = (await hive.call("tools.list", {}, admin)).find((t) => t.id === "speckit")!;
    const { builtin: _b, version, updatedAt: _a, updatedBy: _u, projects: _p, ...entry } = seed;
    await hive.call("tools.save", { entry: { ...entry, enabledByDefault: true }, baseVersion: version }, admin);
    await hive.call("tools.setProject", { id: "speckit", project: "web", enabled: false, required: false }, admin);
    assert.equal((await effective())[0]!.effective, true, "app follows the default");
    assert.equal((await hive.call("tools.list", { project: "web" }, admin)).find((t) => t.id === "speckit")!.projects[0]!.effective, false);
  });

  it("shows everyone the catalog but only the settings of projects they may view", async () => {
    const hive = new SqliteHive(":memory:");
    for (const project of ["app", "web", "billing"]) await hive.call("tools.setProject", { id: "codegraph", project, enabled: true, required: false }, admin);
    const theirs = await hive.call("tools.list", {}, webViewer);
    assert.equal(theirs.length, 4, "every entry");
    assert.deepEqual(theirs.find((t) => t.id === "codegraph")!.projects.map((p) => p.project), ["web"]);
    assert.deepEqual((await hive.call("tools.list", {}, admin)).find((t) => t.id === "codegraph")!.projects.map((p) => p.project), ["app", "billing", "web"]);
    assert.equal(await refusal(hive.call("tools.list", { project: "billing" }, webViewer)), "errors.notFound");
    assert.deepEqual((await hive.call("tools.list", { project: "web" }, webViewer)).find((t) => t.id === "codegraph")!.projects.map((p) => p.project), ["web"]);
    assert.equal(await refusal(hive.call("tools.setProject", { id: "codegraph", project: "web", enabled: false, required: false }, webViewer)), "errors.roleTooLow");
  });

  it("logs every write and tells listeners", async () => {
    const events: HiveEvent[] = [];
    const hive = new SqliteHive(":memory:", { onEvent: (e) => events.push(e) });
    await hive.call("tools.save", { entry: rtk() }, admin);
    await hive.call("tools.setProject", { id: "rtk-mcp", project: "app", enabled: false, required: true }, lead);
    await hive.call("tools.remove", { id: "rtk-mcp" }, admin);

    const saved = await hive.call("admin.audit", { action: "tools.save" }, admin);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.target, "rtk-mcp");
    assert.match(saved[0]!.detail ?? "", /rtk-mcp@0\.4\.1/);
    const set = await hive.call("admin.audit", { action: "tools.setProject" }, admin);
    assert.equal(set.length, 1);
    assert.equal(set[0]!.target, "app/rtk-mcp");
    assert.equal(set[0]!.detailKey, "audit.toolProject.offRequired");
    assert.equal((await hive.call("admin.audit", { action: "tools.remove" }, admin)).length, 1);

    assert.deepEqual(
      events.filter((e) => e.type === "tool.changed").map((e) => (e.type === "tool.changed" ? [e.tool, e.project, e.by, e.removed] : null)),
      [
        ["rtk-mcp", null, "duy", false],
        ["rtk-mcp", "app", "lan", false],
        ["rtk-mcp", null, "duy", true],
      ],
    );
  });
});

describe("tool catalog on machines (roadmap 28b)", () => {
  it("fills in {package} per registry, {worktree} and {repo}, in one pass", () => {
    const npm = rtk();
    assert.deepEqual(toolArgv(["npx", "-y", "{package}", "init", "{worktree}"], npm, { worktree: "/wt/T-1" }), ["npx", "-y", "rtk-mcp@0.4.1", "init", "/wt/T-1"]);
    assert.deepEqual(toolArgv(["uvx", "--from={package}", "rtk"], rtk({ package: { registry: "pypi", name: "rtk", version: "1.2.0" } })), ["uvx", "--from=rtk==1.2.0", "rtk"]);
    assert.deepEqual(
      toolArgv(["uv", "tool", "install", "{package}"], rtk({ package: { registry: "git", name: "https://x.test/rtk.git", version: "v1.0.0" } })),
      ["uv", "tool", "install", "git+https://x.test/rtk.git@v1.0.0"],
    );
    assert.deepEqual(toolArgv(["claude", "plugin", "install", "{package}"], rtk({ package: { registry: "claude-plugin", name: "rtk@market", version: "1.0.0" } })), ["claude", "plugin", "install", "rtk@market"]);
    assert.deepEqual(toolArgv(["--root={repo}", "--wt={worktree}"], npm, { worktree: "/w", repo: "/r" }), ["--root=/r", "--wt=/w"]);
    // A worktree whose path holds a placeholder is not filled in again; other braces are the tool's own.
    assert.deepEqual(toolArgv(["{worktree}", "{json}"], npm, { worktree: "/tmp/{repo}" }), ["/tmp/{repo}", "{json}"]);
  });

  it("refuses a placeholder it has nothing for, with a key", () => {
    const placeholder = (run: () => unknown) => {
      try {
        run();
      } catch (err) {
        assert.ok(err instanceof HiveError);
        return [err.key, err.vars?.placeholder];
      }
      assert.fail("expected toolArgv to throw");
    };
    assert.deepEqual(placeholder(() => toolArgv(["init", "{worktree}"], rtk())), ["errors.toolPlaceholder", "{worktree}"], "an install has no worktree");
    assert.deepEqual(placeholder(() => toolArgv(["{repo}"], rtk(), { worktree: "/w" })), ["errors.toolPlaceholder", "{repo}"]);
    assert.deepEqual(placeholder(() => toolArgv(["-y", "{package}"], rtk({ package: null }))), ["errors.toolPlaceholder", "{package}"]);
  });

  it("hashes what the machine runs: a new version or command asks again, a new description does not", () => {
    const base = toolHash(rtk());
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(toolHash(rtk({ description: "Other words", name: "RTK!", agents: ["claude", "codex"], enabledByDefault: true, license: "Apache-2.0" })), base);
    assert.equal(toolHash(rtk({ env: { RTK_TELEMETRY: "0" }, secretEnv: ["RTK_API_KEY"] })), base, "same values, same hash");
    assert.notEqual(toolHash(rtk({ package: { registry: "npm", name: "rtk-mcp", version: "0.4.2" } })), base);
    assert.notEqual(toolHash(rtk({ mcp: { command: "npx", args: ["-y", "{package}", "--fast"] } })), base);
    assert.notEqual(toolHash(rtk({ env: { RTK_TELEMETRY: "1" } })), base);
    assert.notEqual(toolHash(rtk({ secretEnv: ["RTK_OTHER_KEY"] })), base);
    assert.notEqual(toolHash(rtk({ check: ["rtk-mcp", "--version"] })), base);
    assert.notEqual(toolHash(rtk({ install: ["npm", "i", "-g", "{package}"] })), base);
    assert.notEqual(toolHash(rtk({ prepare: { init: ["rtk", "init"], sync: ["rtk", "sync"], marker: ".rtk/db" } })), base);
    assert.notEqual(toolHash(rtk({ plugin: "rtk@market" })), base);
    // Key order in env does not matter.
    assert.equal(toolHash(rtk({ env: { A: "1", B: "2" } })), toolHash(rtk({ env: { B: "2", A: "1" } })));
  });

  it("computes SHA-256 like node:crypto, in the browser too", () => {
    for (const text of ["", "abc", "Tiếng Việt có dấu 🐝", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)]) {
      assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), JSON.stringify(text.slice(0, 20)));
    }
  });

  it("sends a machine the entries and settings of the projects it has and its token sees", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("tools.save", { entry: rtk() }, admin);
    await hive.call("tools.save", { entry: rtk({ id: "elsewhere" }) }, admin);
    await hive.call("tools.save", { entry: rtk({ id: "everywhere", enabledByDefault: true }) }, admin);
    await hive.call("tools.save", { entry: rtk({ id: "unused" }) }, admin);
    await hive.call("tools.setProject", { id: "rtk-mcp", project: "app", enabled: true, required: true }, admin);
    await hive.call("tools.setProject", { id: "elsewhere", project: "billing", enabled: true, required: false }, admin);
    await hive.call("tools.setProject", { id: "codegraph", project: "web", enabled: false, required: false }, admin);
    // A lead's machine: it says it has billing too, which its token does not see.
    const beat = await hive.call("machines.heartbeat", { machine: "lan-mbp", instance: "a1b2c3d4", projects: ["app", "web", "billing"] }, leadAgent);
    const ids = beat.tools.entries.map((e) => e.id);
    assert.deepEqual(ids, ["codegraph", "everywhere", "rtk-mcp", "speckit", "superpowers"], "set by its projects, on by default, or the app's own");
    assert.deepEqual(Object.keys(beat.tools.projects).sort(), ["app", "web"]);
    const rtkEntry = beat.tools.entries.find((e) => e.id === "rtk-mcp")!;
    assert.deepEqual(rtkEntry.mcp, { command: "npx", args: ["-y", "{package}"] }, "placeholders left for the machine");
    assert.deepEqual(rtkEntry.secretEnv, ["RTK_API_KEY"], "names only");
    const of = (project: string, id: string) => beat.tools.projects[project]!.find((s) => s.id === id);
    assert.deepEqual(of("app", "rtk-mcp"), { id: "rtk-mcp", enabled: true, effective: true, required: true });
    assert.deepEqual(of("web", "rtk-mcp"), { id: "rtk-mcp", enabled: null, effective: false, required: false });
    assert.deepEqual(of("web", "codegraph"), { id: "codegraph", enabled: false, effective: false, required: false });
    assert.deepEqual(of("app", "codegraph"), { id: "codegraph", enabled: null, effective: false, required: false });
    assert.deepEqual(of("app", "everywhere"), { id: "everywhere", enabled: null, effective: true, required: false });

    // A machine with no project yet hears only what is on by default and the app's own entries.
    const bare = await hive.call("machines.heartbeat", { machine: "new-mbp", instance: "b1b2c3d4" }, { name: "runner.new@duy", role: "agent" });
    assert.deepEqual(bare.tools.entries.map((e) => e.id), ["codegraph", "everywhere", "speckit", "superpowers"]);
    assert.deepEqual(bare.tools.projects, {});
  });
});

describe("RTK and hooks of the catalog (roadmap 28d)", () => {
  it("comes in with the migration, off by default, not built in, and passes its own checks", async () => {
    const hive = new SqliteHive(":memory:");
    const entry = (await hive.call("tools.list", {}, admin)).find((t) => t.id === "rtk")!;
    assert.equal(entry.kind, "hook");
    assert.equal(entry.builtin, false);
    assert.equal(entry.enabledByDefault, false);
    assert.equal(entry.handler, null);
    assert.deepEqual(entry.package, { registry: "brew", name: "rtk", version: "0.50.0" });
    assert.deepEqual(entry.hooks, [{ event: "PreToolUse", matcher: "Bash", command: ["rtk", "hook", "claude"] }]);
    assert.deepEqual(entry.agents, ["claude"]);
    assert.equal(entry.env.RTK_DB_PATH, "{runDir}/rtk.db");
    assert.equal(toolProblem(entry, false), null);
    assert.deepEqual(toolArgv(entry.install!, entry), ["brew", "install", "rtk"]);
  });

  it("takes {runDir} only in a hook entry's env values", () => {
    const hook = rtk({ kind: "hook", mcp: null, secretEnv: [], hooks: [{ event: "PreToolUse", matcher: "Bash", command: ["rtk", "hook", "claude"] }], env: { RTK_DB_PATH: "{runDir}/rtk.db" } });
    assert.equal(toolProblem(hook, false), null);
    const key = (e: ToolEntry) => {
      const p = toolProblem(e, false);
      return p && [p.key, p.vars?.field, p.vars?.placeholder];
    };
    assert.deepEqual(key(rtk({ env: { RTK_DB_PATH: "{runDir}/rtk.db" } })), ["errors.toolRunDir", "env", "{runDir}"], "an MCP entry has no run folder of its own");
    assert.deepEqual(key({ ...hook, hooks: [{ event: "PreToolUse", matcher: "Bash", command: ["rtk", "--db", "{runDir}/x"] }] }), ["errors.toolRunDir", "hooks.0", "{runDir}"]);
    assert.deepEqual(key({ ...hook, check: ["rtk", "{runDir}"] }), ["errors.toolRunDir", "check", "{runDir}"]);
    assert.deepEqual(key({ ...hook, hooks: [{ event: "PreToolUse", matcher: "{runDir}", command: ["rtk"] }] }), ["errors.toolRunDir", "hooks.0", "{runDir}"]);
    assert.equal(key({ ...hook, description: "keeps its history in {runDir}" }), null, "words a person reads may name it");
  });

  it("fills {runDir} in env, and leaves out what needs it when there is no run", () => {
    const e = { env: { A: "1", RTK_DB_PATH: "{runDir}/rtk.db" } };
    assert.deepEqual(toolEnv(e, "/data/runs/R-1"), { A: "1", RTK_DB_PATH: "/data/runs/R-1/rtk.db" });
    assert.deepEqual(toolEnv(e), { A: "1" });
  });

  it("reads the version a check printed and matches it with the pin, v or not", () => {
    assert.equal(versionIn("rtk 0.50.0"), "0.50.0");
    assert.equal(versionIn("rtk v0.50.0 (1d87b8e)"), "0.50.0");
    assert.equal(versionIn("tool 2.0.0-rc.1\n"), "2.0.0-rc.1");
    assert.equal(versionIn("no version here"), null);
    assert.equal(versionMatches("rtk 0.50.0", "0.50.0"), true);
    assert.equal(versionMatches("rtk 0.50.0", "v0.50.0"), true);
    assert.equal(versionMatches("rtk v0.50.0", "0.50.0"), true);
    assert.equal(versionMatches("rtk 0.51.0", "0.50.0"), false);
    assert.equal(versionMatches("rtk 0.50.01", "0.50.0"), false);
    assert.equal(versionMatches("rtk 10.50.0", "0.50.0"), false);
    assert.equal(versionMatches("", "0.50.0"), false);
  });
});
