import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_TEMPLATES, gitlabSettingsSchema, type Actor, type AgentProfile, type GitLabSettings, type MrSettings } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { fence, mrDescription, parseVerdict } from "../src/main/gitlab/describe.ts";
import { MergeRequester } from "../src/main/gitlab/mr.ts";
import { parseRemoteUrl } from "../src/main/gitlab/remote.ts";
import { Runner } from "../src/main/runner/runner.ts";
import { startMockGitLab, type MockGitLab } from "./fixtures/mock-gitlab.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-agent.mjs");
const TOKEN = "mock-gitlab-token";
const admin: Actor = { name: "duy", role: "admin" };
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let gl: MockGitLab;
before(async () => {
  gl = await startMockGitLab(TOKEN);
});
after(() => gl.close());

// ── Fixture: repo with a bare "origin", Hive, runner wired to the merge requester ─
function profile(id: string, kind: AgentProfile["kind"], priority: number, mode: string): AgentProfile {
  return { ...AGENT_TEMPLATES.claude, id, label: id, kind, priority, bin: process.execPath, args: [FAKE, "{prompt}"], env: { FAKE_MODE: mode } };
}

async function setup(reviewMode: string, mr: Partial<MrSettings> = {}, token = TOKEN) {
  gl.reset();
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
  const settings: GitLabSettings = gitlabSettingsSchema.parse({ url: gl.base, token, mr: { enabled: true, ...mr } });
  // A local-path origin has no GitLab host, so the project path comes from the per-project override.
  const projects = [{ name: "demo", repo, gitlabProject: "group/demo" }];
  const profiles = [profile("claude-a", "claude", 10, "ok"), profile("codex-a", "codex", 50, reviewMode)];
  let runner: Runner;
  const requester = new MergeRequester({
    gitlab: () => settings,
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
  return { origin, repo, runner, requester, task };
}

describe("remote & verdict parsing", () => {
  it("reads GitLab host and project path from remotes", () => {
    assert.deepEqual(parseRemoteUrl("git@gitlab.fis.vn:ehospital-ai/ai/ai-studio.git"), { host: "gitlab.fis.vn", path: "ehospital-ai/ai/ai-studio", https: false });
    assert.deepEqual(parseRemoteUrl("ssh://git@gitlab.fis.vn:2222/group/proj.git"), { host: "gitlab.fis.vn", path: "group/proj", https: false });
    assert.deepEqual(parseRemoteUrl("https://duy@GitLab.fis.vn/group/sub/proj"), { host: "gitlab.fis.vn", path: "group/sub/proj", https: true });
    assert.equal(parseRemoteUrl("/tmp/origin.git"), null);
    assert.equal(parseRemoteUrl("https://gitlab.fis.vn/"), null);
  });

  it("reads the review verdict", () => {
    assert.equal(parseVerdict("Verdict: approve. No blocking findings."), "approve");
    assert.equal(parseVerdict("**Verdict:** Changes needed\n- fix x"), "changes");
    assert.equal(parseVerdict("No changes needed. LGTM"), "approve");
    assert.equal(parseVerdict("Please request changes on the API"), "changes");
    assert.equal(parseVerdict("Looked at the diff."), "unknown");
    assert.equal(parseVerdict(null), "unknown");
  });

  it("keeps agent output inert inside a fence longer than any backtick run", () => {
    const out = fence("ok\n/merge\n````\nx");
    assert.match(out, /^`````text\n/);
    assert.match(out, /\n \/merge\n/);
    assert.doesNotMatch(out, /^\/merge/m);
    const md = mrDescription({ project: "demo", taskId: "T-1", taskTitle: "A\nB", branch: "ai/T-1", commits: ["abc x"], implement: null, review: null });
    assert.match(md, /\*\*T-1\*\*: A B/);
  });
});

describe("merge requests", () => {
  it("pushes the branch and opens a ready MR when the cross-review approves", async () => {
    const { origin, runner, task } = await setup("review");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();

    const review = runner.list().find((r) => r.parentRunId === run.id)!;
    assert.equal(review.mrState, "created", review.mrNote ?? "");
    assert.equal(review.mrIid, 1);
    assert.equal(review.mrDraft, false);
    assert.equal(runner.store.get(run.id)!.mrUrl, null, "implement run waits for the review");

    assert.equal(git(origin, "rev-parse", "refs/heads/ai/T-1"), git(runner.store.get(run.id)!.worktree!, "rev-parse", "HEAD"));
    const [mr] = gl.mrs;
    assert.equal(mr!.source_branch, "ai/T-1");
    assert.equal(mr!.target_branch, "main");
    assert.equal(mr!.title, "T-1: Thêm trang cài đặt");
    assert.equal(mr!.labels, "ai,xdev-hive");
    assert.equal(mr!.remove_source_branch, true);
    assert.match(mr!.description, /Agent làm task: `claude-a`[\s\S]*```text\nImplemented T-1/);
    assert.match(mr!.description, /Review chéo: `codex-a`.*verdict ✅ approve/);
    assert.match(mr!.description, /work by claude-a/);
    assert.match((await task()).note ?? "", /MR !1: http:\/\/127\.0\.0\.1:\d+\/group\/demo\/-\/merge_requests\/1$/);
  });

  it("opens a Draft MR when the review asks for changes, with quick actions neutralised", async () => {
    const { runner } = await setup("review-changes");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();
    const review = runner.list().find((r) => r.parentRunId === run.id)!;
    assert.equal(review.mrDraft, true);
    assert.match(review.mrNote ?? "", /review yêu cầu sửa/);
    const [mr] = gl.mrs;
    assert.match(mr!.title, /^Draft: T-1:/);
    assert.doesNotMatch(mr!.description, /^\/(merge|approve)/m, "no quick action at line start");
    assert.match(mr!.description, /````text\n[\s\S]* \/merge\n \/approve\n@everyone ship it\n```\nbreak out\n````/);
  });

  it("updates the existing MR instead of opening a second one", async () => {
    const { runner, requester } = await setup("review");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();
    const review = runner.list().find((r) => r.parentRunId === run.id)!;
    const again = await requester.open(review, { manual: true });
    assert.equal(again.mrState, "updated");
    assert.equal(gl.mrs.length, 1);
    const put = gl.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.body.add_labels, "ai,xdev-hive");
    assert.equal(put.body.target_branch, undefined, "does not move a target changed in GitLab");
  });

  it("can skip the MR when changes are requested, and without review opens after success", async () => {
    const skip = await setup("review-changes", { onChangesRequested: "skip" });
    const run = await skip.runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await skip.runner.settle();
    assert.equal(skip.runner.list().find((r) => r.parentRunId === run.id)!.mrState, "skipped");
    assert.equal(gl.mrs.length, 0);

    const direct = await setup("review", { when: "after_success" });
    const solo = await direct.runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: false });
    await direct.runner.settle();
    assert.equal(direct.runner.store.get(solo.id)!.mrState, "created");
    assert.equal(gl.mrs[0]!.title, "T-1: Thêm trang cài đặt");
  });

  it("records GitLab errors on the run without failing it", async () => {
    const { runner } = await setup("review", {}, "mock-gitlab-wrong-token");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();
    const review = runner.list().find((r) => r.parentRunId === run.id)!;
    assert.equal(review.status, "succeeded");
    assert.equal(review.mrState, "failed");
    assert.match(review.mrNote ?? "", /GitLab 401/);
  });
});
