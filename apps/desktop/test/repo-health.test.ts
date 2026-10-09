import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { RepoAccessReport } from "@xdev-hive/core";
import {
  checkRepoAccess,
  classifyGitRemoteError,
  forgeEnv,
  gitLsRemote,
  gitRemoteDetail,
  headOf,
  NO_PROMPT_ENV,
  RepoHealthMonitor,
  type RepoToCheck,
} from "#desktop/main/repo-health.ts";

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

describe("git remote error classification", () => {
  it("GitLab's not found or no permission, over HTTPS and SSH, and GitHub's not found: neither can be told apart", () => {
    // The incident of 2026-10-09, as git printed it for the machine's account.
    const https = [
      "remote: The project you were looking for could not be found or you don't have permission to view it.",
      "fatal: repository 'https://gitlab.fis.vn/ehospital-ai/his/frontend/system-portal.git/' not found",
    ].join("\n");
    const ssh = [
      "ERROR: The project you were looking for could not be found or you don't have permission to view it.",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n");
    const github = "remote: Repository not found.\nfatal: repository 'https://github.com/acme/private.git/' not found";
    for (const stderr of [https, ssh, github, "fatal: unable to access 'https://h/x.git/': The requested URL returned error: 404"]) {
      assert.equal(classifyGitRemoteError(stderr), "no_access_or_missing", stderr);
    }
  });

  it("refused credentials", () => {
    for (const stderr of [
      "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.fis.vn/x/y.git/'",
      "git@gitlab.fis.vn: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      "fatal: could not read Username for 'https://gitlab.fis.vn': terminal prompts disabled",
      "fatal: unable to access 'https://gitlab.fis.vn/x/y.git/': The requested URL returned error: 403",
    ]) assert.equal(classifyGitRemoteError(stderr), "no_access", stderr);
  });

  it("the network, including a check killed by its timeout", () => {
    for (const stderr of [
      "fatal: unable to access 'https://gitlab.fis.vn/x/y.git/': Could not resolve host: gitlab.fis.vn",
      "ssh: connect to host gitlab.fis.vn port 22: Connection timed out",
      "fatal: unable to access 'https://h/x.git/': Failed to connect to h port 443 after 2 ms: Connection refused",
      "ssh: Could not resolve hostname gitlab.fis.vn: Name or service not known",
    ]) assert.equal(classifyGitRemoteError(stderr), "network", stderr);
    assert.equal(classifyGitRemoteError("", true), "network");
  });

  it("no repository there, and anything else", () => {
    assert.equal(classifyGitRemoteError("fatal: '/nope/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository."), "not_found");
    assert.equal(classifyGitRemoteError("fatal: something git has never said"), "error");
  });
});

describe("what goes to the hub", () => {
  it("git's last words without the URL's user and password, or a line holding a token", () => {
    const detail = gitRemoteDetail("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://oauth2:s3cretpass@gitlab.fis.vn/x/y.git/'\n");
    assert.equal(detail, "remote: HTTP Basic: Access denied fatal: Authentication failed for 'https://gitlab.fis.vn/x/y.git/'");
    assert.doesNotMatch(gitRemoteDetail("fatal: bad header glpat-abcdefghijklmnopqrstuvwx") ?? "", /glpat-/);
    assert.equal(gitRemoteDetail("  \n"), null);
  });

  it("the HEAD commit, or none for an empty repository", () => {
    assert.equal(headOf(`${"b".repeat(40)}\tHEAD\n`), "b".repeat(40));
    assert.equal(headOf(""), null);
  });

  it("never prompts, and sends the forge token only to the forge's own host", () => {
    assert.equal(NO_PROMPT_ENV.GIT_TERMINAL_PROMPT, "0");
    assert.equal(NO_PROMPT_ENV.GCM_INTERACTIVE, "never");
    const forges = [{ url: "https://gitlab.fis.vn", token: "glpat-xxxxxxxxxxxxxxxxxxxx", user: "oauth2" }];
    const https = forgeEnv("https://gitlab.fis.vn/ehospital-ai/web.git", forges);
    assert.equal(https.GIT_CONFIG_KEY_0, "http.https://gitlab.fis.vn/.extraHeader");
    assert.match(https.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /);
    const other = forgeEnv("https://github.com/acme/web.git", forges);
    assert.equal(other.GIT_CONFIG_COUNT, undefined);
    const ssh = forgeEnv("git@gitlab.fis.vn:ehospital-ai/web.git", forges);
    assert.equal(ssh.GIT_CONFIG_COUNT, undefined);
    assert.match(ssh.GIT_SSH_COMMAND ?? "", /BatchMode=yes/);
  });
});

describe("checkRepoAccess", () => {
  const target = (repo: string, remote = "origin"): RepoToCheck => ({ project: "web", repo, remote });
  const now = () => new Date("2026-10-09T08:00:00.000Z");

  it("with a fake git: ok with HEAD, a failure with its class and a clean detail", async () => {
    const ok = await checkRepoAccess(target("/r"), async () => ({ ok: true, stdout: `${"c".repeat(40)}\tHEAD\n`, stderr: "", timedOut: false }), now);
    assert.deepEqual(ok, { project: "web", status: "ok", checkedAt: "2026-10-09T08:00:00.000Z", head: "c".repeat(40), detail: null });
    const bad = await checkRepoAccess(target("/r"), async () => ({ ok: false, stdout: "", stderr: "fatal: repository 'https://u:pw@h/x.git/' not found", timedOut: false }), now);
    assert.deepEqual([bad.status, bad.head, bad.detail], ["no_access_or_missing", null, "fatal: repository 'https://h/x.git/' not found"]);
    const thrown = await checkRepoAccess(target("/r"), async () => { throw new Error("spawn git ENOENT"); }, now);
    assert.equal(thrown.status, "error");
  });

  it("with real git: a reachable remote, and one that is not there", async () => {
    const bare = tmp("hive-repo-health-bare-");
    gitIn(bare, "init", "--bare", "--quiet");
    const work = tmp("hive-repo-health-work-");
    gitIn(work, "init", "--quiet");
    gitIn(work, "commit", "--allow-empty", "-m", "first", "--quiet");
    gitIn(work, "remote", "add", "origin", bare);
    gitIn(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    gitIn(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    const ok = await checkRepoAccess(target(work), gitLsRemote, now);
    assert.deepEqual([ok.status, ok.head], ["ok", gitIn(work, "rev-parse", "HEAD")]);

    gitIn(work, "remote", "add", "gone", path.join(bare, "..", "no-such-repo.git"));
    const gone = await checkRepoAccess(target(work, "gone"), gitLsRemote, now);
    assert.equal(gone.status, "not_found", gone.detail ?? "");
  });
});

describe("RepoHealthMonitor", () => {
  it("checks a project again only after the interval, every one when forced, and forgets removed ones", async () => {
    let clock = Date.parse("2026-10-09T00:00:00.000Z");
    let projects = ["app", "web"];
    const calls: string[] = [];
    const monitor = new RepoHealthMonitor({
      targets: () => projects.map((p) => ({ project: p, repo: `/r/${p}`, remote: "origin" })),
      now: () => new Date(clock),
      intervalMs: 6 * 60 * 60_000,
      check: async (t): Promise<RepoAccessReport> => {
        calls.push(t.project);
        return { project: t.project, status: "ok", checkedAt: new Date(clock).toISOString(), head: null, detail: null };
      },
    });
    await monitor.refresh();
    clock += 60 * 60_000;
    await monitor.refresh();
    assert.deepEqual(calls, ["app", "web"], "an hour later nothing is due");
    await monitor.refresh(true);
    assert.deepEqual(calls, ["app", "web", "app", "web"], "Kiểm tra lại checks every repo");
    clock += 6 * 60 * 60_000 + 1;
    projects = ["web"];
    await monitor.refresh();
    assert.deepEqual(calls.slice(4), ["web"]);
    assert.deepEqual(monitor.latest().map((r) => r.project), ["web"]);
  });

  it("runs one sweep at a time", async () => {
    let running = 0;
    let most = 0;
    const monitor = new RepoHealthMonitor({
      targets: () => [{ project: "app", repo: "/r/app", remote: "origin" }],
      check: async (t) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { project: t.project, status: "ok", checkedAt: new Date().toISOString(), head: null, detail: null };
      },
    });
    await Promise.all([monitor.refresh(true), monitor.refresh(true)]);
    assert.equal(most, 1);
  });
});
