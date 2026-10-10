import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MANAGED_START, type Actor, type HiveBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { CODEGRAPH_MCP, installAgents, installCodexConfig, installShim, isRepoHooksPath } from "#desktop/main/installer.ts";
import { branchPatchAsync, branchState, commitAll, commitAllAsync, ensureWorktree, ensureWorktreeAsync, remoteStart } from "#desktop/main/runner/worktree.ts";
import { isGitRepoAsync, withGitWorktreeLock } from "#desktop/main/git.ts";
import { proposeAgents, renderContext, syncProject } from "#desktop/main/sync.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };
const tmp = (p: string) => testTmpDir(path.join(os.tmpdir(), `hive-${p}-`));
const sh = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });

function gitRepo(): string {
  const repo = tmp("repo");
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  sh(repo, "git", ["config", "user.email", "test@example.com"]);
  sh(repo, "git", ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  sh(repo, "git", ["add", "."]);
  sh(repo, "git", ["commit", "-qm", "init"]);
  return repo;
}

const SHIM = "/home/duy/.local/bin/hive-mcp";
const WIN_SHIM = String.raw`C:\Users\duy\.xdev-hive\bin\hive-mcp.cmd`;

it("reports the full checkout SHA and commit count for evidence", () => {
  const repo = gitRepo();
  const base = sh(repo, "git", ["rev-parse", "HEAD"]).trim();
  writeFileSync(path.join(repo, "verified.txt"), "verified revision\n");
  sh(repo, "git", ["add", "."]);
  sh(repo, "git", ["commit", "-qm", "implementation"]);
  const headSha = sh(repo, "git", ["rev-parse", "HEAD"]).trim();
  assert.match(headSha, /^[a-f0-9]{40}$/);
  assert.deepEqual(branchState(repo, base), { commits: 1, headSha });
  sh(repo, "git", ["checkout", "--detach", base]);
  assert.deepEqual(branchState(repo, base), { commits: 0, headSha: base });
});

it("creates, diffs and commits a worktree through async Git", async () => {
  const repo = gitRepo();
  const dir = path.join(tmp("async-worktree"), "T-async");
  const wt = await ensureWorktreeAsync(repo, dir, "T-async", null);
  writeFileSync(path.join(dir, "new.txt"), "async content\n");
  assert.match(await branchPatchAsync(dir, wt.baseSha), /async content/);
  const result = await commitAllAsync(dir, "ai(T-async): work", []);
  assert.equal(result.error, null);
  assert.match(result.sha ?? "", /^[0-9a-f]+$/);
  assert.match(await branchPatchAsync(dir, wt.baseSha), /async content/);
});

it("accepts a project path inside a Git repository for async worktree creation", async () => {
  const repo = gitRepo();
  const nested = path.join(repo, "src"); mkdirSync(nested);
  assert.equal(await isGitRepoAsync(nested), true);
  const dir = path.join(tmp("nested-worktree"), "T-nested");
  const wt = await ensureWorktreeAsync(nested, dir, "T-nested", null);
  assert.equal(wt.created, true);
});

it("serializes simulated diff and add work per checkout and releases after failure", async () => {
  const repo = tmp("git-lock");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const diff = withGitWorktreeLock(repo, async () => { order.push("diff start"); await gate; order.push("diff end"); });
  const add = withGitWorktreeLock(repo, async () => { order.push("add"); });
  await Promise.resolve();
  assert.deepEqual(order, ["diff start"]);
  release();
  await Promise.all([diff, add]);
  assert.deepEqual(order, ["diff start", "diff end", "add"]);
  await assert.rejects(withGitWorktreeLock(repo, async () => { throw new Error("simulated failure"); }));
  await withGitWorktreeLock(repo, async () => { order.push("after failure"); });
  assert.equal(order.at(-1), "after failure");
});

describe("installAgents", () => {
  it("wires Claude, Gemini, Codex and Antigravity and is idempotent", () => {
    const repo = gitRepo();
    const home = tmp("home");
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const first = installAgents(repo, "demo", { home, shim: SHIM });
    assert.deepEqual(
      first.map((a) => [a.file, a.action]),
      [
        ["~/.claude.json", "created"],
        [".mcp.json", "unchanged"],
        [".gemini/settings.json", "created"],
        [".agents/mcp_config.json", "created"],
        [".claude/settings.json", "created"],
        [".xdev-hive/guard-docs.sh", "created"],
        [".githooks/pre-commit", "created"],
        ["git config core.hooksPath", "updated"],
        ["~/.codex/config.toml", "created"],
      ],
    );
    const mcp = JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.other, "keeps existing servers");
    assert.equal(mcp.mcpServers["xdev-hive"], undefined, "not in the file shared through git");
    // Claude Code's local scope, keyed by the folder it is started in.
    const local = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    assert.deepEqual(local.projects[repo].mcpServers["xdev-hive"], {
      type: "stdio",
      command: SHIM,
      args: [],
      env: { HIVE_AGENT: "claude", HIVE_PROJECT: "demo" },
    });
    const gemini = JSON.parse(readFileSync(path.join(repo, ".gemini/settings.json"), "utf8"));
    assert.deepEqual(gemini.contextFileName, ["AGENTS.md"]);
    const agy = JSON.parse(readFileSync(path.join(repo, ".agents", "mcp_config.json"), "utf8"));
    assert.deepEqual(agy.mcpServers["xdev-hive"], { command: "hive-mcp", args: [], env: { HIVE_AGENT: "antigravity", HIVE_PROJECT: "demo" } });
    assert.equal(statSync(path.join(repo, ".githooks/pre-commit")).mode & 0o111, 0o111);

    const second = installAgents(repo, "demo", { home, shim: SHIM });
    assert.ok(second.every((a) => a.action === "unchanged"), JSON.stringify(second));
  });

  it("drops the xdev-hive Hive wrote into .mcp.json but keeps the user's own", () => {
    const repo = gitRepo();
    const hive = { mcpServers: { "xdev-hive": { command: "hive-mcp", args: [], env: { HIVE_AGENT: "claude", HIVE_PROJECT: "demo" } }, other: { command: "x" } } };
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify(hive));
    const dropped = installAgents(repo, "demo", { home: tmp("home"), shim: SHIM }).find((a) => a.file === ".mcp.json")!;
    assert.equal(dropped.action, "removed");
    const left = JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8")).mcpServers;
    assert.deepEqual(Object.keys(left), ["other"]);

    const own = { mcpServers: { "xdev-hive": { command: "node", args: ["my-server.js"] } } };
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify(own));
    const kept = installAgents(repo, "demo", { home: tmp("home"), shim: SHIM }).find((a) => a.file === ".mcp.json")!;
    assert.equal(kept.action, "skipped");
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8")), own);
  });

  it("starts the shim and npx through cmd.exe on Windows", () => {
    const repo = gitRepo();
    const home = tmp("home");
    // codegraph is on for the repo: the local scope overrides the repo's plain npx entry, which other machines keep.
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { codegraph: CODEGRAPH_MCP } }));
    installAgents(repo, "demo", { home, shim: WIN_SHIM, platform: "win32" });
    const servers = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).projects[repo].mcpServers;
    assert.deepEqual(servers["xdev-hive"], {
      type: "stdio",
      command: "cmd",
      args: ["/c", WIN_SHIM],
      env: { HIVE_AGENT: "claude", HIVE_PROJECT: "demo" },
    });
    assert.deepEqual(servers.codegraph.args.slice(0, 3), ["/c", "npx", "-y"]);
    assert.equal(servers.codegraph.command, "cmd");
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8")).mcpServers.codegraph, CODEGRAPH_MCP, "the shared file stays portable");
    assert.match(readFileSync(path.join(home, ".codex/config.toml"), "utf8"), /command = "cmd"\nargs = \["\/c", "C:\\\\Users\\\\duy\\\\.xdev-hive\\\\bin\\\\hive-mcp.cmd"\]/);
  });

  it("keeps the user's Codex config and replaces only its own block", () => {
    const file = path.join(tmp("codex"), "config.toml");
    writeFileSync(file, '# my settings\nmodel = "gpt-5"\n');
    installCodexConfig(file, SHIM);
    installCodexConfig(file, SHIM);
    const text = readFileSync(file, "utf8");
    assert.match(text, /^# my settings\nmodel = "gpt-5"\n/);
    assert.equal(text.match(/\[mcp_servers\.xdev-hive\]/g)?.length, 1);
    assert.match(text, new RegExp(`command = "${SHIM}"`), "the shim by full path, not looked up on PATH");
    assert.match(text, /args = \[\]/, "Codex stdio MCP entries always declare args");
    assert.match(text, /\[mcp_servers\.xdev-hive\][\s\S]*default_tools_approval_mode = "approve"/, "Hive's tools need no approval in headless runs");
  });

  it("blocks direct commits of AGENTS.md but lets the Hive app commit", () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home"), shim: SHIM });
    writeFileSync(path.join(repo, "AGENTS.md"), "hand edit\n");
    sh(repo, "git", ["add", "AGENTS.md"]);
    assert.throws(() => sh(repo, "git", ["commit", "-qm", "sneaky"]), /được quản lý trong Hive/);
    sh(repo, "git", ["commit", "-qm", "via hive"], { HIVE_ADMIN: "1" });
  });

  it("guard hook blocks Claude edits of protected docs only", () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home"), shim: SHIM });
    const guard = path.join(repo, ".xdev-hive/guard-docs.sh");
    const run = (file: string) => {
      try {
        execFileSync(guard, [], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, stdio: ["pipe", "pipe", "pipe"] });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    assert.equal(run(path.join(repo, "AGENTS.md")), 2);
    assert.equal(run(path.join(repo, "docs/decisions.md")), 2);
    assert.equal(run(path.join(repo, "src/AGENTS.md.ts")), 0);
    assert.equal(run(path.join(repo, "packages/x/CLAUDE.md")), 0);
  });

  it("installs an executable hive-mcp shim", () => {
    const binDir = tmp("bin");
    const report = installShim({ electronPath: "/Applications/xDev Hive.app/Contents/MacOS/xDev Hive", entry: "/x/hive-mcp.mjs", binDir });
    const text = readFileSync(report.path, "utf8");
    assert.match(text, /ELECTRON_RUN_AS_NODE=1 exec '\/Applications\/xDev Hive.app\/Contents\/MacOS\/xDev Hive' '\/x\/hive-mcp.mjs' "\$@"/);
    assert.equal(statSync(report.path).mode & 0o111, 0o111);
  });

  it("treats an absolute core.hooksPath to the repo's .githooks as installed", () => {
    const repo = gitRepo();
    sh(repo, "git", ["config", "core.hooksPath", path.join(repo, ".githooks")]);
    const actions = installAgents(repo, "demo", { home: tmp("home"), shim: SHIM });
    assert.equal(actions.find((a) => a.file === "git config core.hooksPath")?.action, "unchanged");
  });

  it("recognises the repo's .githooks however core.hooksPath spells it", () => {
    const repo = path.resolve("/work/Repo");
    for (const value of [".githooks", "./.githooks", ".githooks/", path.join(repo, ".githooks")]) {
      assert.equal(isRepoHooksPath(repo, value, "linux"), true, value);
    }
    assert.equal(isRepoHooksPath(repo, path.join(repo.toLowerCase(), ".githooks"), "darwin"), true);
    assert.equal(isRepoHooksPath(repo, "", "linux"), false);
    assert.equal(isRepoHooksPath(repo, ".husky", "linux"), false);
    assert.equal(isRepoHooksPath(repo, path.resolve("/other/.githooks"), "linux"), false);
  });
});

