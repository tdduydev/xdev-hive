import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_TEMPLATES, worktreeCleanupSchema, type Actor, type DesktopProject, type MachineProjectCommand, type RunnerSettings } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { Runner, type RunnerHost } from "#desktop/main/runner/runner.ts";
import { isGitRepo, isRepoRoot, remoteUrl } from "#desktop/main/git.ts";
import { applyProjectCommand, type ProjectCommandDeps } from "#desktop/main/machine-projects.ts";

const tmpDirs = new Set<string>();
after(() => { for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "hive-machine-projects-")); tmpDirs.add(dir); return dir; };
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

function repoAt(dir: string, origin?: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-qm", "init"]);
  if (origin) sh(dir, ["remote", "add", "origin", origin]);
  return dir;
}

let n = 0;
const command = (order: Partial<MachineProjectCommand> & Pick<MachineProjectCommand, "op" | "project">): MachineProjectCommand => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, repo: null, gitlabProject: null, cloneUrl: null,
  requestedBy: "admin", requestedAt: new Date().toISOString(), completedAt: null, ok: null, error: null, ...order,
});

/** The app's config as a list, with real git checks and a clone that copies a local repository instead of the network. */
function fakeApp(initial: DesktopProject[] = [], source?: string) {
  let projects = [...initial];
  const clones: Array<{ url: string; dir: string }> = [];
  const busy = new Set<string>();
  const deps: ProjectCommandDeps = {
    projects: () => projects,
    add: (p) => { projects = [...projects, p]; },
    remove: (name) => { projects = projects.filter((p) => p.name !== name); },
    isRepo: (dir) => isRepoRoot(dir) && isGitRepo(dir),
    remote: remoteUrl,
    clone: async (url, dir) => {
      clones.push({ url, dir });
      if (!source) throw new Error("fatal: repository not found");
      sh(path.dirname(dir), ["clone", "-q", source, dir]);
      sh(dir, ["remote", "set-url", "origin", url]);
    },
    busy: (name) => busy.has(name),
  };
  return { deps, clones, busy, get projects() { return projects; } };
}

