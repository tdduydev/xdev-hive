import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DesktopProject } from "@xdev-hive/core";
import { forgeOf, parseStatusV2, pullBlock, pullRepo, fetchRepo, statusRow, type FetchMark, type RepoDeps } from "#desktop/main/repo-status.ts";
import { ForgeUsageStore } from "#desktop/main/forge-usage.ts";

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (repo: string, file: string) => {
  writeFileSync(path.join(repo, file), file);
  gitIn(repo, "add", file);
  gitIn(repo, "commit", "-q", "-m", file);
};

/** A bare remote with one commit on main, a clone of it, and a second clone to move the remote on with. */
function setup() {
  const root = tmp("hive-repos-");
  const remote = path.join(root, "remote.git");
  gitIn(root, "init", "-q", "--bare", "-b", "main", remote);
  const other = path.join(root, "other");
  gitIn(root, "clone", "-q", remote, other);
  gitIn(other, "checkout", "-q", "-b", "main");
  commit(other, "a.txt");
  gitIn(other, "push", "-q", "origin", "main");
  const repo = path.join(root, "repo");
  gitIn(root, "clone", "-q", remote, repo);
  const moveRemote = (file: string) => { commit(other, file); gitIn(other, "push", "-q", "origin", "main"); };
  return { root, remote, repo, other, moveRemote };
}

function deps(overrides: Partial<RepoDeps> = {}): RepoDeps & { fetched: Map<string, FetchMark> } {
  return {
    forges: () => [],
    env: () => ({}),
    busy: () => null,
    health: () => null,
    fetched: new Map(),
    now: () => new Date("2026-10-10T05:00:00Z"),
    ...overrides,
  } as RepoDeps & { fetched: Map<string, FetchMark> };
}

const project = (repo: string): DesktopProject => ({ name: "app", repo });

describe("git status --porcelain=v2 --branch, read", () => {
  it("branch, upstream, ahead/behind, changes and conflicts", () => {
    const s = parseStatusV2([
      "# branch.oid 0123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 a b src/x.ts",
      "2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts",
      "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
      "? notes.txt",
      "! ignored.log",
    ].join("\r\n"));
    assert.deepEqual(s, { branch: "main", upstream: "origin/main", ahead: 2, behind: 3, changes: 3, conflicts: 1 });
  });

  it("a detached HEAD and a branch with no upstream", () => {
    assert.equal(parseStatusV2("# branch.oid 0123\n# branch.head (detached)\n").branch, null);
    const s = parseStatusV2("# branch.oid 0123\n# branch.head feature\n");
    assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["feature", null, 0, 0]);
  });
});

describe("what keeps a Pull from running", () => {
  const clean = { branch: "main", upstream: "origin/main", ahead: 0, behind: 1, changes: 0, conflicts: 0 };
  it("only a clean branch with an upstream that is behind, ahead or level", () => {
    assert.equal(pullBlock(clean, null), null);
    assert.equal(pullBlock({ ...clean, behind: 0, ahead: 2 }, null), null, "ahead only: ff-only has nothing to do, no harm");
    assert.equal(pullBlock(null, null), "missing");
    assert.equal(pullBlock(clean, "run"), "busy");
    assert.equal(pullBlock({ ...clean, conflicts: 1, changes: 1 }, null), "conflict");
    assert.equal(pullBlock({ ...clean, branch: null }, null), "detached");
    assert.equal(pullBlock({ ...clean, upstream: null }, null), "noUpstream");
    assert.equal(pullBlock({ ...clean, changes: 1 }, null), "dirty");
    assert.equal(pullBlock({ ...clean, ahead: 1 }, null), "diverged");
  });
});

describe("the forge of a remote", () => {
  const forges = [{ kind: "gitlab" as const, url: "https://git.example.com/gitlab" }];
  it("names the forge and links the repo's page, prefix kept for SSH", () => {
    assert.deepEqual(forgeOf("https://git.example.com/gitlab/team/app.git", forges), { forge: "gitlab", webUrl: "https://git.example.com/gitlab/team/app" });
    assert.deepEqual(forgeOf("git@git.example.com:team/app.git", forges), { forge: "gitlab", webUrl: "https://git.example.com/gitlab/team/app" });
    assert.deepEqual(forgeOf("git@github.com:me/x.git", []), { forge: "github", webUrl: "https://github.com/me/x" });
    assert.deepEqual(forgeOf("D:\\repos\\x.git", forges), { forge: null, webUrl: null });
    assert.deepEqual(forgeOf(null, forges), { forge: null, webUrl: null });
  });
});

