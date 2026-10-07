import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, worktreeCleanupSchema, type Actor, type RunnerSettings } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { Runner, type RunnerHost } from "#desktop/main/runner/runner.ts";
import { cleanupReason, deleteWorktree, registeredWorktrees } from "#desktop/main/runner/worktree-admin.ts";
import { ensureWorktree, hasBranch } from "#desktop/main/runner/worktree.ts";

const admin: Actor = { name: "admin", role: "admin" };
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(mode: "local" | "hub" = "local") {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hive-worktree-admin-")));
  const repo = path.join(dir, "repo"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@example.com"); git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { project: "demo", id: "T-1", title: "Task" }, admin);
  let clock = new Date();
  let settings: RunnerSettings = { worktreeRoot: null, maxParallel: 1, maxAttempts: 1, acceptHubRuns: false, gateRunner: false, worktreeCleanup: worktreeCleanupSchema.parse({ enabled: false }) };
  const profile = { ...AGENT_TEMPLATES.claude, bin: process.execPath, args: [path.join(import.meta.dirname, "fixtures/fake-agent.mjs"), "{prompt}"], env: { FAKE_MODE: "ok" } };
  const host: RunnerHost = { backend: () => hive, profiles: () => [profile], projects: () => [{ name: "demo", repo }], settings: () => settings, mode: () => mode, machine: () => "test", env: () => ({ PATH: process.env.PATH }), applyWorktreeCleanup: cleanup => { settings = { ...settings, worktreeCleanup: cleanup }; } };
  const runner = new Runner(host, { dataDir: dir, now: () => clock, diffReview: false, fetchRetryMs: [] });
  const root = path.join(dir, "worktrees");
  const wt = ensureWorktree(repo, path.join(root, "demo", "T-1"), "T-1", null);
  return { dir, repo, hive, runner, root, wt, host, settings: () => settings, advance: () => { clock = new Date(+clock + 61_000); }, close: () => { runner.store.db.close(); hive.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("runner worktree administration", () => {
  it("lists sizes/status; refuses active runs and stale snapshots; deletes only the worktree and recreates the retained branch", async () => {
    const f = await fixture();
    try {
      const entry = (await f.runner.worktrees()).entries[0]!;
      assert.equal(entry.taskStatus, "todo"); assert.equal(entry.merged, true); assert.ok(entry.bytes! > 0); assert.ok((await f.runner.worktrees()).freeBytes! > 0);
      await assert.rejects(deleteWorktree({ name: "demo", repo: f.repo }, f.root, entry, true, () => true), error => (error as { key: string }).key === "errors.worktreeActive");
      assert.equal(existsSync(f.wt.path), true, "checks active runs immediately before removal too");
      const run = f.runner.store.insert({ project: "demo", taskId: "T-1", taskTitle: "Task", role: "implement", attempt: 1, maxAttempts: 1 }, new Date().toISOString());
      assert.equal((await f.runner.manageWorktrees([entry], true))[0]?.ok, false);
      f.runner.store.update(run.id, { status: "cancelled" });
      writeFileSync(path.join(f.wt.path, "draft.txt"), "uncommitted\n");
      assert.equal((await f.runner.manageWorktrees([entry], true))[0]?.ok, false, "a force flag never bypasses snapshot checks");
      const changed = (await f.runner.worktrees(true)).entries[0]!;
      assert.equal(changed.dirty, true);
      assert.equal((await f.runner.manageWorktrees([changed]))[0]?.ok, false);
      assert.equal((await f.runner.manageWorktrees([changed], true))[0]?.ok, true);
      assert.equal(existsSync(f.wt.path), false); assert.equal(hasBranch(f.repo, f.wt.branch), true);
      assert.equal(f.runner.store.worktreeLogs()[0]?.ok, true);
      const recreated = ensureWorktree(f.repo, f.wt.path, "T-1", f.wt.baseSha);
      assert.equal(git(recreated.path, "rev-parse", "HEAD"), entry.head);
      assert.equal(existsSync(path.join(recreated.path, "draft.txt")), false);
    } finally { f.close(); }
  });

  it("uses registered ai/task paths only; ignores unrelated worktrees and service symlinks", async () => {
    const f = await fixture();
    try {
      git(f.repo, "worktree", "add", "-q", "-b", "user", path.join(f.root, "demo", "user"));
      const outside = path.join(f.dir, "outside"); git(f.repo, "worktree", "add", "-q", "-b", "ai/Other", outside);
      assert.equal((await f.runner.worktrees()).entries.length, 1);
      const linkedRoot = path.join(f.dir, "linked"); mkdirSync(linkedRoot); symlinkSync(path.join(f.root, "demo"), path.join(linkedRoot, "demo"));
      assert.deepEqual(await registeredWorktrees({ name: "demo", repo: f.repo }, linkedRoot), []);
      assert.equal(existsSync(outside), true);
    } finally { f.close(); }
  });

  it("auto-cleans only done, clean, merged or expired worktrees; honors disabling and records low-disk cleanup", async () => {
    const f = await fixture();
    try {
      const entry = (await f.runner.worktrees()).entries[0]!;
      const policy = worktreeCleanupSchema.parse({ minFreeGb: 1000 });
      assert.equal(cleanupReason(entry, policy, new Date()), null);
      assert.equal(cleanupReason({ ...entry, taskStatus: "done", dirty: true }, policy, new Date()), null);
      assert.equal(cleanupReason({ ...entry, taskStatus: "done", active: true }, policy, new Date()), null);
      assert.equal(cleanupReason({ ...entry, taskStatus: "done", merged: false, taskUpdatedAt: "2020-01-01T00:00:00.000Z" }, policy, new Date()), "retention");
      await f.hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
      await f.runner.cleanWorktrees(); assert.equal(existsSync(f.wt.path), true, "cleanup is explicitly off");
      f.host.applyWorktreeCleanup!(policy); f.advance();
      await f.runner.cleanWorktrees();
      assert.equal(existsSync(f.wt.path), false); assert.equal(hasBranch(f.repo, f.wt.branch), true);
      assert.equal(f.runner.store.worktreeLogs()[0]?.reason, "lowDisk");
    } finally { f.close(); }
  });

  it("delivers delete and settings commands with durable receipts even when intake is off", async () => {
    const f = await fixture("hub");
    try {
      await f.runner.heartbeat();
      const machines = await f.hive.call("machines.list", {}, admin);
      const machineId = machines[0]!.id;
      const entry = (await f.runner.worktrees()).entries[0]!;
      const command = await f.hive.call("machines.manageWorktrees", { machineId, targets: [entry] }, admin);
      await Promise.all([f.runner.heartbeat(), f.runner.heartbeat()]);
      assert.equal(f.runner.store.worktreeLogs().length, 1, "overlapping heartbeats apply the command once");
      assert.equal(existsSync(f.wt.path), false); assert.ok(f.runner.store.worktreeResult(command.id)?.[0]?.ok);
      ensureWorktree(f.repo, f.wt.path, "T-1", entry.head);
      await f.runner.heartbeat();
      assert.equal(existsSync(f.wt.path), true, "retrying a receipt never deletes a recreated worktree");
      assert.ok((await f.hive.call("machines.worktrees", { machineId }, admin)).commands[0]?.completedAt);
      const change = await f.hive.call("machines.manageWorktrees", { machineId, cleanup: { enabled: false, retentionDays: 7, minFreeGb: 5 } }, admin);
      await f.runner.heartbeat(); await f.runner.heartbeat();
      assert.equal(f.settings().worktreeCleanup?.retentionDays, 7);
      assert.deepEqual(f.runner.store.worktreeResult(change.id), []);
    } finally { f.close(); }
  });
});
