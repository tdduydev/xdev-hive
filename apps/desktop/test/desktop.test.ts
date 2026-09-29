import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MANAGED_START, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { installAgents, installCodexConfig, installShim } from "../src/main/installer.ts";
import { commitAll } from "../src/main/runner/worktree.ts";
import { syncProject } from "../src/main/sync.ts";

const admin: Actor = { name: "duy", role: "admin" };
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-${p}-`));
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

describe("installAgents", () => {
  it("wires Claude, Gemini and Codex and is idempotent", () => {
    const repo = gitRepo();
    const home = tmp("home");
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const first = installAgents(repo, "demo", { home });
    assert.deepEqual(
      first.map((a) => [a.file, a.action]),
      [
        [".mcp.json", "updated"],
        [".gemini/settings.json", "created"],
        [".claude/settings.json", "created"],
        [".xdev-hive/guard-docs.sh", "created"],
        [".githooks/pre-commit", "created"],
        ["git config core.hooksPath", "updated"],
        ["~/.codex/config.toml", "created"],
      ],
    );
    const mcp = JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.other, "keeps existing servers");
    assert.deepEqual(mcp.mcpServers["xdev-hive"], { command: "hive-mcp", args: [], env: { HIVE_AGENT: "claude", HIVE_PROJECT: "demo" } });
    const gemini = JSON.parse(readFileSync(path.join(repo, ".gemini/settings.json"), "utf8"));
    assert.deepEqual(gemini.contextFileName, ["AGENTS.md"]);
    assert.equal(statSync(path.join(repo, ".githooks/pre-commit")).mode & 0o111, 0o111);

    const second = installAgents(repo, "demo", { home });
    assert.ok(second.every((a) => a.action === "unchanged"), JSON.stringify(second));
  });

  it("keeps the user's Codex config and replaces only its own block", () => {
    const file = path.join(tmp("codex"), "config.toml");
    writeFileSync(file, '# my settings\nmodel = "gpt-5"\n');
    installCodexConfig(file);
    installCodexConfig(file);
    const text = readFileSync(file, "utf8");
    assert.match(text, /^# my settings\nmodel = "gpt-5"\n/);
    assert.equal(text.match(/\[mcp_servers\.xdev-hive\]/g)?.length, 1);
    assert.match(text, /\[mcp_servers\.xdev-hive\][\s\S]*default_tools_approval_mode = "approve"/, "Hive's tools need no approval in headless runs");
  });

  it("blocks direct commits of AGENTS.md but lets the Hive app commit", () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home") });
    writeFileSync(path.join(repo, "AGENTS.md"), "hand edit\n");
    sh(repo, "git", ["add", "AGENTS.md"]);
    assert.throws(() => sh(repo, "git", ["commit", "-qm", "sneaky"]), /được quản lý trong Hive/);
    sh(repo, "git", ["commit", "-qm", "via hive"], { HIVE_ADMIN: "1" });
  });

  it("guard hook blocks Claude edits of protected docs only", () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home") });
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
});

describe("syncProject", () => {
  it("imports an existing AGENTS.md, renders shared docs and commits only doc files", async () => {
    const repo = gitRepo();
    installAgents(repo, "demo", { home: tmp("home") });
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
    installAgents(repo, "demo", { home: tmp("home") });
    mkdirSync(path.join(repo, "apps/web"), { recursive: true });
    mkdirSync(path.join(repo, "apps/api"), { recursive: true });
    mkdirSync(path.join(repo, ".claude/rules/xdev-hive"), { recursive: true });
    writeFileSync(path.join(repo, "apps/web/AGENTS.md"), `${MANAGED_START}\nHive part\n<!-- xdev-hive:end -->\n`);
    writeFileSync(path.join(repo, "apps/api/AGENTS.md"), "# API\nTeam notes.\n");
    writeFileSync(path.join(repo, ".claude/rules/xdev-hive/testing.md"), "rule\n");
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
    writeFileSync(path.join(repo, "apps/api/AGENTS.md"), "# API\nMore team notes.\n");
    sh(repo, "git", ["add", "."]);
    sh(repo, "git", ["commit", "-qm", "team notes"]);

    // The runner's own commit leaves them out as well.
    writeFileSync(path.join(repo, "apps/web/AGENTS.md"), "agent edit\n");
    writeFileSync(path.join(repo, ".claude/rules/xdev-hive/testing.md"), "agent edit\n");
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
    installAgents(repo, "demo", { home: tmp("home") });
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
