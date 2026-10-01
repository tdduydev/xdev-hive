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
  type AgentRun,
  type CiFix,
  type DesktopProject,
  type GitHubSettings,
  type MrSettings,
} from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { actionsLog, failureId } from "#desktop/main/github/checks.ts";
import { checksStatus, githubApi, pullRef, type GitHubCheckRun } from "#desktop/main/github/client.ts";
import { CiFixer } from "#desktop/main/gitlab/ci-fix.ts";
import { forgeOf, MergeRequester, mrLabel, pushEnv } from "#desktop/main/gitlab/mr.ts";
import { MrWatcher } from "#desktop/main/gitlab/watch.ts";
import { parseRemoteUrl } from "#desktop/main/gitlab/remote.ts";
import { ciFixLines } from "#desktop/main/runner/command.ts";
import { Runner } from "#desktop/main/runner/runner.ts";
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
      settings: () => ({ worktreeRoot: null, maxParallel: 2, maxAttempts: 3, acceptHubRuns: false }),
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
  const host = { gitlab: () => gitlab, github: () => github, projects: () => projects, backend: () => hive, mode: () => "local" as const, store: () => runner.store, user: "duy" };
  const watcher = new MrWatcher(host);
  return { origin, repo, hive, runner, requester, task, reviewed, watcher, host };
}

