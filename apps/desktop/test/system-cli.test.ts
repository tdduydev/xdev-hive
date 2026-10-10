import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_TEMPLATES, type DesktopProject, type Doc, type HiveSystem } from "@xdev-hive/core";
import { cliCommand, EXTRA_DIR_ARGS } from "#desktop/main/cli-open.ts";
import { commonParent, contextIsOurs, renderSystemContext, repoRole, SYSTEM_CONTEXT_MARK, systemWorkspace, writeSystemContext } from "#desktop/main/system-cli.ts";
import { terminalScript } from "#desktop/main/terminal.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hive-system-cli-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const member = (project: string, p: string) => ({ project, pathWithNamespace: `ehospital-ai/${p}`, sshUrl: `git@gitlab.x:ehospital-ai/${p}.git`, httpUrl: `https://gitlab.x/ehospital-ai/${p}.git`, defaultBranch: "main", state: "active" as const });
const system = (members = [member("his-service", "his/backend/his-service"), member("his-portal", "his/frontend/his-portal"), member("infa", "deploy/infa")]): HiveSystem => ({
  name: "ehospital-ai",
  projects: members.map((m) => m.project),
  source: { forge: "gitlab", url: "https://gitlab.x", groupPath: "ehospital-ai", syncedAt: null, members },
  updatedAt: "",
  updatedBy: "",
});
/** The group's tree on disk under `root`, with the repos given. */
function tree(root: string, repos: Record<string, string>): DesktopProject[] {
  return Object.entries(repos).map(([name, rel]) => {
    const repo = path.join(root, ...rel.split("/"));
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    return { name, repo };
  });
}
const notRepo = () => false;

