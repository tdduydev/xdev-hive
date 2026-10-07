import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteHive, migrationIndex } from "#core/node.ts";
import { mergeQueueConfigSchema, type Actor, type MergeResult } from "#core/index.ts";
const admin: Actor = {
  name: "admin",
  role: "admin"
};
const machine: Actor = {
  name: "runner.gate",
  role: "agent"
};
const instance = "aabbccdd";
const sha = "a".repeat(40);
async function setup() {
  let now = "2026-10-07T08:00:00.000Z";
  const hive = new SqliteHive(":memory:", {
    now: () => new Date(now),
    backup: async () => ({file: "/tmp/mock-merge-backup.db"})
  });
  const beat = async (gateRunner = true) => hive.call("machines.heartbeat", {
    machine: "gate",
    instance,
    projects: ["demo"],
    gateRunner
  }, machine);
  await beat();
  const config = mergeQueueConfigSchema.parse({
    enabled: true,
    machineId: machine.name,
    waitMinutes: 5,
    maxBranches: 2,
    commands: ["true"],
    mode: "push"
  });
  await hive.call("mergeQueue.configure", {
    project: "demo",
    config
  }, admin);
  const add = async (id: string, at = now, runId = `run-${id}`) => {
    if (!hive.db.prepare("SELECT id FROM tasks WHERE id=?").get(id)) await hive.call("tasks.create", {
      id,
      project: "demo",
      title: id,
      kind: "feature"
    }, admin);
    await hive.call("tasks.update", {
      id,
      status: "review"
    }, admin);
    hive.db.prepare(`INSERT INTO run_records(machine_id,run_id,machine,project,task_id,task_title,role,status,branch,created_at,finished_at,updated_at) VALUES (?,?,'gate','demo',?,?,'implement','succeeded',?,?,?,?)`).run(machine.name, runId, id, id, `ai/${id}`, at, at, at);
  };
  const take = () => hive.call("mergeQueue.take", {
    project: "demo",
    instance
  }, machine);
  const finish = (id: number, result: MergeResult) => hive.call("mergeQueue.finish", {
    id,
    instance,
    result
  }, machine);
  const view = () => hive.call("mergeQueue.get", {
    project: "demo"
  }, admin);
  return {
    hive,
    beat,
    add,
    take,
    finish,
    view,
    config,
    advance: async () => {
      now = "2026-10-07T08:06:00.000Z";
      await beat();
    }
  };
}
const result = (tasks: string[], status: MergeResult["status"] = "landed"): MergeResult => ({
  status,
  sha,
  url: null,
  step: status,
  log: "gate output",
  outcomes: tasks.map(taskId => ({
    taskId,
    status: "included",
    sha,
    reason: ""
  }))
});
it("FIFO starts at size or age, deduplicates takes/results, and journals done only after landing", async () => {
  const s = await setup();
  try {
    await s.add("T-2");
    assert.equal(await s.take(), null);
    await s.add("T-1", "2026-10-07T07:59:00.000Z");
    const b = (await s.take())!;
    await assert.rejects(s.hive.call("mergeQueue.configure", {project: "demo", config: {...s.config, enabled: false, machineId: null}}, admin));
    assert.deepEqual(b.items.map(i => i.taskId), ["T-1", "T-2"]);
    assert.equal((await s.take())!.id, b.id);
    await assert.rejects(s.finish(b.id, result(["T-1"])));
    await assert.rejects(s.hive.call("mergeQueue.finish", {
      id: b.id,
      instance,
      result: result(["T-1", "T-2"])
    }, {
      name: "runner.other",
      role: "agent"
    }));
    await s.finish(b.id, result(["T-1", "T-2"]));
    await s.finish(b.id, result(["T-1", "T-2"]));
    assert.equal((await s.hive.call("tasks.list", {
      project: "demo"
    }, admin)).filter(t => t.status === "done").length, 2);
    assert.equal((await s.hive.call("tasks.notes", {
      id: "T-1"
    }, admin)).filter(n => n.status === "done").length, 1);
    assert.equal(await s.take(), null);
    await s.add("T-3");
    assert.equal(await s.take(), null);
    await s.advance();
    assert.ok(await s.take());
  } finally {
    s.hive.close();
  }
});
it("red batches create INT/LAND once, retain evidence, and leave failures for dispatch", async () => {
  const s = await setup();
  try {
    await s.add("T-1");
    await s.add("T-2");
    const b = (await s.take())!;
    const r = result(["T-1", "T-2"], "failed");
    r.step = "gate 2: false";
    r.outcomes[0] = {
      taskId: "T-1",
      status: "conflict",
      reason: "file.ts\n<<<<<<< ours\n=======\n>>>>>>> theirs"
    };
    await s.finish(b.id, r);
    await s.finish(b.id, r);
    const tasks = await s.hive.call("tasks.list", {
      project: "demo"
    }, admin);
    assert.equal(tasks.find(t => t.id === "LAND-T-1")?.status, "todo");
    assert.equal(tasks.find(t => t.id === `INT-${b.id}`)?.status, "todo");
    assert.equal(tasks.filter(t => t.status === "blocked").length, 2);
    assert.equal((await s.view()).batches[0]!.result?.outcomes[0]?.reason, r.outcomes[0].reason);
  } finally {
    s.hive.close();
  }
});
it("MRs keep tasks in review until the same checked commit lands; newer runs remain review", async () => {
  const s = await setup();
  try {
    await s.hive.call("mergeQueue.configure", {
      project: "demo",
      config: {
        ...s.config,
        mode: "mr"
      }
    }, admin);
    await s.add("T-1");
    await s.add("T-2");
    const b = (await s.take())!;
    const pending = {
      ...result(["T-1", "T-2"], "awaiting"),
      url: "https://example.test/mr/1"
    };
    await s.finish(b.id, pending);
    assert.ok((await s.hive.call("tasks.list", {
      project: "demo"
    }, admin)).every(t => t.status === "review"));
    await assert.rejects(s.finish(b.id, {
      ...pending,
      status: "landed",
      sha: "b".repeat(40)
    }));
    await s.add("T-2", "2026-10-07T08:01:00.000Z", "new-run");
    await s.finish(b.id, {
      ...pending,
      status: "landed"
    });
    assert.equal((await s.hive.call("tasks.list", {
      project: "demo"
    }, admin)).find(t => t.id === "T-2")?.status, "review");
  } finally {
    s.hive.close();
  }
});
it("requires project rights, an opted-in assigned gate, and an unpaused service", async () => {
  const s = await setup();
  try {
    await assert.rejects(s.hive.call("mergeQueue.configure", {
      project: "demo",
      config: s.config
    }, machine));
    await assert.rejects(s.hive.call("mergeQueue.get", {
      project: "demo"
    }, {
      name: "outsider",
      role: "member",
      access: {
        projects: {
          other: "view"
        }
      }
    }));
    await s.add("T-1");
    await s.add("T-2");
    await s.beat(false);
    assert.equal(await s.take(), null);
    await s.beat();
    s.hive.db.prepare("UPDATE machines SET update_draining = 1 WHERE id = ?").run(machine.name);
    assert.equal(await s.take(), null, "an app update must drain without starting a merge");
    s.hive.db.prepare("UPDATE machines SET update_draining = 0 WHERE id = ?").run(machine.name);
    await s.hive.call("agents.stop", {
      project: "demo"
    }, admin);
    assert.equal(await s.take(), null);
    await s.hive.call("agents.resume", {
      project: "demo"
    }, admin);
    assert.ok(await s.take());
  } finally {
    s.hive.close();
  }
});
it("appends migration with existing tasks and machines intact, role defaults off", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-merge-migration-"));
  const file = path.join(dir, "hive.db");
  try {
    const hive = new SqliteHive(file);
    await hive.call("tasks.create", {
      id: "OLD",
      project: "demo",
      title: "Old"
    }, admin);
    await hive.call("machines.heartbeat", {
      machine: "gate",
      instance
    }, machine);
    const before = migrationIndex("ALTER TABLE machines ADD COLUMN gate_runner");
    hive.db.exec(`DROP TABLE merge_repairs; DROP TABLE merge_batch_items; DROP TABLE merge_batches; ALTER TABLE machines DROP COLUMN gate_runner; PRAGMA user_version=${before}`);
    hive.close();
    const upgraded = new SqliteHive(file, { migrateTo: before + 1 });
    try {
      assert.equal((await upgraded.call("machines.list", {}, admin))[0]?.gateRunner, false);
      assert.equal((await upgraded.call("tasks.list", {
        project: "demo"
      }, admin))[0]?.id, "OLD");
      assert.deepEqual((await upgraded.call("mergeQueue.get", {
        project: "demo"
      }, admin)).batches, []);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
it("a disabled queue refuses progress, while a restarted gate resumes the same batch without stealing it", async () => {
  const s = await setup();
  try {
    await s.add("T-1");
    await s.add("T-2");
    const b = (await s.take())!;
    await s.hive.call("machines.heartbeat", {
      machine: "gate",
      instance: "eeff0011",
      projects: ["demo"],
      gateRunner: true
    }, machine);
    const resumed = await s.hive.call("mergeQueue.take", {
      project: "demo",
      instance: "eeff0011"
    }, machine);
    assert.equal(resumed?.id, b.id);
    assert.equal(resumed?.instance, b.instance);
    await s.hive.call("mergeQueue.configure", {
      project: "demo",
      config: {
        ...s.config,
        enabled: false
      }
    }, admin);
    await assert.rejects(s.hive.call("mergeQueue.progress", {
      id: b.id,
      instance,
      step: "publish"
    }, machine));
    const failed = result(["T-1", "T-2"], "failed");
    failed.log = "line\ngh" + "p_" + "x".repeat(40) + "\nlast";
    await s.finish(b.id, failed);
    assert.match((await s.view()).batches[0]!.log, /line hidden/);
    assert.match((await s.view()).batches[0]!.log, /last/);
  } finally {
    s.hive.close();
  }
});
it("accepts continuation branch refs and rejects unsafe target refs before configuring", async () => {
  const { validMergeRef } = await import('#core/merge-queue.ts');
  assert.equal(validMergeRef('ai/T-1+R-new'), true);
  for (const target of ['-main', 'main..old', 'foo//bar', 'foo.lock', 'refs/.hidden', 'main:other']) {
    assert.equal(mergeQueueConfigSchema.safeParse({target}).success, false, target);
  }
});

it("archived services cannot publish or create repair tasks, and deletion removes queue children", async () => {
  const s = await setup();
  try {
    await s.add("T-1"); await s.add("T-2");
    const batch = (await s.take())!;
    await s.hive.call("projects.archive", {project: "demo"}, admin);
    await assert.rejects(s.hive.call("mergeQueue.progress", {id: batch.id, instance, step: "publish"}, machine));
    await s.finish(batch.id, result(["T-1", "T-2"], "failed"));
    assert.equal(s.hive.db.prepare("SELECT count(*) AS n FROM tasks WHERE id LIKE 'INT-%'").get()?.n, 0);
    await s.hive.call("projects.delete", {project: "demo", confirm: "demo"}, admin);
    assert.equal(s.hive.db.prepare("SELECT count(*) AS n FROM merge_batch_items").get()?.n, 0);
    assert.equal(s.hive.db.prepare("SELECT count(*) AS n FROM merge_batches").get()?.n, 0);
    assert.equal(s.hive.db.prepare("SELECT value FROM settings WHERE key='mergeQueue:demo'").get(), undefined);
  } finally { s.hive.close(); }
});

it("landing an integration repair completes its unchanged blocked source tasks", async () => {
  const s = await setup();
  try {
    await s.add("T-1"); await s.add("T-2");
    const batch = (await s.take())!;
    await s.finish(batch.id, result(["T-1", "T-2"], "failed"));
    const repair = `INT-${batch.id}`;
    await s.hive.call("mergeQueue.configure", {project: "demo", config: {...s.config, maxBranches: 1}}, admin);
    await s.add(repair, "2026-10-07T08:01:00.000Z");
    const fixed = (await s.take())!;
    await s.finish(fixed.id, result([repair]));
    const tasks = await s.hive.call("tasks.list", {project: "demo"}, admin);
    assert.ok(tasks.every(task => task.status === "done"));
    assert.match(tasks.find(task => task.id === "T-1")!.note!, /Đã vào main/);
  } finally { s.hive.close(); }
});


it("emits a release after landing and pauses merge work after a failed release", async () => {
  const s = await setup();
  try {
    await s.hive.call("sdlc.setProject", { project: "demo", settings: { gates: { release: "auto" }, releaseMachine: machine.name } }, admin);
    await s.add("T-1"); await s.add("T-2");
    const batch = (await s.take())!;
    await s.finish(batch.id, { ...result(["T-1", "T-2"]), version: "1.2.3" });
    await s.finish(batch.id, { ...result(["T-1", "T-2"]), version: "1.2.3" });
    const releases = await s.hive.call("autoRelease.list", { project: "demo" }, admin);
    assert.equal(releases.releases.length, 1);
    const release = releases.releases[0]!;
    assert.deepEqual(release.batch.taskIds, ["T-1", "T-2"]);
    assert.equal(release.batch.sha, sha);
    assert.deepEqual(release.batch.checks, [{ name: "1: true", passed: true }]);
    await s.hive.call("autoRelease.take", { project: "demo" }, machine);
    await s.hive.call("autoRelease.result", { project: "demo", batchId: release.batchId, success: false, step: "deploy" }, machine);
    await s.add("T-3"); await s.add("T-4");
    assert.equal(await s.take(), null);
    await s.hive.call("autoRelease.resume", { project: "demo" }, admin);
    assert.ok(await s.take());
  } finally { s.hive.close(); }
});

it("waits for MR landing before emitting its checked release identity", async () => {
  const s = await setup();
  try {
    await s.hive.call("sdlc.setProject", { project: "demo", settings: { gates: { release: "human" }, releaseMachine: machine.name } }, admin);
    await s.hive.call("mergeQueue.configure", { project: "demo", config: { ...s.config, mode: "mr" } }, admin);
    await s.add("T-1"); await s.add("T-2");
    const batch = (await s.take())!;
    const checked = { ...result(["T-1", "T-2"], "awaiting"), version: "1.2.3", url: "https://example.test/mr/1" };
    await s.finish(batch.id, checked);
    assert.deepEqual((await s.hive.call("autoRelease.list", { project: "demo" }, admin)).releases, []);
    await s.finish(batch.id, { ...checked, status: "landed" });
    assert.equal((await s.hive.call("autoRelease.list", { project: "demo" }, admin)).releases[0]?.state, "waiting");
  } finally { s.hive.close(); }
});