describe("syncProject", () => {
  it("imports an existing AGENTS.md, renders shared docs and commits only doc files", async () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home"), shim: SHIM });
    writeFileSync(path.join(repo, "AGENTS.md"), "# Demo\nRun `npm test`.\n");
    sh(repo, "git", ["add", "AGENTS.md"]);
    sh(repo, "git", ["commit", "-qm", "agents"], { HIVE_ADMIN: "1" });
    writeFileSync(path.join(repo, "WIP.txt"), "unrelated work\n");
    sh(repo, "git", ["add", "WIP.txt"]);

    const hive = new SqliteHive(":memory:");
    hive.seed();
    const report = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });

    assert.deepEqual(report.imported, ["project/demo/agents"]);
    assert.deepEqual(report.files.map((f) => [f.file, f.action]), [
      ["AGENTS.md", "updated"],
      ["CLAUDE.md", "created"],
    ]);
    assert.ok(report.commit, report.note);
    const agents = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith(MANAGED_START));
    assert.match(agents, /Hive project key: `demo`/);
    assert.match(agents, /Agent protocol \(xDev Hive\)/);
    assert.match(agents, /# Demo\nRun `npm test`\./);
    assert.equal(readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    const committed = sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
    assert.deepEqual(committed, ["AGENTS.md", "CLAUDE.md"]);
    assert.match(sh(repo, "git", ["status", "--porcelain"]), /^A {2}WIP\.txt/m, "user's staged work untouched");

    const again = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    assert.ok(again.files.every((f) => f.action === "unchanged"));
    assert.equal(again.commit, null);
  });

  it("does not overwrite hand edits that were not committed", async () => {
    const repo = gitRepo();
    const hive = new SqliteHive(":memory:");
    hive.seed();
    await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    writeFileSync(path.join(repo, "AGENTS.md"), "local edit\n");
    await hive.call("docs.save", { key: "org/agent-protocol", content: "changed" }, admin);
    const report = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    assert.equal(report.files[0]!.action, "skipped");
    assert.equal(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "local edit\n");
    assert.ok(!existsSync(path.join(repo, "docs/decisions.md")));
  });

  it("leaves an AGENTS.md the repo owns alone and puts Hive's beside it (roadmap 38f)", async () => {
    const repo = gitRepo();
    const own = "# admin-portal\n309 dòng quy ước của repo.\n";
    const hive = new SqliteHive(":memory:");
    hive.seed();
    // The hub already has a page of its own, so the first sync does not import the file: it must not overwrite it.
    await hive.call("docs.save", { key: "project/demo/agents", content: "# demo\nChạy npm test.", baseVersion: 0 }, admin);
    writeFileSync(path.join(repo, "AGENTS.md"), own);
    sh(repo, "git", ["add", "AGENTS.md"]);
    sh(repo, "git", ["commit", "-qm", "own agents"], { HIVE_ADMIN: "1" });

    const report = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });

    assert.equal(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), own, "the repo's own file is never overwritten");
    assert.equal(report.ownAgents, true);
    assert.deepEqual(report.imported, [], "a page was already there, nothing imported");
    const agents = report.files.find((f) => f.file === "AGENTS.md")!;
    assert.equal(agents.action, "skipped");
    assert.match(agents.note ?? "", /repo có AGENTS\.md riêng, giữ nguyên; phần của Hive ghi vào \.xdev-hive\/context\/AGENTS\.md/);
    // Hive's part goes beside it and CLAUDE.md imports both, exactly as a run's worktree gets it.
    assert.match(readFileSync(path.join(repo, ".xdev-hive/context/AGENTS.md"), "utf8"), /Hive project key: `demo`[\s\S]*Chạy npm test\./);
    assert.equal(readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), "@AGENTS.md\n@.xdev-hive/context/AGENTS.md\n");
    const committed = sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
    assert.deepEqual(committed, [".xdev-hive/context/AGENTS.md", "CLAUDE.md"]);

    // The page catches up with the file: the repo no longer owns it, so the sync writes it and drops the copy.
    await hive.call("docs.save", { key: "project/demo/agents", content: own }, admin);
    const after = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    assert.equal(after.ownAgents, false);
    assert.equal(after.files.find((f) => f.file === "AGENTS.md")?.action, "updated");
    assert.ok(readFileSync(path.join(repo, "AGENTS.md"), "utf8").startsWith(MANAGED_START));
    assert.equal(after.files.find((f) => f.file === ".xdev-hive/context/AGENTS.md")?.action, "removed");
    assert.ok(!existsSync(path.join(repo, ".xdev-hive/context/AGENTS.md")));
    assert.equal(readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  });

  it("proposes the repo's own AGENTS.md into Hive, once (roadmap 38f)", async () => {
    const repo = gitRepo();
    const own = "# admin-portal\n309 dòng quy ước của repo.\n";
    const hive = new SqliteHive(":memory:");
    hive.seed();
    await hive.call("docs.save", { key: "project/demo/agents", content: "# demo\nChạy npm test.", baseVersion: 0 }, admin);
    writeFileSync(path.join(repo, "AGENTS.md"), own);

    const proposal = await proposeAgents(hive, admin, { name: "demo", repo });

    const page = await hive.call("docs.get", { key: "project/demo/agents" }, admin);
    assert.equal(proposal.docKey, "project/demo/agents");
    assert.equal(proposal.baseVersion, page!.version, "against the page as it is now");
    assert.equal(proposal.content, own.trim());
    assert.equal(page!.content, "# demo\nChạy npm test.", "the page waits for a human: nothing written yet");
    const open = await hive.call("proposals.list", { docKey: "project/demo/agents" }, admin);
    assert.deepEqual(open.map((p) => p.id), [proposal.id], "exactly one proposal");
  });
});