describe("project commands from the hub (ADM-machine-projects)", () => {
  it("adds an existing repository whose origin matches, without cloning", async () => {
    const root = tmp();
    const dir = repoAt(path.join(root, "member-a"), "git@gitlab.example.com:group/member-a.git");
    const app = fakeApp();
    const result = await applyProjectCommand(command({ op: "add", project: "member-a", repo: dir, gitlabProject: "group/member-a" }), app.deps);
    assert.deepEqual([result.ok, result.error], [true, null]);
    assert.deepEqual(app.projects, [{ name: "member-a", repo: dir, gitlabProject: "group/member-a" }]);
    assert.equal(app.clones.length, 0);
    // The same order again (its answer was lost) changes nothing and still reports success.
    assert.equal((await applyProjectCommand(command({ op: "add", project: "member-a", repo: dir }), app.deps)).ok, true);
    assert.equal(app.projects.length, 1);
  });

  it("refuses a folder whose origin is another repository, or that is no repository", async () => {
    const root = tmp();
    const dir = repoAt(path.join(root, "member-a"), "git@gitlab.example.com:group/other.git");
    const app = fakeApp();
    const wrong = await applyProjectCommand(command({ op: "add", project: "member-a", repo: dir, gitlabProject: "group/member-a" }), app.deps);
    assert.equal(wrong.ok, false);
    assert.match(wrong.error!, /group\/other/);
    const wrongUrl = await applyProjectCommand(command({ op: "add", project: "member-a", repo: dir, cloneUrl: "https://gitlab.example.com/group/member-a.git" }), app.deps);
    assert.equal(wrongUrl.ok, false);
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    const notGit = await applyProjectCommand(command({ op: "add", project: "plain", repo: plain }), app.deps);
    assert.equal(notGit.ok, false);
    assert.match(notGit.error!, /not a git repository/);
    assert.deepEqual(app.projects, []);
  });

  it("clones into a missing folder, then adds it; without a clone URL it says why", async () => {
    const root = tmp();
    const source = repoAt(path.join(root, "source"));
    const app = fakeApp([], source);
    const dir = path.join(root, "work", "group", "member-b");
    const missing = await applyProjectCommand(command({ op: "add", project: "member-b", repo: dir }), app.deps);
    assert.equal(missing.ok, false);
    assert.match(missing.error!, /does not exist/);
    const url = "git@gitlab.example.com:group/member-b.git";
    // A clone URL that is not the named GitLab project is refused before anything is fetched.
    assert.equal((await applyProjectCommand(command({ op: "add", project: "member-b", repo: dir, cloneUrl: url, gitlabProject: "group/other" }), app.deps)).ok, false);
    assert.equal(app.clones.length, 0);
    const result = await applyProjectCommand(command({ op: "add", project: "member-b", repo: dir, cloneUrl: url, gitlabProject: "group/member-b" }), app.deps);
    assert.deepEqual([result.ok, result.error], [true, null]);
    assert.deepEqual(app.clones, [{ url, dir }]);
    assert.ok(isGitRepo(dir));
    assert.equal(app.projects[0]?.repo, dir);
  });

  it("reports a failed clone and adds nothing", async () => {
    const app = fakeApp();
    const dir = path.join(tmp(), "member-c");
    const result = await applyProjectCommand(command({ op: "add", project: "member-c", repo: dir, cloneUrl: "https://gitlab.example.com/group/member-c.git" }), app.deps);
    assert.equal(result.ok, false);
    assert.match(result.error!, /repository not found/);
    assert.deepEqual(app.projects, []);
  });

  it("removes a project from the config but never its folder, and waits while it has a run", async () => {
    const dir = repoAt(path.join(tmp(), "gone"));
    const app = fakeApp([{ name: "gone", repo: dir }, { name: "kept", repo: dir + "-kept" }]);
    app.busy.add("gone");
    const held = await applyProjectCommand(command({ op: "remove", project: "gone" }), app.deps);
    assert.equal(held.ok, false);
    app.busy.clear();
    assert.equal((await applyProjectCommand(command({ op: "remove", project: "gone" }), app.deps)).ok, true);
    assert.deepEqual(app.projects.map((p) => p.name), ["kept"]);
    assert.ok(existsSync(path.join(dir, "README.md")), "the folder stays");
    // Already gone: nothing to do, and nothing to complain about.
    assert.equal((await applyProjectCommand(command({ op: "remove", project: "gone" }), app.deps)).ok, true);
  });

  it("re-checks every field the hub sent", async () => {
    const root = tmp();
    const dir = repoAt(path.join(root, "a"));
    const app = fakeApp([{ name: "taken", repo: dir }]);
    const bad: Array<Partial<MachineProjectCommand>> = [
      { op: "add", project: "Bad Name", repo: dir },
      { op: "add", project: "a", repo: "relative/a" },
      { op: "add", project: "a", repo: `${root}${path.sep}..${path.sep}a` },
      { op: "add", project: "a", repo: path.join(root, "new"), cloneUrl: "ext::sh -c id" },
      { op: "add", project: "a", repo: path.join(root, "new"), cloneUrl: "https://user:token@gitlab.example.com/g/a.git" },
      { op: "add", project: "a", repo: path.join(root, "new"), cloneUrl: "file:///etc" },
      { op: "remove", project: "taken", repo: dir },
      // Another project's folder.
      { op: "add", project: "b", repo: dir },
      { op: "add", project: "taken", repo: path.join(root, "elsewhere") },
      process.platform === "win32" ? { op: "add", project: "a", repo: "/work/a" } : { op: "add", project: "a", repo: "C:\\work\\a" },
    ];
    for (const order of bad) {
      const result = await applyProjectCommand(command(order as MachineProjectCommand), app.deps);
      assert.equal(result.ok, false, JSON.stringify(order));
    }
    assert.equal(app.clones.length, 0);
    assert.deepEqual(app.projects.map((p) => p.name), ["taken"]);
  });

  it("round-trips through the hub: reports its repos, takes the command at a heartbeat and answers at the next", async () => {
    const root = tmp();
    const repo = repoAt(path.join(root, "gone"));
    const hive = new SqliteHive(":memory:");
    const admin: Actor = { name: "admin", role: "admin" };
    const app = fakeApp([{ name: "gone", repo }]);
    const settings: RunnerSettings = { worktreeRoot: path.join(root, "worktrees"), maxParallel: 1, maxAttempts: 1, acceptHubRuns: false, gateRunner: false, worktreeCleanup: worktreeCleanupSchema.parse({ enabled: false }) };
    const host: RunnerHost = {
      backend: () => hive, profiles: () => [AGENT_TEMPLATES.claude], projects: () => app.projects, settings: () => settings, mode: () => "hub",
      machine: () => "hc", env: () => ({ PATH: process.env.PATH }), applyProjectCommand: (c) => applyProjectCommand(c, app.deps),
    };
    const runner = new Runner(host, { dataDir: root, diffReview: false, fetchRetryMs: [] });
    try {
      await runner.heartbeat();
      const [view] = await hive.call("machines.projects", {}, admin);
      assert.deepEqual(view?.repos.map((r) => [r.project, r.path]), [["gone", repo]]);
      const queued = await hive.call("machines.projectCommand", { machine: "hc", op: "remove", project: "gone" }, admin);
      await runner.heartbeat();
      for (let i = 0; i < 100 && !runner.store.projectResult(queued.id); i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(app.projects, []);
      await runner.heartbeat();
      const [after] = await hive.call("machines.projects", {}, admin);
      assert.equal(after?.commands[0]?.ok, true);
      assert.deepEqual(after?.repos, []);
      // The hub heard it, so the next heartbeat carries no result for it.
      assert.equal(runner.store.projectResults().length, 0);
    } finally { await runner.stop(); runner.store.db.close(); hive.close(); }
  });
});
