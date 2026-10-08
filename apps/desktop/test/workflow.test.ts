import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteHive } from "@xdev-hive/core/node";
import { mergeQueueConfigSchema, type Actor, type DesktopProject } from "@xdev-hive/core";
import { runMergeBatch } from "#desktop/main/runner/merge-queue.ts";
import { AutoReleaseWorker } from "#desktop/main/runner/auto-release.ts";

// These boundaries used to be tested separately; a real Git SHA must survive every handoff.
for (const scenario of ["success", "red", "conflict", "deploy-failure"] as const) {
  it(`Chat → dispatch → review → Git merge → release: ${scenario}`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-workflow-"));
    const hive = new SqliteHive(":memory:");
    const admin: Actor = { name: "admin", role: "admin" };
    const machine: Actor = { name: "runner.gate", role: "agent" };
    const instance = "aabbccdd";
    const repo = path.join(root, "repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const profiles = ["codex-1", "claude-2"].map(id => ({ id, label: id, kind: id.split("-")[0]!, enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, redispatch: true }));
    const beat = () => hive.call("machines.heartbeat", { machine: "gate", instance, projects: ["app"], acceptsRuns: true, gateRunner: true, profiles, maxParallel: 1 }, machine);
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
      git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", os.devNull);
      writeFileSync(path.join(repo, "feature.txt"), "base\n");
      git("add", "."); git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      await beat();
      const sent = await hive.call("chat.send", { project: "app", machineId: machine.name, text: "Build the feature" }, admin);
      await hive.call("chat.progress", { replyId: sent.reply.id, text: "Planning" }, machine);
      const leader: Actor = { name: "leader", role: "agent", chatReply: sent.reply.id, access: { projects: { app: "contribute" } } };
      const propose = (id: string) => hive.call("chat.propose", { action: { kind: "plan.create", spec: { key: `project/app/${id.toLowerCase()}`, title: id, content: "# Feature\nShip the checked feature." }, tasks: [{ id, title: id, acceptance: "Checked code reaches release", dependsOn: [] }], batches: [{ title: "Feature", taskIds: [id] }] }, reason: "Requested" }, leader);
      const refused = await propose("REFUSED");
      assert.equal((await hive.call("chat.decide", { actionId: refused.id, accept: false }, admin)).status, "dismissed");
      assert.equal(await hive.call("docs.get", { key: "project/app/refused" }, admin), null);
      assert.deepEqual(await hive.call("tasks.list", { project: "app" }, admin), []);
      const plan = await propose("FEATURE");
      assert.equal((await hive.call("chat.decide", { actionId: plan.id, accept: true }, admin)).status, "done");
      await hive.call("chat.finish", { replyId: sent.reply.id, status: "done", text: "Plan ready" }, machine);
      const request = (await beat()).runRequests[0]!;
      assert.equal(request.taskId, "FEATURE");
      await hive.call("runs.requestResult", { id: request.id, status: "accepted", runId: "implement-1" }, machine);
      const at = new Date().toISOString();
      await hive.call("runs.push", { machine: "gate", runs: [{ runId: "implement-1", project: "app", taskId: "FEATURE", taskTitle: "Feature", role: "implement", status: "failed", profileId: request.profileId, branch: "ai/FEATURE", baseSha: base, createdAt: at }] }, machine);
      const retry = (await beat()).runRequests[0]!;
      assert.equal(retry.redispatch?.branch, "ai/FEATURE");
      assert.notEqual(retry.profileId, request.profileId);
      await hive.call("runs.requestResult", { id: retry.id, status: "accepted", runId: "implement-2" }, machine);
      git("checkout", "-qb", "ai/FEATURE");
      writeFileSync(path.join(repo, "feature.txt"), "feature\n");
      git("add", "."); git("commit", "-qm", "feature"); git("checkout", "-q", "main");
      if (scenario === "conflict") {
        writeFileSync(path.join(repo, "feature.txt"), "competing\n");
        git("add", "."); git("commit", "-qm", "competing");
      }
      const run = { project: "app", taskId: "FEATURE", taskTitle: "Feature", status: "succeeded" as const, branch: "ai/FEATURE", createdAt: at, finishedAt: at };
      await hive.call("runs.push", { machine: "gate", runs: [{ ...run, runId: "implement-2", role: "implement", profileId: retry.profileId }] }, machine);
      await hive.call("tasks.update", { id: "FEATURE", status: "review" }, admin);
      await hive.call("mergeQueue.configure", { project: "app", config: mergeQueueConfigSchema.parse({ enabled: true, machineId: machine.name, maxBranches: 1, commands: [scenario === "red" ? "false" : "test -f feature.txt"], mode: "push" }) }, admin);
      assert.equal(await hive.call("mergeQueue.take", { project: "app", instance }, machine), null, "implementation alone cannot land");
      await hive.call("runs.push", { machine: "gate", runs: [{ ...run, runId: "review", role: "review", profileId: request.profileId, verdict: "approve" }] }, machine);
      await hive.call("sdlc.setProject", { project: "app", settings: { gates: { release: "auto" }, releaseMachine: machine.name } }, admin);
      const batch = (await hive.call("mergeQueue.take", { project: "app", instance }, machine))!;
      const result = await runMergeBatch(batch, { repo, directory: path.join(root, "merge"), local: true, progress: async () => {}, publish: async sha => { git("merge", "--ff-only", sha); }, releaseVersion: async () => "1.2.3" });
      await hive.call("mergeQueue.finish", { id: batch.id, instance, result }, machine);
      const releases = await hive.call("autoRelease.list", { project: "app" }, admin);
      if (scenario === "red" || scenario === "conflict") {
        assert.equal(result.status, "failed");
        assert.deepEqual(releases.releases, []);
        const tasks = await hive.call("tasks.list", { project: "app" }, admin);
        assert.equal(tasks.find(t => t.id === "FEATURE")?.status, "blocked");
        assert.ok(tasks.some(t => t.id.startsWith(scenario === "red" ? "INT-" : "LAND-")));
        return;
      }
      assert.equal(result.status, "landed");
      assert.equal(releases.releases[0]?.batch.sha, git("rev-parse", "main"));
      assert.equal((await hive.call("tasks.list", { project: "app" }, admin))[0]?.status, "done");
      const log = path.join(root, "commands.txt");
      const command = (stage: string) => [process.execPath, "-e", `const fs=require('node:fs'); const a=require('node:assert/strict'); a.equal(fs.readFileSync('feature.txt','utf8'),'feature\\n'); a.equal(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),process.env.HIVE_RELEASE_SHA); fs.appendFileSync(${JSON.stringify(log)},'${stage}\\n'); ${scenario === "deploy-failure" && stage === "deploy" ? "process.exit(1)" : ""}`];
      const project: DesktopProject = { name: "app", repo, autoRelease: { prepare: command("prepare"), release: command("release"), deploy: command("deploy"), checkLogs: command("logs"), appRollout: false, timeoutMinutes: 1 } };
      const worker = new AutoReleaseWorker({ backend: () => hive, actor: () => machine, projects: () => [project], env: () => process.env, allowed: () => true }, path.join(root, "release"));
      await worker.poll(); await worker.settle(); await worker.poll(); await worker.settle(); worker.stop();
      const view = await hive.call("autoRelease.list", { project: "app" }, admin);
      assert.equal(view.releases[0]?.state, scenario === "success" ? "succeeded" : "failed");
      assert.equal(view.paused, scenario === "deploy-failure");
      assert.equal(readFileSync(log, "utf8"), scenario === "success" ? "prepare\nrelease\ndeploy\nlogs\n" : "prepare\nrelease\ndeploy\n");
      if (scenario === "deploy-failure") {
        assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).filter(t => t.id === "OPS-release-1.2.3").length, 1);
        assert.equal(await hive.call("mergeQueue.take", { project: "app", instance }, machine), null);
      }
    } finally { hive.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
