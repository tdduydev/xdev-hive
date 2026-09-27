import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, type Actor, type AgentProfile, type HiveBackend, type RunnerSettings } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { parseResetTime, detectRateLimit } from "../src/main/runner/rate-limit.ts";
import { Runner, type RunnerHost } from "../src/main/runner/runner.ts";
import { pickProfile, type ProfileLoad } from "../src/main/runner/schedule.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-agent.mjs");
const admin: Actor = { name: "duy", role: "admin" };
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function profile(id: string, kind: AgentProfile["kind"], priority: number, mode: string, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    ...AGENT_TEMPLATES.claude,
    id,
    label: id,
    kind,
    priority,
    bin: process.execPath,
    args: [FAKE, "{prompt}"],
    env: { FAKE_MODE: mode },
    ...extra,
  };
}

async function setup(
  profiles: AgentProfile[],
  settings: Partial<RunnerSettings> = {},
  mode: "local" | "hub" = "local",
  /** Pass another setup's hive to simulate a second machine on the same hub. */
  machine: { name?: string; hive?: SqliteHive } = {},
) {
  const repo = tmp("repo");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const hive = machine.hive ?? new SqliteHive(":memory:");
  const record = path.join(tmp("rec"), "calls.jsonl");
  // A hub names actors "<label>@<token name>"; mimic that to test hub mode without a server.
  const hubLike: HiveBackend = { call: (m, i, a) => hive.call(m, i, { ...a, name: `${a.name}@duy-macbook` }) };
  const host: RunnerHost = {
    backend: () => (mode === "hub" ? hubLike : hive),
    profiles: () => profiles.map((p) => ({ ...p, env: { ...p.env, FAKE_RECORD: record } })),
    settings: () => ({ worktreeRoot: null, maxParallel: 2, maxAttempts: 3, ...settings }),
    projects: () => [{ name: "demo", repo }],
    mode: () => mode,
    machine: () => machine.name ?? "duy-mbp",
    env: () => ({ ...process.env }),
  };
  const dataDir = tmp("data");
  const runner = new Runner(host, { dataDir, user: "duy", tickMs: 60_000 });
  if (!machine.hive) await hive.call("tasks.create", { id: "T-1", project: "demo", title: "Thêm trang cài đặt" }, admin);
  const calls = () =>
    existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { agent: string; prompt: string; cwd: string }) : [];
  const task = async () => (await hive.call("tasks.list", { project: "demo" }, admin)).find((t) => t.id === "T-1")!;
  return { repo, hive, runner, dataDir, calls, task };
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("rate-limit detection", () => {
  const now = new Date("2026-09-27T08:00:00Z");
  it("reads reset times from common CLI messages", () => {
    assert.equal(parseResetTime("Claude AI usage limit reached|1790000000", now)?.getTime(), 1790000000 * 1000);
    assert.equal(parseResetTime("Try again in 2 hours 13 minutes.", now)?.toISOString(), "2026-09-27T10:13:00.000Z");
    assert.equal(parseResetTime("429 RESOURCE_EXHAUSTED, retry in 30s", now)?.toISOString(), "2026-09-27T08:00:30.000Z");
    assert.equal(parseResetTime("limit resets at 2026-09-28T01:00:00Z", now)?.toISOString(), "2026-09-28T01:00:00.000Z");
    const pm = parseResetTime("5-hour limit reached ∙ resets 3pm", now)!;
    assert.equal(pm.getHours(), 15);
    assert.ok(pm > now);
    assert.equal(parseResetTime("nothing here", now), null);
  });

  it("recognises quota errors and ignores normal output", () => {
    assert.ok(detectRateLimit("Error: You've hit your usage limit."));
    assert.ok(detectRateLimit('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'));
    assert.ok(detectRateLimit("Claude AI usage limit reached|1790000000"));
    assert.equal(detectRateLimit("Implemented rate limiting middleware; tests fail on lint."), null);
  });
});

describe("pickProfile", () => {
  const now = new Date("2026-09-27T08:00:00Z");
  const load = (p: AgentProfile, extra: Partial<ProfileLoad> = {}): ProfileLoad => ({ profile: p, running: 0, cooldownUntil: null, lastUsedAt: null, ...extra });
  const needs = { role: "implement" as const, preferredProfile: null, avoidKinds: [], excludedProfiles: [] };
  const a = profile("claude-a", "claude", 10, "ok");
  const b = profile("claude-b", "claude", 10, "ok");
  const c = profile("codex-a", "codex", 20, "ok");

  it("rotates equal-priority subscriptions by least recent use", () => {
    const pick = pickProfile([load(a, { lastUsedAt: "2026-09-27T07:59:00Z" }), load(b, { lastUsedAt: "2026-09-27T07:00:00Z" }), load(c)], needs, now);
    assert.equal(pick?.profile.id, "claude-b");
  });

  it("skips busy and resting profiles, falls back to the next priority", () => {
    const pick = pickProfile([load(a, { running: 1 }), load(b, { cooldownUntil: "2026-09-27T09:00:00Z" }), load(c)], needs, now);
    assert.equal(pick?.profile.id, "codex-a");
    const expired = pickProfile([load(a, { cooldownUntil: "2026-09-27T07:00:00Z" })], needs, now);
    assert.equal(expired?.profile.id, "claude-a");
  });

  it("prefers another vendor for reviews and honours pins and roles", () => {
    assert.equal(pickProfile([load(a), load(c)], { ...needs, role: "review", avoidKinds: ["claude"] }, now)?.profile.id, "codex-a");
    assert.equal(pickProfile([load(a, { running: 1 }), load(c)], { ...needs, preferredProfile: "claude-a" }, now), null);
    const planOnly = { ...c, roles: ["plan" as const] };
    assert.equal(pickProfile([load(planOnly)], needs, now), null);
    assert.equal(pickProfile([load(a), load(b)], { ...needs, excludedProfiles: ["claude-a"] }, now)?.profile.id, "claude-b");
  });
});