describe("docs for some paths in the repo", () => {
  it("writes nested AGENTS.md and rules, keeps the repo's own text, and cleans up when paths change", async () => {
    const repo = gitRepo();
    mkdirSync(path.join(repo, "apps/web"), { recursive: true });
    writeFileSync(path.join(repo, "apps/web/AGENTS.md"), "# Web\nOwn notes.\n");
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "web notes"]);
    const hive = new SqliteHive(":memory:");
    hive.seed();
    await hive.call("docs.save", { key: "project/demo/web", title: "Web", content: "Use shadcn/ui.", paths: ["apps/web/**"] }, admin);
    await hive.call("docs.save", { key: "project/demo/testing", title: "Testing", content: "Use node:test.", paths: ["**/*.test.ts"] }, admin);

    const first = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    assert.deepEqual(
      first.files.map((f) => [f.file, f.action]),
      [
        ["AGENTS.md", "created"],
        [".claude/rules/xdev-hive/testing.md", "created"],
        ["apps/web/AGENTS.md", "updated"],
        ["CLAUDE.md", "created"],
      ],
    );
    const web = readFileSync(path.join(repo, "apps/web/AGENTS.md"), "utf8");
    assert.ok(web.startsWith(MANAGED_START));
    assert.match(web, /Use shadcn\/ui\.[\s\S]*# Web\nOwn notes\.\n$/, "the block goes first, the repo's own text stays");
    assert.match(readFileSync(path.join(repo, ".claude/rules/xdev-hive/testing.md"), "utf8"), /^---\npaths:\n {2}- "\*\*\/\*\.test\.ts"\n---\n/);
    assert.match(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /`apps\/web\/\*\*`: `apps\/web\/AGENTS\.md`/);
    const committed = sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
    assert.deepEqual(committed, [".claude/rules/xdev-hive/testing.md", "AGENTS.md", "CLAUDE.md", "apps/web/AGENTS.md"]);

    // The web doc moves to the API folder and the testing doc covers the whole repo again.
    await hive.call("docs.save", { key: "project/demo/web", content: "Use shadcn/ui.", paths: ["apps/api/**"] }, admin);
    await hive.call("docs.save", { key: "project/demo/testing", content: "Use node:test.", paths: [] }, admin);
    const second = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    const actions = Object.fromEntries(second.files.map((f) => [f.file, f.action]));
    assert.equal(actions["apps/api/AGENTS.md"], "created");
    assert.equal(actions["apps/web/AGENTS.md"], "updated");
    assert.equal(actions[".claude/rules/xdev-hive/testing.md"], "removed");
    assert.equal(readFileSync(path.join(repo, "apps/web/AGENTS.md"), "utf8"), "# Web\nOwn notes.\n", "only our block went");
    assert.ok(!existsSync(path.join(repo, ".claude/rules/xdev-hive/testing.md")));
    assert.equal(sh(repo, "git", ["status", "--porcelain"]), "", "all committed, removal too");

    await hive.call("docs.save", { key: "project/demo/web", content: "Use shadcn/ui.", paths: [] }, admin);
    const third = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    assert.equal(third.files.find((f) => f.file === "apps/api/AGENTS.md")?.action, "removed", "a file that only had our block goes");
    assert.ok(!existsSync(path.join(repo, "apps/api/AGENTS.md")));
  });

  it("says when AGENTS.md gets long", async () => {
    const repo = gitRepo();
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "project/demo/agents", content: Array.from({ length: 250 }, (_, i) => `- rule ${i}`).join("\n") }, admin);
    const report = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: false });
    assert.match(report.note ?? "", /AGENTS\.md dài \d+ dòng/);
  });

  it("keeps agents off Hive's nested AGENTS.md and rules, but not off their own", () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home"), shim: SHIM });
    mkdirSync(path.join(repo, "apps/web"), { recursive: true });
    mkdirSync(path.join(repo, "apps/api"), { recursive: true });
    mkdirSync(path.join(repo, ".claude/rules/xdev-hive"), { recursive: true });
    mkdirSync(path.join(repo, ".xdev-hive/context"), { recursive: true });
    writeFileSync(path.join(repo, "apps/web/AGENTS.md"), `${MANAGED_START}\nHive part\n<!-- xdev-hive:end -->\n`);
    writeFileSync(path.join(repo, "apps/api/AGENTS.md"), "# API\nTeam notes.\n");
    writeFileSync(path.join(repo, ".claude/rules/xdev-hive/testing.md"), "rule\n");
    writeFileSync(path.join(repo, ".xdev-hive/context/AGENTS.md"), "Hive's part, beside the repo's own\n");
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "via hive"], { HIVE_ADMIN: "1" });

    const guard = path.join(repo, ".xdev-hive/guard-docs.sh");
    const run = (file: string) => {
      try {
        execFileSync(guard, [], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, stdio: ["pipe", "pipe", "pipe"] });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    assert.equal(run(path.join(repo, "apps/web/AGENTS.md")), 2);
    assert.equal(run(path.join(repo, ".claude/rules/xdev-hive/testing.md")), 2);
    assert.equal(run(path.join(repo, ".xdev-hive/context/AGENTS.md")), 2, "Hive's copy beside the repo's own AGENTS.md (roadmap 38f)");
    assert.equal(run(path.join(repo, "apps/api/AGENTS.md")), 0, "a nested AGENTS.md without the block is the team's");
    assert.equal(run(path.join(repo, ".claude/rules/own.md")), 0);

    // Taking the block out does not get the change past the commit hook either.
    writeFileSync(path.join(repo, "apps/web/AGENTS.md"), "hand edit\n");
    sh(repo, "git", ["add", "apps/web/AGENTS.md"]);
    assert.throws(() => sh(repo, "git", ["commit", "-qm", "sneaky"]), /apps\/web\/AGENTS\.md/);
    sh(repo, "git", ["reset", "-q", "--hard"]);
    writeFileSync(path.join(repo, ".claude/rules/xdev-hive/testing.md"), "changed\n");
    sh(repo, "git", ["add", "."]);
    assert.throws(() => sh(repo, "git", ["commit", "-qm", "sneaky"]), /xdev-hive\/testing\.md/);
    sh(repo, "git", ["reset", "-q", "--hard"]);
    writeFileSync(path.join(repo, ".xdev-hive/context/AGENTS.md"), "changed\n");
    sh(repo, "git", ["add", "."]);
    assert.throws(() => sh(repo, "git", ["commit", "-qm", "sneaky"]), /\.xdev-hive\/context\/AGENTS\.md/);
    sh(repo, "git", ["reset", "-q", "--hard"]);
    writeFileSync(path.join(repo, "apps/api/AGENTS.md"), "# API\nMore team notes.\n");
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "team notes"]);

    // The runner's own commit leaves them out as well, the tracked context file too, and without being told to.
    writeFileSync(path.join(repo, "apps/web/AGENTS.md"), "agent edit\n");
    writeFileSync(path.join(repo, ".claude/rules/xdev-hive/testing.md"), "agent edit\n");
    writeFileSync(path.join(repo, ".xdev-hive/context/AGENTS.md"), "agent edit\n");
    writeFileSync(path.join(repo, "work.txt"), "done\n");
    const c = commitAll(repo, "ai(T-1): work", []);
    assert.equal(c.error, null);
    assert.deepEqual(sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"), ["work.txt"]);
  });
});