describe("a CLI over a whole system (GROUP-cli)", () => {
  it("the common folder of the repos, but never a drive's root or the home folder", () => {
    // resolve, not join: commonParent resolves its input, which on Windows puts the drive in front.
    const home = path.resolve(path.sep, "Users", "duy");
    assert.equal(commonParent([path.join(home, "Codes", "ehs", "his", "a"), path.join(home, "Codes", "ehs", "deploy", "b")], home), path.join(home, "Codes", "ehs"));
    assert.equal(commonParent([path.join(home, "a"), path.join(home, "b")], home), null, "only the home folder");
    assert.equal(commonParent([path.join(path.sep, "a"), path.join(path.sep, "b")], home), null, "only the root");
  });

  it("starts in the group's root with every repo here, and lists the ones missing", () => {
    const root = path.join(tmp(), "Codes", "ehospital-ai");
    const projects = tree(root, { "his-service": "his/backend/his-service", infa: "deploy/infa" });
    const ws = systemWorkspace(system(), projects, { home: os.homedir(), sessionDir: path.join(tmp(), "session"), insideRepo: notRepo });
    assert.equal(ws.cwd, root, "found from the tree, without having set the group up");
    assert.deepEqual(ws.repos.map((r) => [r.project, r.folder.join("/")]), [["infa", "deploy"], ["his-service", "his/backend"]]);
    assert.deepEqual(ws.missing, [{ project: "his-portal", pathWithNamespace: "ehospital-ai/his/frontend/his-portal" }]);
  });

  it("keeps the context out of every repo: a root inside a repo, someone else's AGENTS.md, or one repo only", () => {
    const root = path.join(tmp(), "ehospital-ai");
    const projects = tree(root, { "his-service": "his/backend/his-service", infa: "deploy/infa" });
    const sessionDir = path.join(tmp(), "session");
    assert.equal(systemWorkspace(system(), projects, { home: os.homedir(), sessionDir, insideRepo: (d) => d === root }).cwd, sessionDir, "the group folder with git init");
    writeFileSync(path.join(root, "AGENTS.md"), "# Our own notes\n");
    assert.equal(systemWorkspace(system(), projects, { home: os.homedir(), sessionDir, insideRepo: notRepo }).cwd, sessionDir, "a person's AGENTS.md stays theirs");
    rmSync(path.join(root, "AGENTS.md"));
    const flat = tree(tmp(), { "his-service": "his-service" });
    assert.equal(systemWorkspace(system(), flat, { home: os.homedir(), sessionDir, insideRepo: notRepo }).cwd, sessionDir, "one repo: not its working tree");
    // The root this machine set the group up in wins over a guess.
    const chosen = tmp();
    assert.equal(systemWorkspace(system(), projects, { root: chosen, home: os.homedir(), sessionDir, insideRepo: notRepo }).cwd, chosen);
  });

  it("writes the system's context: each repo's key, folder and role, the missing ones, then the system's and team's docs", () => {
    const root = path.join(tmp(), "ehospital-ai");
    const projects = tree(root, { "his-service": "his/backend/his-service" });
    const ws = systemWorkspace(system(), projects, { home: os.homedir(), sessionDir: tmp(), insideRepo: notRepo });
    const doc = (key: string, content: string, includeInAgents = true): Doc => ({ key, title: key, content, version: 2, includeInAgents, paths: [] } as unknown as Doc);
    const md = renderSystemContext(system(), ws, { system: [doc("system/ehospital-ai/api", "API contract: REST over /api/v1"), doc("system/ehospital-ai/draft", "not for agents", false)], org: [doc("org/protocol", "Claim a task first.")] }, {
      "his-service": repoRole(doc("project/his-service/agents", "# his-service\n\n> Hive project key\n\nHIS backend (Spring Boot).")),
    });
    assert.ok(md.startsWith(SYSTEM_CONTEXT_MARK));
    assert.match(md, /Hive system: `ehospital-ai`/);
    assert.match(md, /\| `his-service` \| `.*his-service` \| `his\/backend` \| HIS backend \(Spring Boot\)\. \|/);
    assert.match(md, /## Repos missing on this machine\n\n- `infa` \(`ehospital-ai\/deploy\/infa`\)\n- `his-portal` \(`ehospital-ai\/his\/frontend\/his-portal`\)/, "in the group's tree order");
    assert.match(md, /API contract: REST/);
    assert.doesNotMatch(md, /not for agents/);
    assert.match(md, /Claim a task first\./);

    const written = writeSystemContext(root, md, { mcpServers: { "xdev-hive": { command: "/x/hive-mcp", env: { HIVE_SYSTEM: "ehospital-ai" } } } });
    assert.deepEqual(written.sort(), [".gemini/settings.json".split("/").join(path.sep), "AGENTS.md", "CLAUDE.md"].sort());
    assert.equal(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".gemini", "settings.json"), "utf8")).contextFileName, ["AGENTS.md"]);
    assert.equal(contextIsOurs(root), true, "the next session may rewrite them");
    assert.deepEqual(writeSystemContext(root, md, { mcpServers: {} }).filter((f) => f === "AGENTS.md"), [], "unchanged: not written again");
    writeFileSync(path.join(root, "CLAUDE.md"), "my own\n");
    assert.deepEqual(writeSystemContext(root, `${md}x`, { mcpServers: {} }), [], "someone else's file: nothing is touched");
  });

  it("gives each CLI the repos its own way, with Hive's server for the system", () => {
    const opts = { project: "his-service", repo: "/ehs", bin: "/bin/x", path: "/usr/bin", shim: "/bin/hive-mcp", mcpFile: "/m.json", title: "t", done: "d", system: "ehospital-ai", extraDirs: ["/ehs/his/backend/his-service", "/ehs/deploy/infa"] };
    const claude = cliCommand({ ...AGENT_TEMPLATES.claude, id: "claude-1" }, opts);
    assert.deepEqual(claude.command.args, ["--mcp-config", "/m.json", "--add-dir", "/ehs/his/backend/his-service", "--add-dir", "/ehs/deploy/infa"]);
    assert.deepEqual(JSON.parse(claude.mcpConfig!).mcpServers["xdev-hive"].env, { HIVE_AGENT: "claude-1", HIVE_SYSTEM: "ehospital-ai" }, "no HIVE_PROJECT: tools take project");
    assert.equal(claude.command.env.HIVE_PROJECT, undefined);
    assert.deepEqual(claude.command.unsetEnv, ["HIVE_PROJECT"], "one inherited from the app's env is cleared");
    assert.match(terminalScript("win32", claude.command).content, /^set "HIVE_PROJECT="\r$/m);
    assert.equal(cliCommand({ ...AGENT_TEMPLATES.claude, id: "claude-1" }, { ...opts, system: undefined }).command.unsetEnv, undefined, "a project's session keeps its own");
    assert.equal(claude.command.cwd, "/ehs");
    const codex = cliCommand({ ...AGENT_TEMPLATES.codex, id: "codex-1" }, opts);
    assert.deepEqual(codex.command.args.slice(-4), ["--add-dir", "/ehs/his/backend/his-service", "--add-dir", "/ehs/deploy/infa"]);
    assert.ok(codex.command.args.includes("mcp_servers.xdev-hive.env={HIVE_AGENT='codex-1',HIVE_SYSTEM='ehospital-ai'}"));
    assert.deepEqual(cliCommand({ ...AGENT_TEMPLATES.gemini, id: "gemini-1" }, opts).command.args, ["--include-directories", "/ehs/his/backend/his-service", "--include-directories", "/ehs/deploy/infa"]);
    assert.deepEqual(cliCommand({ ...AGENT_TEMPLATES.copilot, id: "copilot-1" }, opts).command.args.slice(-2), ["--add-dir", "/ehs/deploy/infa"]);
    // No flag for more folders: it sees the working folder and what is under it, and the page says so.
    const opencode = cliCommand({ ...AGENT_TEMPLATES.opencode, id: "opencode-1" }, opts);
    assert.ok(!opencode.command.args.some((a) => a.includes("/ehs/")));
    assert.equal(EXTRA_DIR_ARGS.opencode, undefined);
    // The per-project button is as it was.
    const one = cliCommand({ ...AGENT_TEMPLATES.claude, id: "claude-1" }, { ...opts, system: undefined, extraDirs: undefined, repo: "/ehs/his/backend/his-service" });
    assert.deepEqual(one.command.args, ["--mcp-config", "/m.json"]);
    assert.equal(one.command.env.HIVE_PROJECT, "his-service");
  });
});