describe("Runner", () => {
  it("runs an agent in its own worktree, commits leftovers and moves the task to review", async () => {
    const { repo, runner, calls, task, dataDir } = await setup([profile("claude-a", "claude", 10, "ok")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    assert.equal(run.taskTitle, "Thêm trang cài đặt");
    await runner.settle();

    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.profileId, "claude-a");
    assert.equal(done.commits, 1);
    assert.equal(done.worktree, path.join(dataDir, "worktrees", "demo", "T-1"));
    assert.match(git(repo, "show", "--name-only", "--format=%s", "ai/T-1"), /ai\(T-1\): work by claude-a\n+work-claude-a\.txt/);
    assert.equal(git(repo, "status", "--porcelain"), "", "main checkout untouched");

    const [call] = calls();
    assert.equal(call!.agent, "claude-a");
    assert.match(call!.prompt, /task T-1 of project "demo"/);
    assert.match(call!.prompt, /Thêm trang cài đặt/);

    const t = await task();
    assert.equal(t.status, "review");
    assert.equal(t.owner, null);
    assert.match(t.note ?? "", /Implemented T-1/);
    assert.match(t.note ?? "", /Branch ai\/T-1, 1 commit/);
    assert.match(runner.log(run.id), /## Prompt[\s\S]*## Output\nImplemented T-1/);
  });

  it("rotates to the next subscription when one hits its quota, continuing on the same branch", async () => {
    const { runner, calls, task, repo } = await setup([profile("claude-a", "claude", 10, "limit"), profile("codex-a", "codex", 20, "ok")]);
    const first = await runner.enqueue({ project: "demo", taskId: "T-1" });
    const before = Date.now();
    await runner.settle();

    const limited = runner.store.get(first.id)!;
    assert.equal(limited.status, "rate_limited");
    assert.match(limited.error ?? "", /usage limit/);
    const claude = runner.profileStatuses().find((p) => p.id === "claude-a")!;
    const rest = new Date(claude.cooldownUntil!).getTime() - before;
    assert.ok(rest > 2 * 3600_000 && rest < 2.5 * 3600_000, `cooldown ${rest}ms`);
    assert.equal(claude.stats.rateLimited, 1);

    const second = runner.list().find((r) => r.parentRunId === first.id)!;
    assert.equal(second.status, "succeeded");
    assert.equal(second.profileId, "codex-a");
    assert.equal(second.attempt, 2);
    assert.match(calls()[1]!.prompt, /attempt 2\. The previous agent \(claude-a\) stopped/);
    assert.match(git(repo, "log", "--format=%s", "ai/T-1"), /work by codex-a\nai\(T-1\): wip by claude-a/);
    assert.equal((await task()).status, "review");
  });

  it("queues a cross-review on another vendor after success", async () => {
    const { runner, task } = await setup([profile("claude-a", "claude", 10, "ok"), profile("codex-a", "codex", 50, "review")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();
    const review = runner.list().find((r) => r.parentRunId === run.id)!;
    assert.equal(review.role, "review");
    assert.equal(review.profileId, "codex-a", "review goes to a different vendor despite lower priority");
    assert.equal(review.status, "succeeded");
    const t = await task();
    assert.equal(t.status, "review");
    assert.match(t.note ?? "", /Implemented T-1[\s\S]*Review \(Run R-\w+ · codex-a\):\nVerdict: approve/);
  });

  it("treats a missing CLI as unavailable and moves on", async () => {
    const { runner } = await setup([
      profile("gemini-a", "gemini", 1, "ok", { bin: "/nonexistent/gemini" }),
      profile("claude-a", "claude", 10, "ok"),
    ]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const failed = runner.store.get(run.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /Không tìm thấy lệnh/);
    assert.ok(runner.profileStatuses().find((p) => p.id === "gemini-a")!.cooldownUntil);
    assert.equal(runner.list().find((r) => r.parentRunId === run.id)?.status, "succeeded");
  });

  it("cancels a running agent and gives the task back", async () => {
    const { runner, task } = await setup([profile("claude-a", "claude", 10, "sleep")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await until(() => runner.log(run.id).includes("thinking"));
    assert.equal((await task()).status, "doing");
    runner.cancel(run.id);
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.status, "cancelled");
    const t = await task();
    assert.equal(t.status, "todo");
    assert.equal(t.owner, null);
  });

  it("reports back to a hub that renames actors", async () => {
    const { runner, task } = await setup([profile("claude-a", "claude", 10, "ok")], {}, "hub");
    await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const t = await task();
    assert.equal(t.status, "review");
    assert.match(t.note ?? "", /Implemented T-1/);
  });

  it("keeps two machines on one hub token from taking the same task", async () => {
    const a = await setup([profile("claude-1", "claude", 10, "sleep")], {}, "hub", { name: "duy-mbp" });
    const b = await setup([profile("claude-1", "claude", 10, "ok")], {}, "hub", { name: "duy-imac", hive: a.hive });
    const first = await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await until(() => a.runner.log(first.id).includes("thinking"));
    assert.equal((await a.task()).owner, "claude-1.duy-mbp@duy-macbook");

    const second = await b.runner.enqueue({ project: "demo", taskId: "T-1" });
    await b.runner.settle();
    const blocked = b.runner.store.get(second.id)!;
    assert.equal(blocked.status, "failed");
    assert.match(blocked.error ?? "", /claude-1\.duy-mbp@duy-macbook/);
    assert.equal(b.calls().length, 0, "the second machine never starts the agent");

    a.runner.cancel(first.id);
    await a.runner.settle();
    assert.equal((await a.task()).owner, null);
  });

  it("reports queued and running runs to the hub in its heartbeat", async () => {
    const a = await setup([profile("claude-1", "claude", 10, "sleep")], {}, "hub", { name: "duy-mbp" });
    const run = await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await until(() => a.runner.log(run.id).includes("thinking"));
    assert.deepEqual(await a.runner.heartbeat(), { duplicate: false });
    const [m] = await a.hive.call("machines.list", {}, admin);
    assert.equal(m!.id, "runner.duy-mbp@duy-macbook");
    assert.deepEqual(m!.runs.map((r) => [r.taskId, r.status, r.profileId]), [["T-1", "running", "claude-1"]]);

    a.runner.cancel(run.id);
    await a.runner.settle();
    await a.runner.heartbeat();
    assert.deepEqual((await a.hive.call("machines.list", {}, admin))[0]!.runs, []);

    const local = await setup([profile("claude-1", "claude", 10, "ok")]);
    assert.equal(await local.runner.heartbeat(), null, "local mode has no hub to report to");
  });

  it("shares a quota cooldown with every machine on the same account, and ends it everywhere", async () => {
    const account = { account: "claude-max-duy" };
    const a = await setup([profile("claude-1", "claude", 10, "limit", account), profile("codex-1", "codex", 20, "ok")], {}, "hub", { name: "duy-mbp" });
    const b = await setup([profile("claude-2", "claude", 10, "ok", account), profile("codex-2", "codex", 20, "ok")], {}, "hub", {
      name: "duy-imac",
      hive: a.hive,
    });
    await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await a.runner.settle();
    const shared = await a.hive.call("cooldowns.list", {}, admin);
    assert.deepEqual(shared.map((c) => [c.account, c.reportedBy]), [["claude-max-duy", "runner.duy-mbp@duy-macbook"]]);

    await b.hive.call("tasks.create", { id: "T-2", project: "demo", title: "Sửa lỗi đăng nhập" }, admin);
    await b.runner.heartbeat();
    assert.equal(b.runner.profileStatuses().find((p) => p.id === "claude-2")!.cooldownFrom, "runner.duy-mbp@duy-macbook");
    const run = await b.runner.enqueue({ project: "demo", taskId: "T-2" });
    await b.runner.settle();
    assert.equal(b.runner.store.get(run.id)!.profileId, "codex-2", "machine B skips the account that ran out on machine A");

    await b.runner.resetCooldown("claude-2");
    assert.deepEqual(await a.hive.call("cooldowns.list", {}, admin), []);
    assert.ok(a.runner.profileStatuses().find((p) => p.id === "claude-1")!.cooldownUntil, "A rests until it hears from the hub");
    await a.runner.heartbeat();
    assert.equal(a.runner.profileStatuses().find((p) => p.id === "claude-1")!.cooldownUntil, null);
  });

  it("keeps a cooldown on this machine when the profile has no account", async () => {
    const a = await setup([profile("claude-1", "claude", 10, "limit"), profile("codex-1", "codex", 20, "ok")], {}, "hub");
    await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await a.runner.settle();
    assert.ok(a.runner.profileStatuses().find((p) => p.id === "claude-1")!.cooldownUntil);
    assert.deepEqual(await a.hive.call("cooldowns.list", {}, admin), []);
  });

  it("explains why a run waits and refuses duplicates", async () => {
    const { runner } = await setup([profile("claude-a", "claude", 10, "ok")]);
    runner.store.setCooldown("claude-a", "2099-01-01T00:00:00.000Z", "usage limit");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.match(runner.list()[0]!.error ?? "", /Mọi gói đang nghỉ vì quota/);
    await assert.rejects(runner.enqueue({ project: "demo", taskId: "T-1" }), /đang có run/);
    runner.cancel(run.id);
    assert.equal(runner.store.get(run.id)!.status, "cancelled");
  });
});