describe("skills in the repo", () => {
  const skill = (name: string, description: string, body = `Steps for ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

  it("writes Hive's skills into .claude/skills, keeps the repo's own, and removes one that left Hive", async () => {
    const repo = gitRepo();
    mkdirSync(path.join(repo, ".claude/skills/deploy"), { recursive: true });
    writeFileSync(path.join(repo, ".claude/skills/deploy/SKILL.md"), skill("deploy", "The repo's own deploy steps."));
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "own skill"]);
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/skills/review-pr", content: skill("review-pr", "Team review.") }, admin);
    await hive.call("docs.save", { key: "project/demo/skills/deploy", content: skill("deploy", "Hive's deploy.") }, admin);
    await hive.call("docs.save", { key: "project/demo/skills/release", content: skill("release", "Cut a release.") }, admin);

    const first = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    const actions = Object.fromEntries(first.files.map((f) => [f.file, [f.action, f.note ?? ""]]));
    assert.deepEqual(actions[".claude/skills/review-pr/SKILL.md"], ["created", ""]);
    assert.deepEqual(actions[".claude/skills/release/SKILL.md"], ["created", ""]);
    assert.deepEqual(actions[".claude/skills/deploy/SKILL.md"], ["skipped", "repo đã có skill cùng tên của riêng nó, giữ nguyên"]);
    assert.match(readFileSync(path.join(repo, ".claude/skills/deploy/SKILL.md"), "utf8"), /The repo's own deploy steps/);
    const release = readFileSync(path.join(repo, ".claude/skills/release/SKILL.md"), "utf8");
    assert.ok(release.startsWith("---\nname: release\n"), "front matter first, as Claude Code reads it");
    assert.match(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /## Skills[\s\S]*- `release`: Cut a release\.\n- `review-pr`: Team review\./);
    const committed = sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
    assert.deepEqual(committed, [".claude/skills/release/SKILL.md", ".claude/skills/review-pr/SKILL.md", "AGENTS.md", "CLAUDE.md"]);

    // The release skill leaves Hive: its file and folder go, the repo's own deploy skill stays.
    hive.db.prepare("DELETE FROM docs WHERE key = ?").run("project/demo/skills/release");
    const second = await syncProject(hive, admin, { name: "demo", repo }, { autoCommit: true });
    assert.equal(second.files.find((f) => f.file === ".claude/skills/release/SKILL.md")?.action, "removed");
    assert.ok(!existsSync(path.join(repo, ".claude/skills/release")), "the folder too");
    assert.ok(existsSync(path.join(repo, ".claude/skills/deploy/SKILL.md")));
    assert.equal(sh(repo, "git", ["status", "--porcelain"]), "", "the removal is committed");
  });

  it("keeps agents off Hive's skills, but not off the repo's own", () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home"), shim: SHIM });
    mkdirSync(path.join(repo, ".claude/skills/review-pr"), { recursive: true });
    mkdirSync(path.join(repo, ".claude/skills/own"), { recursive: true });
    writeFileSync(path.join(repo, ".claude/skills/review-pr/SKILL.md"), `---\nname: review-pr\ndescription: x\n---\n${MANAGED_START}\nHive steps\n<!-- xdev-hive:end -->\n`);
    writeFileSync(path.join(repo, ".claude/skills/own/SKILL.md"), skill("own", "Team's own."));
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "via hive"], { HIVE_ADMIN: "1" });

    const guard = path.join(repo, ".xdev-hive/guard-docs.sh");
    const run = (file: string) => {
      try {
        execFileSync(guard, [], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, stdio: ["pipe", "pipe", "pipe"] });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    assert.equal(run(path.join(repo, ".claude/skills/review-pr/SKILL.md")), 2);
    assert.equal(run(path.join(repo, ".claude/skills/own/SKILL.md")), 0, "a skill without the block is the team's");

    writeFileSync(path.join(repo, ".claude/skills/review-pr/SKILL.md"), "hand edit\n");
    sh(repo, "git", ["add", "."]);
    assert.throws(() => sh(repo, "git", ["commit", "-qm", "sneaky"]), /\.claude\/skills\/review-pr\/SKILL\.md/);
    sh(repo, "git", ["reset", "-q", "--hard"]);

    writeFileSync(path.join(repo, ".claude/skills/review-pr/SKILL.md"), "agent edit\n");
    writeFileSync(path.join(repo, ".claude/skills/own/SKILL.md"), skill("own", "Team's own, better."));
    const c = commitAll(repo, "ai(T-1): work", []);
    assert.equal(c.error, null);
    assert.deepEqual(sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"), [".claude/skills/own/SKILL.md"], "the runner commits the team's skill, not Hive's");
  });
});

describe("Hive context in a working copy (roadmap 38a)", () => {
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`;

  /** A hub with one doc of each kind a repo gets: AGENTS.md, a rule for globs without a folder, and a skill. */
  async function hub(): Promise<SqliteHive> {
    const hive = new SqliteHive(":memory:");
    hive.seed();
    await hive.call("docs.save", { key: "project/demo/agents", content: "# demo\nChạy npm test.", baseVersion: 0 }, admin);
    await hive.call("docs.save", { key: "project/demo/testing", title: "Testing", content: "Use node:test.", paths: ["**/*.test.ts"] }, admin);
    await hive.call("docs.save", { key: "project/demo/skills/release", content: skill("release", "Cut a release.") }, admin);
    return hive;
  }

  it("writes the project's context into a folder without touching the hub's copy of the repo", async () => {
    const hive = await hub();
    const dir = gitRepo();
    const out = await renderContext(hive, admin, "demo", dir);

    assert.deepEqual(out.owned, ["AGENTS.md", ".claude/rules/xdev-hive/testing.md", ".claude/skills/release/SKILL.md", "CLAUDE.md"]);
    assert.deepEqual(out.written, out.owned, "nothing was there yet");
    assert.deepEqual(out.skipped, []);
    assert.equal(out.contextFile, null);
    assert.deepEqual(out.skills, [{ name: "release", description: "Cut a release.", path: ".claude/skills/release/SKILL.md" }]);
    assert.deepEqual(out.rules, [{ globs: ["**/*.test.ts"], path: ".claude/rules/xdev-hive/testing.md" }]);
    assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Hive project key: `demo`[\s\S]*Chạy npm test\./);
    assert.equal(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.match(readFileSync(path.join(dir, ".claude/rules/xdev-hive/testing.md"), "utf8"), /^---\npaths:\n {2}- "\*\*\/\*\.test\.ts"\n---\n/);
    assert.ok(readFileSync(path.join(dir, ".claude/skills/release/SKILL.md"), "utf8").startsWith("---\nname: release\n"));

    // Run again: the same files, none of them written a second time.
    const again = await renderContext(hive, admin, "demo", dir);
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.owned, out.owned);
  });

  it("keeps the repo's own AGENTS.md, nested AGENTS.md and skill, and puts Hive's beside them", async () => {
    const hive = await hub();
    await hive.call("docs.save", { key: "project/demo/web", title: "Web", content: "Use shadcn/ui.", paths: ["apps/web/**"] }, admin);
    await hive.call("docs.save", { key: "project/demo/skills/deploy", content: skill("deploy", "Hive's deploy.") }, admin);
    const dir = gitRepo();
    const own = "# demo\n309 dòng quy ước của repo.\n";
    writeFileSync(path.join(dir, "AGENTS.md"), own);
    mkdirSync(path.join(dir, "apps/web"), { recursive: true });
    writeFileSync(path.join(dir, "apps/web/AGENTS.md"), "# Web\nOwn notes.\n");
    mkdirSync(path.join(dir, ".claude/skills/deploy"), { recursive: true });
    writeFileSync(path.join(dir, ".claude/skills/deploy/SKILL.md"), skill("deploy", "The repo's own deploy steps."));
    writeFileSync(path.join(dir, "CLAUDE.md"), "Be brief.\n");

    const out = await renderContext(hive, admin, "demo", dir);

    assert.equal(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), own, "the repo's own file is never overwritten");
    assert.equal(readFileSync(path.join(dir, "apps/web/AGENTS.md"), "utf8"), "# Web\nOwn notes.\n");
    assert.match(readFileSync(path.join(dir, ".claude/skills/deploy/SKILL.md"), "utf8"), /The repo's own deploy steps/);
    assert.deepEqual(out.skills, [
      { name: "deploy", description: "The repo's own deploy steps.", path: ".claude/skills/deploy/SKILL.md" },
      { name: "release", description: "Cut a release.", path: ".claude/skills/release/SKILL.md" },
    ]);
    assert.deepEqual(out.skipped.map((s) => s.file), ["AGENTS.md", "apps/web/AGENTS.md", ".claude/skills/deploy/SKILL.md"]);
    assert.match(out.skipped[0]!.note, /^repo có AGENTS\.md riêng, giữ nguyên; phần của Hive ghi vào \.xdev-hive\/context\/AGENTS\.md$/);
    // Hive's goes beside it, and CLAUDE.md imports both: Claude Code reads it, and the prompt names it for the rest.
    assert.equal(out.contextFile, ".xdev-hive/context/AGENTS.md");
    assert.match(readFileSync(path.join(dir, ".xdev-hive/context/AGENTS.md"), "utf8"), /Hive project key: `demo`/);
    assert.equal(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n@.xdev-hive/context/AGENTS.md\n\nBe brief.\n");
  });

  it("gives up on a hub that does not answer, so the run goes on with the files of the branch", async () => {
    const slow: HiveBackend = { call: () => new Promise(() => undefined) };
    const dir = gitRepo();
    await assert.rejects(renderContext(slow, admin, "demo", dir, 20), /hub không trả lời trong 0 giây/);
    assert.ok(!existsSync(path.join(dir, "AGENTS.md")), "nothing half-written");
  });
});

describe("agent CLI config in a task worktree", () => {
  // What Codex wrote into the AUTH-5 worktree of the xdev-auth pilot (29/9), from the repo's Claude Code setup.
  const writeCliConfig = (repo: string) => {
    mkdirSync(path.join(repo, ".codex"), { recursive: true });
    mkdirSync(path.join(repo, ".agents/skills/x"), { recursive: true });
    writeFileSync(path.join(repo, ".codex/config.toml"), '[mcp_servers.xdev-hive]\ncommand = "hive-mcp"\n');
    writeFileSync(path.join(repo, ".codex/hooks.json"), '{"hooks":{}}\n');
    writeFileSync(path.join(repo, ".agents/skills/x/SKILL.md"), "---\nname: x\ndescription: x\n---\nSteps.\n");
  };
  const committed = (repo: string) => sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();

  it("leaves out the .codex and .agents folders a CLI wrote, and commits the agent's work", () => {
    const repo = gitRepo();
    writeCliConfig(repo);
    writeFileSync(path.join(repo, "work.txt"), "done\n");
    const c = commitAll(repo, "ai(T-1): work", []);
    assert.equal(c.error, null);
    assert.deepEqual(committed(repo), ["work.txt"]);
    assert.match(sh(repo, "git", ["status", "--porcelain", "--untracked-files=all"]), /\?\? \.codex\/config\.toml/, "still on disk, just not committed");

    // Nothing but those files left: no empty commit.
    const before = sh(repo, "git", ["rev-parse", "HEAD"]).trim();
    assert.deepEqual(commitAll(repo, "ai(T-1): again", []), { sha: null, error: null });
    assert.equal(sh(repo, "git", ["rev-parse", "HEAD"]).trim(), before);
  });

  it("commits when the repo already ignores a folder it leaves out (git 2.54 refused the whole add)", () => {
    const repo = gitRepo();
    writeFileSync(path.join(repo, ".gitignore"), ".codegraph/\n");
    sh(repo, "git", ["add", ".gitignore"]);
    sh(repo, "git", ["commit", "-qm", "ignore codegraph"]);
    mkdirSync(path.join(repo, ".codegraph"), { recursive: true });
    writeFileSync(path.join(repo, ".codegraph/codegraph.db"), "db\n");
    writeFileSync(path.join(repo, "work.txt"), "done\n");
    const c = commitAll(repo, "ai(T-1): work", []);
    assert.equal(c.error, null);
    assert.deepEqual(committed(repo), ["work.txt"]);
  });

  it("commits them as usual in a project that tracks those folders", () => {
    const repo = gitRepo();
    mkdirSync(path.join(repo, ".codex"), { recursive: true });
    mkdirSync(path.join(repo, ".agents/skills/own"), { recursive: true });
    writeFileSync(path.join(repo, ".codex/config.toml"), 'model = "gpt-5"\n');
    writeFileSync(path.join(repo, ".agents/skills/own/SKILL.md"), "---\nname: own\ndescription: own\n---\nOwn steps.\n");
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "team's Codex setup"]);

    writeCliConfig(repo);
    const c = commitAll(repo, "ai(T-1): work", []);
    assert.equal(c.error, null);
    assert.deepEqual(committed(repo), [".agents/skills/x/SKILL.md", ".codex/config.toml", ".codex/hooks.json"]);
  });
});