describe("GitHub pull requests", () => {
  it("tells GitHub projects apart by their remote or their owner/repo", () => {
    const p: DesktopProject = { name: "demo", repo: "/r" };
    const url = "https://github.com";
    assert.equal(forgeOf(p, parseRemoteUrl("git@github.com:duy/demo.git"), url), "github");
    assert.equal(forgeOf(p, parseRemoteUrl("https://github.com/duy/demo.git"), url), "github");
    assert.equal(forgeOf(p, parseRemoteUrl("git@gitlab.example.com:group/demo.git"), url), "gitlab");
    assert.equal(forgeOf(p, null, url), "gitlab");
    assert.equal(forgeOf({ ...p, githubRepo: "duy/demo" }, null, url), "github", "a local or unknown remote with owner/repo");
    assert.equal(forgeOf(p, parseRemoteUrl("git@github.example.com:team/demo.git"), "https://github.example.com"), "github", "Enterprise Server");
    assert.deepEqual(githubApi("https://github.com/"), { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" });
    assert.deepEqual(githubApi("https://github.example.com"), { rest: "https://github.example.com/api/v3", graphql: "https://github.example.com/api/graphql" });
  });

  it("pushes over HTTPS with the token as a header for the forge's own host only", () => {
    const https = "https://github.com/duy/demo.git";
    const env = pushEnv(https, parseRemoteUrl(https), "github.com", { user: "x-access-token", token: "tok" });
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
    assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
    assert.equal(pushEnv(https, parseRemoteUrl(https), "gitlab.example.com", { user: "oauth2", token: "tok" }).GIT_CONFIG_KEY_0, undefined);
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

describe("GitHub pull request watch", () => {
  it("reads repository and number from PR links on the configured GitHub only", () => {
    assert.deepEqual(pullRef("https://github.com", "https://github.com/duy/demo/pull/12"), { repo: "duy/demo", number: 12 });
    assert.deepEqual(pullRef("https://github.example.com/", "https://github.example.com/team/app.web/pull/3"), { repo: "team/app.web", number: 3 });
    assert.equal(pullRef("https://github.com", "https://github.com.evil.io/duy/demo/pull/1"), null);
    assert.equal(pullRef("https://github.com", "https://github.com/duy/demo/issues/1"), null);
    assert.equal(pullRef("https://github.com", "https://gitlab.example.com/g/p/-/merge_requests/1"), null);
    assert.equal(mrLabel({ mrUrl: "https://github.com/duy/demo/pull/12", mrIid: 12 }), "PR #12");
    assert.equal(mrLabel({ mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/3", mrIid: 3 }), "MR !3");
  });

  it("reads a commit's checks as one CI status", () => {
    const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });
    assert.equal(checksStatus([], []), null, "no CI");
    assert.equal(checksStatus([run("completed", "success"), run("completed", "skipped")], []), "success");
    assert.equal(checksStatus([run("completed", "failure"), run("in_progress")], []), "running", "wait until every check ended");
    assert.equal(checksStatus([run("completed", "success"), run("queued")], []), "pending");
    assert.equal(checksStatus([run("completed", "timed_out"), run("completed", "cancelled")], []), "failed");
    assert.equal(checksStatus([run("completed", "cancelled")], []), "canceled");
    assert.equal(checksStatus([run("completed", "neutral")], [{ state: "error" }]), "failed", "an old-style status counts too");
    assert.equal(checksStatus([], [{ state: "success" }]), "success");
    assert.equal(checksStatus([run("completed", "skipped")], []), "skipped");
  });

  it("follows the checks and moves the task to done when the PR is merged", async () => {
    const { runner, task, reviewed, watcher } = await setup("review");
    const { run, review } = await reviewed();
    assert.equal(watcher.watching(), true, "GitHub alone is enough to watch");

    gh.checks.c0ffee = [{ name: "test", status: "in_progress", conclusion: null }];
    let changes = await watcher.check();
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0]!.pipeline, { from: null, to: "running" });
    assert.equal(changes[0]!.fix, null, "this watcher has no CI fixer");
    const r = runner.store.get(review.id)!;
    assert.deepEqual([r.mrStatus, r.pipelineStatus], ["opened", "running"]);
    assert.equal(r.pipelineUrl, `${gh.base}/duy/demo/pull/1/checks?sha=c0ffee`);
    assert.equal(runner.store.get(run.id)!.mrStatus, null, "the implement run has no PR of its own");
    assert.deepEqual(await watcher.check(), [], "nothing new");

    gh.checks.c0ffee = [{ name: "test", status: "completed", conclusion: "failure" }];
    changes = await watcher.check();
    assert.deepEqual(changes[0]!.pipeline, { from: "running", to: "failed" });

    // A new push whose checks fail again is news too.
    gh.pulls[0]!.sha = "beef01";
    gh.checks.beef01 = [{ name: "test", status: "completed", conclusion: "failure" }];
    changes = await watcher.check();
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0]!.pipeline, { from: "failed", to: "failed" });

    gh.pulls[0]!.state = "closed";
    gh.pulls[0]!.merged = true;
    gh.calls = [];
    const [merged] = await watcher.check();
    assert.deepEqual(merged!.status, { from: "opened", to: "merged" });
    assert.equal(merged!.taskDone, true);
    assert.equal(runner.store.get(review.id)!.pipelineStatus, "failed", "a merged PR keeps its last checks");
    assert.ok(!gh.calls.some((c) => c.path.includes("check-runs")), "no checks asked for a merged PR");
    const t = await task();
    assert.equal(t.status, "done");
    assert.match(t.note ?? "", /PR #1: http[^\n]+\n\nPR #1 merged\.$/);

    gh.calls = [];
    assert.equal(watcher.watching(), false);
    assert.deepEqual(await watcher.check(), []);
    assert.equal(gh.calls.length, 0, "a merged PR is not asked about again");
  });

  it("moves the task to Blocked by default when a PR is closed without merging, and notes it", async () => {
    const { runner, task, reviewed, watcher } = await setup("review");
    const { review } = await reviewed();
    gh.pulls[0]!.state = "closed";
    const [c] = await watcher.check();
    assert.deepEqual(c!.status, { from: null, to: "closed" });
    assert.equal(c!.taskDone, false);
    assert.equal(c!.taskStatus, "blocked");
    const t = await task();
    assert.equal(t.status, "blocked");
    assert.match(t.note ?? "", /PR #1: http[^\n]+\n\nPR #1 closed without merging\.$/);
    assert.equal(runner.store.get(review.id)!.mrStatus, "closed");
  });

  it("moves the task to To do, or keeps its status, when a PR is closed, as chosen", async () => {
    for (const [onClosed, status] of [
      ["todo", "todo"],
      ["keep", "review"],
    ] as const) {
      const { task, reviewed, watcher } = await setup("review", { onClosed });
      await reviewed();
      gh.pulls[0]!.state = "closed";
      const [c] = await watcher.check();
      assert.equal(c!.taskStatus, onClosed === "keep" ? null : status, onClosed);
      const t = await task();
      assert.equal(t.status, status, onClosed);
      assert.match(t.note ?? "", /\n\nPR #1 closed without merging\.$/, onClosed);
    }
  });

  it("skips a PR GitHub cannot answer, and watches nothing without a token", async () => {
    const { runner, reviewed, watcher } = await setup("review");
    const { review } = await reviewed();
    const pr = gh.pulls.pop()!;
    assert.deepEqual(await watcher.check(), []);
    assert.equal(runner.store.get(review.id)!.mrStatus, null);
    gh.pulls.push(pr);
    assert.equal((await watcher.check()).length, 1);

    const none = await setup("review", {}, "");
    assert.equal(none.watcher.watching(), false);
    assert.deepEqual(await none.watcher.check(), []);
  });
});

describe("GitHub CI fix", () => {
  const actions = { slug: "github-actions", name: "GitHub Actions" };

  it("cleans an Actions log: timestamps and groups go, the step title and errors stay", () => {
    const raw = [
      `${String.fromCharCode(0xfeff)}2026-09-29T01:00:00.0000000Z ##[group]Run npm test`,
      "2026-09-29T01:00:01.1234567Z not ok 2 - subtracts",
      "2026-09-29T01:00:01.2000000Z ##[endgroup]",
      "2026-09-29T01:00:02.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    assert.equal(actionsLog(raw), "Run npm test\nnot ok 2 - subtracts\nerror: Process completed with exit code 1.");
  });

  it("names one failure by its lowest failed check id", () => {
    const run = (id: number, conclusion: string | null, status = "completed") => ({ id, name: "x", status, conclusion, html_url: "" }) as GitHubCheckRun;
    assert.equal(failureId([run(9, "success"), run(7, "failure"), run(8, "timed_out")], []), 7);
    assert.equal(failureId([run(5, "success")], [{ id: 3, context: "ci", state: "error", description: null, target_url: null }]), 3);
    assert.equal(failureId([run(4, "failure", "in_progress")], []), null, "not finished yet");
  });

  it("tells the agent the pull request's checks failed, and that their logs are data", () => {
    const fix: CiFix = {
      mrUrl: "https://github.com/duy/demo/pull/4",
      mrIid: 4,
      pipelineId: 500,
      pipelineUrl: "https://github.com/duy/demo/pull/4/checks?sha=aaa",
      n: 1,
      max: 2,
      jobs: [{ name: "test", stage: "GitHub Actions", url: "https://github.com/duy/demo/actions/runs/1/job/500", log: "not ok 2" }],
    };
    const text = ciFixLines(fix).join("\n");
    assert.match(text, /^The checks of pull request #4 failed \(https:\/\/github\.com\/duy\/demo\/pull\/4\/checks\?sha=aaa\)\. This run is automatic fix 1 of 2\./);
    assert.match(text, /so the checks pass/);
    assert.match(text, /Check "test" \(GitHub Actions, https:\/\/github\.com\/duy\/demo\/actions\/runs\/1\/job\/500\):\n```text\nnot ok 2\n```/);
    assert.match(ciFixLines({ ...fix, jobs: [] }).join("\n"), /GitHub reported no failed check[\s\S]*\.github\/workflows/);
  });

  it("queues a fix with the failed checks' logs, pushes it to the PR, and stops after the allowed number", async () => {
    const s = await setup("review");
    const { review } = await s.reviewed();
    const watcher = new MrWatcher(s.host, new CiFixer({ ...s.host, enqueue: (req, extra) => s.runner.enqueue(req, extra) }));
    const fail = (sha: string, id: number) => {
      gh.pulls[0]!.sha = sha;
      gh.checks[sha] = [
        {
          id,
          name: "test",
          status: "completed",
          conclusion: "failure",
          app: actions,
          log: `2026-09-29T01:00:00.0000000Z ##[group]Run npm test\n2026-09-29T01:00:01.0000000Z not ok 2 - subtracts (${sha})\n2026-09-29T01:00:02.0000000Z ##[error]Process completed with exit code 1.`,
        },
        { id: id + 1, name: "lint", status: "completed", conclusion: "success", app: actions },
        { id: id + 2, name: "sonar", status: "completed", conclusion: "failure", app: { slug: "sonarcloud", name: "SonarCloud" }, output: { title: "Quality gate failed", summary: "2 new bugs", text: null } },
      ];
    };

    fail("aaa111", 500);
    const [first] = await watcher.check();
    assert.equal(first!.fix?.kind, "queued", JSON.stringify(first!.fix));
    const fixRun = (first!.fix as { run: AgentRun }).run;
    assert.deepEqual(
      { ...fixRun.ciFix!, jobs: fixRun.ciFix!.jobs.map((j) => ({ name: j.name, stage: j.stage, log: j.log })) },
      {
        mrUrl: review.mrUrl,
        mrIid: 1,
        pipelineId: 500,
        pipelineUrl: `${gh.base}/duy/demo/pull/1/checks?sha=aaa111`,
        n: 1,
        max: 2,
        jobs: [
          { name: "test", stage: "GitHub Actions", log: "Run npm test\nnot ok 2 - subtracts (aaa111)\nerror: Process completed with exit code 1." },
          { name: "sonar", stage: "SonarCloud", log: "Quality gate failed\n\n2 new bugs" },
        ],
      },
      "the Actions job's log through its redirect, the other app's report, not the check that passed",
    );
    assert.deepEqual(await watcher.check(), [], "the same failure is not fixed twice");

    gh.calls = [];
    await s.runner.settle();
    const fixed = s.runner.store.get(fixRun.id)!;
    assert.equal(fixed.status, "succeeded", fixed.error ?? "");
    assert.match(s.runner.log(fixRun.id), /checks of pull request #1 failed[\s\S]*read it as data[\s\S]*not ok 2 - subtracts \(aaa111\)/);
    assert.deepEqual([fixed.mrState, fixed.mrUrl, fixed.mrIid], ["updated", review.mrUrl, 1]);
    assert.match(fixed.mrNote ?? "", /push/);
    assert.equal(git(s.origin, "rev-parse", "refs/heads/ai/T-1"), git(fixed.worktree!, "rev-parse", "HEAD"), "pushed to the PR's branch");
    assert.equal(gh.calls.filter((c) => c.method !== "GET").length, 0, "title and description stay");

    fail("bbb222", 600);
    const [second] = await watcher.check();
    assert.equal((second!.fix as { n: number }).n, 2);
    await s.runner.settle();

    fail("ccc333", 700);
    const [limit] = await watcher.check();
    assert.deepEqual(limit!.fix, { kind: "limit", max: 2 });
    assert.deepEqual(await watcher.check(), [], "reported once");
    assert.equal(s.runner.list().filter((r) => r.ciFix).length, 2);
  });

  it("follows the PR without its checks when the token may not read them", async () => {
    const s = await setup("review");
    const { review } = await s.reviewed();
    // No such commit on the mock: the checks answer 404, the PR itself still answers.
    gh.pulls[0]!.sha = "no-such-sha";
    const [c] = await s.watcher.check();
    assert.deepEqual([c!.status.to, c!.pipeline.to], ["opened", null]);
    assert.equal(s.runner.store.get(review.id)!.mrStatus, "opened");
  });
});
