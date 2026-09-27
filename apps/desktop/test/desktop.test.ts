import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MANAGED_START, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { installAgents, installCodexConfig, installShim } from "../src/main/installer.ts";
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