describe("where a new task branch starts", () => {
  const head = (dir: string) => sh(dir, "git", ["rev-parse", "HEAD"]).trim();
  const commit = (dir: string, file: string, message: string) => {
    writeFileSync(path.join(dir, file), `${message}\n`);
    sh(dir, "git", ["add", "."]);
    sh(dir, "git", ["commit", "-qm", message]);
  };

  /** A bare repo as the team's remote, the user's clone of it, and a merge the clone has not pulled yet (AUTH-5, 29/9). */
  function cloneBehind() {
    const origin = tmp("origin");
    sh(origin, "git", ["init", "-q", "--bare", "-b", "main"]);
    const team = gitRepo();
    sh(team, "git", ["remote", "add", "origin", origin]);
    sh(team, "git", ["push", "-q", "origin", "main"]);
    const repo = tmp("clone");
    sh(repo, "git", ["clone", "-q", origin, "."]);
    sh(repo, "git", ["config", "user.email", "test@example.com"]);
    sh(repo, "git", ["config", "user.name", "Test"]);
    commit(team, "merged.txt", "merged on the remote");
    sh(team, "git", ["push", "-q", "origin", "main"]);
    return { team, repo, merged: head(team), local: head(repo) };
  }

  it("starts from the target branch as the remote has it now, and leaves the checkout alone", async () => {
    const { repo, merged, local } = cloneBehind();
    writeFileSync(path.join(repo, "wip.txt"), "the user's own work\n");
    const start = await remoteStart(repo, undefined);
    assert.equal(start.ref, "refs/remotes/origin/main");
    assert.match(start.note, new RegExp(merged.slice(0, 7)));

    // An earlier run of the task recorded a base; its branch is gone, so the new branch's own start wins.
    const wt = ensureWorktree(repo, path.join(tmp("wt"), "T-1"), "T-1", local, { start: start.ref! });
    assert.equal(head(wt.path), merged);
    assert.equal(wt.baseSha, merged);
    assert.ok(existsSync(path.join(wt.path, "merged.txt")));
    // The user's checkout: same commit, same branch, their file untouched.
    assert.equal(head(repo), local);
    assert.equal(sh(repo, "git", ["branch", "--show-current"]).trim(), "main");
    assert.match(sh(repo, "git", ["status", "--porcelain"]), /\?\? wip\.txt/);
  });

  it("fetches the target branch the project names", async () => {
    const { team, repo } = cloneBehind();
    sh(team, "git", ["checkout", "-q", "-b", "develop"]);
    commit(team, "develop.txt", "on develop");
    sh(team, "git", ["push", "-q", "origin", "develop"]);
    const start = await remoteStart(repo, "develop");
    assert.equal(start.ref, "refs/remotes/origin/develop");
    assert.equal(sh(repo, "git", ["rev-parse", start.ref!]).trim(), head(team));
  });

  it("keeps an existing task branch where it is", async () => {
    const { repo, local } = cloneBehind();
    sh(repo, "git", ["branch", "ai/T-2", "HEAD"]);
    const start = await remoteStart(repo, undefined);
    const wt = ensureWorktree(repo, path.join(tmp("wt"), "T-2"), "T-2", local, { start: start.ref! });
    assert.equal(head(wt.path), local, "a follow-up or review goes on from the task's own branch");
    assert.equal(wt.baseSha, local);
  });

  it("starts from the checkout's HEAD without a remote, or when the fetch fails", async () => {
    const repo = gitRepo();
    const local = head(repo);
    const none = await remoteStart(repo, undefined);
    assert.equal(none.ref, null);
    assert.match(none.note, new RegExp(local.slice(0, 7)));
    const wt = ensureWorktree(repo, path.join(tmp("wt"), "T-3"), "T-3", null, { start: none.ref ?? undefined });
    assert.equal(head(wt.path), local);

    sh(repo, "git", ["remote", "add", "origin", path.join(tmp("gone"), "missing.git")]);
    const failed = await remoteStart(repo, "main");
    assert.equal(failed.ref, null);
    assert.notEqual(failed.note, none.note, "says the fetch failed, not that there is no remote");
    assert.match(failed.note, /origin/);
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
