import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  AGENT_TEMPLATES,
  githubSettingsSchema,
  gitlabSettingsSchema,
  type Actor,
  type AgentProfile,
  type DesktopProject,
  type GitHubSettings,
  type MrSettings,
} from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { githubApi } from "../src/main/github/client.ts";
import { forgeOf, MergeRequester, pushEnv } from "../src/main/gitlab/mr.ts";
import { parseRemoteUrl } from "../src/main/gitlab/remote.ts";
import { Runner } from "../src/main/runner/runner.ts";
import { startMockGitHub, type MockGitHub } from "./fixtures/mock-github.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-agent.mjs");
const TOKEN = "mock-github-token";
const admin: Actor = { name: "duy", role: "admin" };
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let gh: MockGitHub;
before(async () => {
  gh = await startMockGitHub(TOKEN);
});
after(() => gh.close());

function profile(id: string, kind: AgentProfile["kind"], priority: number, mode: string): AgentProfile {
  return { ...AGENT_TEMPLATES.claude, id, label: id, kind, priority, bin: process.execPath, args: [FAKE, "{prompt}"], env: { FAKE_MODE: mode } };
}

/** A repo with a bare "origin"; GitLab is not set up, the project names its GitHub repository. */
async function setup(reviewMode: string, mr: Partial<MrSettings> = {}, token = TOKEN, project: Partial<DesktopProject> = { githubRepo: "duy/demo" }) {
  gh.reset();
  const origin = tmp("origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const repo = tmp("repo");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");

  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "T-1", project: "demo", title: "Thêm trang cài đặt" }, admin);
  const gitlab = gitlabSettingsSchema.parse({ mr: { enabled: true, ...mr } });
  const github: GitHubSettings = githubSettingsSchema.parse({ url: gh.base, token });
  const projects: DesktopProject[] = [{ name: "demo", repo, ...project }];
  const profiles = [profile("claude-a", "claude", 10, "ok"), profile("codex-a", "codex", 50, reviewMode)];
  let runner: Runner;
  const requester = new MergeRequester({
    gitlab: () => gitlab,
    github: () => github,
    projects: () => projects,
    backend: () => hive,
    mode: () => "local",
    store: () => runner.store,
    user: "duy",
  });
  runner = new Runner(
    {
      backend: () => hive,
      profiles: () => profiles,
      settings: () => ({ worktreeRoot: null, maxParallel: 2, maxAttempts: 3 }),
      projects: () => projects,
      mode: () => "local",
      machine: () => "duy-mbp",
      env: () => ({ ...process.env }),
    },
    { dataDir: tmp("data"), user: "duy", tickMs: 60_000, afterFinish: (run) => requester.afterFinish(run) },
  );
  const task = async () => (await hive.call("tasks.list", { project: "demo" }, admin)).find((t) => t.id === "T-1")!;
  const reviewed = async () => {
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();
    return { run: runner.store.get(run.id)!, review: runner.list().find((r) => r.parentRunId === run.id)! };
  };
  return { origin, repo, hive, runner, requester, task, reviewed };
}

