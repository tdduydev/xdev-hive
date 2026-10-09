import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutoReleaseRecord, DesktopProject } from "@xdev-hive/core";
import { executeRelease } from "#desktop/main/runner/auto-release.ts";
const job = { batchId: "green-1", batch: { version: "1.2.3", sha: "a".repeat(40), taskIds: ["R-1"] } } as AutoReleaseRecord;
const project: DesktopProject = { name: "app", repo: "/fixture", autoRelease: { prepare: ["prepare"], release: ["release"], deploy: ["deploy"], checkLogs: ["logs"], timeoutMinutes: 1, appRollout: true } };
describe("Gate machine release execution (fake commands only)", () => {
  it("prepares version/roadmap then releases, deploys, rolls out 100% and checks logs", async () => {
    const steps: string[] = [];
    const result = await executeRelease(job, project, async (argv, env) => { steps.push(argv[0]!); assert.equal(env.HIVE_RELEASE_VERSION, "1.2.3"); assert.equal(env.HIVE_RELEASE_TASKS_JSON, '["R-1"]'); }, async () => { steps.push("rollout"); });
    assert.deepEqual(steps, ["prepare", "release", "deploy", "rollout", "logs"]); assert.equal(result.success, true);
  });
  it("stops at each failed stage without running later commands", async () => {
    for (const fail of ["prepare", "release", "deploy", "rollout"]) {
      const steps: string[] = [];
      const run = async (argv: string[]) => { steps.push(argv[0]!); if (argv[0] === fail) throw new Error("private secret in process output"); };
      const result = await executeRelease(job, project, run, () => run(["rollout"]));
      assert.equal(result.success, false); assert.equal(result.step, fail); assert.equal(steps.at(-1), fail); assert.ok(!JSON.stringify(result).includes("secret"));
    }
  });
  it("reports log-check warnings after successful deployment", async () => {
    const result = await executeRelease(job, project, async argv => { if (argv[0] === "logs") throw new Error("repeat error"); }, async () => {});
    assert.deepEqual(result, { success: true, step: "checkLogs", warning: true });
  });
  it("supports a service without deploy or app rollout", async () => {
    const steps: string[] = [];
    const result = await executeRelease(job, { ...project, autoRelease: { ...project.autoRelease!, deploy: undefined, checkLogs: undefined, appRollout: false } }, async argv => { steps.push(argv[0]!); }, async () => assert.fail("no rollout"));
    assert.deepEqual(steps, ["prepare", "release"]); assert.equal(result.success, true);
  });
  it("deploys hub-only batches without preparing, publishing or rolling out app", async () => {
    const steps: string[] = [];
    const result = await executeRelease(job, project, async (argv, env) => { steps.push(argv[0]!); assert.equal(env.HIVE_RELEASE_SCOPE, "hub"); }, async () => assert.fail("no rollout"), async () => {}, "hub");
    assert.deepEqual(steps, ["deploy", "logs"]);
    assert.deepEqual(result, { success: true, step: "checkLogs", warning: false });
  });
  it("fails a hub-only batch without a deploy command", async () => {
    const result = await executeRelease(job, { ...project, autoRelease: { ...project.autoRelease!, deploy: undefined } }, async () => assert.fail("no app command"), async () => {}, async () => {}, "hub");
    assert.deepEqual(result, { success: false, step: "deploy", warning: false });
  });
});

it("persists a lost result receipt and retries it without re-running release commands", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { SqliteHive } = await import("@xdev-hive/core/node");
  const { AutoReleaseWorker } = await import("#desktop/main/runner/auto-release.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "hive-release-receipt-")); const h = new SqliteHive(":memory:");
  const admin = { name: "admin", role: "admin" as const }; const actor = { name: "gate", role: "agent" as const };
  try {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    writeFileSync(path.join(repo, "fixture.txt"), "fixture\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("add", "fixture.txt"); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    const originalSha = git("rev-parse", "HEAD");
    git("checkout", "-b", "landed");
    writeFileSync(path.join(repo, "fixture.txt"), "landed\n");
    git("add", "fixture.txt"); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "landed");
    const landedSha = git("rev-parse", "HEAD");
    git("checkout", "main");
    writeFileSync(path.join(repo, "fixture.txt"), "user edit\n");
    await h.call("tasks.create", { id: "T-1", project: "app", title: "Landed" }, admin);
    await h.call("tasks.update", { id: "T-1", status: "done" }, admin);
    await h.call("sdlc.setProject", { project: "app", settings: { gates: { release: "auto" }, releaseMachine: actor.name } }, admin);
    await h.call("autoRelease.green", { project: "app", batchId: "green-1", sha: landedSha, targetBranch: "main", version: "1.2.3", taskIds: ["T-1"], checks: [{ name: "fixture", passed: true }], landed: true }, actor);
    const counter = path.join(dir, "counter.txt");
    let dropReply = true;
    const backend = { call: async (...args: Parameters<typeof h.call>) => {
      const result = await h.call(...args);
      if (args[0] === "autoRelease.result" && dropReply) { dropReply = false; throw new Error("Reply lost"); }
      return result;
    } } as typeof h;
    const commands: DesktopProject = { name: "app", repo, autoRelease: { prepare: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('fixture.txt', 'utf8'), 'landed\\n')"], release: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'once\\n')`], appRollout: false, timeoutMinutes: 1 } };
    const receipts = path.join(dir, "receipts");
    const worker = new AutoReleaseWorker({ backend: () => backend, actor: () => actor, projects: () => [commands], env: () => process.env, allowed: () => true }, receipts);
    await worker.poll(); await worker.settle().catch(() => {});
    assert.equal(readFileSync(counter, "utf8"), "once\n");
    assert.equal(readdirSync(receipts).filter(n => n.endsWith(".json")).length, 1);
    await worker.poll(); await worker.settle();
    assert.equal(readFileSync(counter, "utf8"), "once\n");
    assert.equal(readdirSync(receipts).filter(n => n.endsWith(".json")).length, 0);
    assert.equal((await h.call("autoRelease.list", { project: "app" }, admin)).releases[0]?.state, "succeeded");
    assert.equal(git("rev-parse", "HEAD"), originalSha);
    assert.equal(git("branch", "--show-current"), "main");
    assert.equal(readFileSync(path.join(repo, "fixture.txt"), "utf8"), "user edit\n");
    worker.stop();
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps local service release commands and rejects malformed command settings", async () => {
  const { projectSchema } = await import("@xdev-hive/core/node");
  const parsed = projectSchema.parse({ name: "app", repo: "/fixture", autoRelease: { prepare: ["prepare"], release: ["release"] } });
  assert.equal(parsed.autoRelease?.appRollout, false);
  assert.equal(parsed.autoRelease?.timeoutMinutes, 60);
  assert.throws(() => projectSchema.parse({ name: "app", repo: "/fixture", autoRelease: { prepare: [], release: ["release"] } }));
});