describe("a repo's row, fetch and pull, on real checkouts", () => {
  it("clean and level, then behind after a fetch, then pulled by a fast-forward", async () => {
    const { repo, moveRemote } = setup();
    const d = deps();
    let row = await statusRow(project(repo), d);
    assert.deepEqual([row.exists, row.branch, row.upstream, row.ahead, row.behind, row.changes, row.block, row.access], [true, "main", "origin/main", 0, 0, 0, null, "unchecked"]);
    moveRemote("b.txt");
    await fetchRepo(project(repo), d);
    row = await statusRow(project(repo), d);
    assert.deepEqual([row.behind, row.access, row.fetchedAt], [1, "ok", "2026-10-10T05:00:00.000Z"]);
    const res = await pullRepo(project(repo), d);
    assert.equal(res.outcome, "pulled");
    assert.equal(res.row.behind, 0);
    assert.equal(gitIn(repo, "log", "-1", "--format=%s"), "b.txt");
    assert.equal((await pullRepo(project(repo), d)).outcome, "upToDate");
  });

  it("skips a checkout with someone's changes and leaves them as they were", async () => {
    const { repo, moveRemote } = setup();
    moveRemote("b.txt");
    writeFileSync(path.join(repo, "a.txt"), "mine, not committed");
    const d = deps();
    await fetchRepo(project(repo), d);
    const head = gitIn(repo, "rev-parse", "HEAD");
    const res = await pullRepo(project(repo), d);
    assert.deepEqual([res.outcome, res.reason], ["skipped", "dirty"]);
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), head);
    assert.equal(execFileSync("git", ["show", ":a.txt"], { cwd: repo, encoding: "utf8" }), "a.txt", "nothing staged or stashed");
  });

  it("skips a branch that diverged, one with no upstream, and one an agent is using", async () => {
    const { repo, moveRemote } = setup();
    moveRemote("b.txt");
    commit(repo, "local.txt");
    const d = deps();
    await fetchRepo(project(repo), d);
    assert.deepEqual([(await pullRepo(project(repo), d)).reason], ["diverged"]);
    gitIn(repo, "checkout", "-q", "-b", "solo");
    assert.equal((await pullRepo(project(repo), d)).reason, "noUpstream");
    gitIn(repo, "checkout", "-q", "main");
    assert.equal((await pullRepo(project(repo), deps({ busy: () => "run" }))).reason, "busy");
  });

  it("a remote that does not answer is the row's access, not an error", async () => {
    const { repo } = setup();
    gitIn(repo, "remote", "set-url", "origin", path.join(os.tmpdir(), "hive-no-such-remote-xyz.git"));
    const d = deps();
    await fetchRepo(project(repo), d);
    const row = await statusRow(project(repo), d);
    assert.notEqual(row.access, "ok");
    assert.notEqual(row.access, "unchecked");
  });

  it("a folder that is gone", async () => {
    const row = await statusRow(project(path.join(os.tmpdir(), "hive-gone-repo-xyz")), deps());
    assert.deepEqual([row.exists, row.block], [false, "missing"]);
  });

  it("the remote URL is shown without its password", async () => {
    const { repo } = setup();
    gitIn(repo, "remote", "set-url", "origin", "https://user:secret123@git.example.com/team/app.git");
    const row = await statusRow(project(repo), deps({ forges: () => [{ kind: "gitlab", url: "https://git.example.com" }] }));
    assert.ok(row.remote && !row.remote.includes("secret123"), row.remote ?? "");
    assert.equal(row.forge, "gitlab");
  });
});

describe("when the forge tokens last worked", () => {
  it("keeps the account from the check, survives a restart, and forgets a replaced token", () => {
    const file = path.join(tmp("hive-forge-use-"), "forge-usage.json");
    let now = new Date("2026-10-10T05:00:00Z");
    const store = new ForgeUsageStore(file, () => now);
    assert.equal(store.get("gitlab"), null);
    store.record("gitlab", "check", "duy");
    now = new Date("2026-10-10T06:00:00Z");
    store.record("gitlab", "fetch");
    assert.deepEqual(new ForgeUsageStore(file).get("gitlab"), { at: "2026-10-10T06:00:00.000Z", user: "duy", by: "fetch" });
    store.forget("gitlab");
    assert.equal(new ForgeUsageStore(file).get("gitlab"), null);
  });

  it("a broken file is no usage, not a crash", () => {
    const file = path.join(tmp("hive-forge-use-"), "forge-usage.json");
    writeFileSync(file, "{not json");
    assert.equal(new ForgeUsageStore(file).get("github"), null);
  });
});