describe("GitHub pull requests", () => {
  it("tells GitHub projects apart by their remote or their owner/repo", () => {
    const p: DesktopProject = { name: "demo", repo: "/r" };
    const url = "https://github.com";
    assert.equal(forgeOf(p, parseRemoteUrl("git@github.com:duy/demo.git"), url), "github");
    assert.equal(forgeOf(p, parseRemoteUrl("https://github.com/duy/demo.git"), url), "github");
    assert.equal(forgeOf(p, parseRemoteUrl("git@gitlab.fis.vn:group/demo.git"), url), "gitlab");
    assert.equal(forgeOf(p, null, url), "gitlab");
    assert.equal(forgeOf({ ...p, githubRepo: "duy/demo" }, null, url), "github", "a local or unknown remote with owner/repo");
    assert.equal(forgeOf(p, parseRemoteUrl("git@ghe.fis.vn:team/demo.git"), "https://ghe.fis.vn"), "github", "Enterprise Server");
    assert.deepEqual(githubApi("https://github.com/"), { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" });
    assert.deepEqual(githubApi("https://ghe.fis.vn"), { rest: "https://ghe.fis.vn/api/v3", graphql: "https://ghe.fis.vn/api/graphql" });
  });

  it("pushes over HTTPS with the token as a header for the forge's own host only", () => {
    const https = "https://github.com/duy/demo.git";
    const env = pushEnv(https, parseRemoteUrl(https), "github.com", { user: "x-access-token", token: "tok" });
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
    assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
    assert.equal(pushEnv(https, parseRemoteUrl(https), "gitlab.fis.vn", { user: "oauth2", token: "tok" }).GIT_CONFIG_KEY_0, undefined);
    const ssh = "git@github.com:duy/demo.git";
    assert.equal(pushEnv(ssh, parseRemoteUrl(ssh), "github.com", { user: "x-access-token", token: "tok" }).GIT_CONFIG_KEY_0, undefined, "SSH keeps its own key");
  });

  it("pushes the branch and opens a ready pull request when the cross-review approves", async () => {
    const { origin, task, reviewed } = await setup("review");
    const { run, review } = await reviewed();
    assert.equal(review.mrState, "created", review.mrNote ?? "");
    assert.equal(review.mrIid, 1);
    assert.equal(review.mrDraft, false);
    assert.equal(review.mrUrl, `${gh.base}/duy/demo/pull/1`);
    assert.equal(review.mrNote, null);
    assert.equal(run.mrUrl, null, "implement run waits for the review");

    assert.equal(git(origin, "rev-parse", "refs/heads/ai/T-1"), git(run.worktree!, "rev-parse", "HEAD"));
    const [pr] = gh.pulls;
    assert.deepEqual([pr!.head.ref, pr!.base.ref, pr!.title, pr!.draft], ["ai/T-1", "main", "T-1: Thêm trang cài đặt", false]);
    assert.deepEqual(pr!.labels, ["ai", "xdev-hive"]);
    assert.match(pr!.body, /Agent làm task: `claude-a`[\s\S]*```text\nImplemented T-1/);
    assert.match(pr!.body, /Review chéo: `codex-a`.*verdict ✅ approve/);
    assert.ok(gh.calls.some((c) => c.path === `/api/v3/repos/duy/demo/pulls?state=open&head=${encodeURIComponent("duy:ai/T-1")}`), "looked for an open PR first");
    assert.match((await task()).note ?? "", /PR #1: http:\/\/127\.0\.0\.1:\d+\/duy\/demo\/pull\/1$/);
  });

  it("opens a draft when the review asks for changes, and marks it ready once it approves", async () => {
    const { runner, requester, reviewed } = await setup("review-changes");
    const { review } = await reviewed();
    assert.equal(review.mrDraft, true);
    assert.match(review.mrNote ?? "", /review yêu cầu sửa/);
    assert.equal(gh.pulls[0]!.draft, true);
    assert.equal(gh.pulls[0]!.title, "T-1: Thêm trang cài đặt", "a GitHub draft is a flag, not a title prefix");
    assert.match(gh.pulls[0]!.body, /````text\n[\s\S]*@everyone ship it\n```\nbreak out\n````/, "agent output stays inside the fence");

    const approved = runner.store.update(review.id, { summary: "Verdict: approve. Fixed." });
    const again = await requester.open(approved, { manual: true });
    assert.deepEqual([again.mrState, again.mrDraft, again.mrIid], ["updated", false, 1]);
    assert.equal(gh.pulls.length, 1);
    assert.equal(gh.pulls[0]!.draft, false);
    assert.match(gh.calls.find((c) => c.path === "/api/graphql")!.body.query, /markPullRequestReadyForReview/);
    assert.equal(gh.calls.find((c) => c.method === "PATCH")!.body.base, undefined, "does not move a base changed on GitHub");
  });

  it("opens a ready pull request titled Draft: when the repository has no drafts", async () => {
    gh.reset();
    const { reviewed } = await setup("review-changes");
    gh.noDrafts = true;
    const { review } = await reviewed();
    assert.equal(review.mrState, "created", review.mrNote ?? "");
    assert.deepEqual([gh.pulls[0]!.title, gh.pulls[0]!.draft], ["Draft: T-1: Thêm trang cài đặt", false]);
    assert.match(review.mrNote ?? "", /không hỗ trợ PR Draft/);
  });

  it("records GitHub errors on the run without failing it, and does nothing without a token", async () => {
    const wrong = await setup("review", {}, "mock-github-wrong-token");
    const { review } = await wrong.reviewed();
    assert.equal(review.status, "succeeded");
    assert.equal(review.mrState, "failed");
    assert.match(review.mrNote ?? "", /GitHub 401: Bad credentials/);

    const none = await setup("review", {}, "");
    const quiet = await none.reviewed();
    assert.equal(quiet.review.mrState, null, "no GitHub token and no GitLab: no MR, no error");
    await assert.rejects(none.requester.open(quiet.review, { manual: true }), /Chưa có GitHub token/);
  });

  it("keeps a project on GitLab when neither its remote nor owner/repo points at GitHub", async () => {
    const { requester, reviewed } = await setup("review", { enabled: false }, TOKEN, { githubRepo: undefined });
    const { review } = await reviewed();
    await assert.rejects(requester.open(review, { manual: true }), /Chưa cấu hình GitLab/, "a local remote is not on GitHub: the project stays on GitLab");
  });
});
