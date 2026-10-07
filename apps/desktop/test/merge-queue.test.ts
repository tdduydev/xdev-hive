import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { mergeQueueConfigSchema, type MergeBatch } from "@xdev-hive/core";
import { runMergeBatch } from "#desktop/main/runner/merge-queue.ts";
function fixture(commands = ["true"]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-merge-"));
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1"
    }
  }).trim();
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", os.devNull);
  writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const branch = (id: string, content: string, file = "shared.txt") => {
    git("checkout", "-qb", `ai/${id}`, base);
    writeFileSync(path.join(repo, file), content);
    git("add", ".");
    git("commit", "-qm", id);
    git("checkout", "-q", "main");
  };
  branch("T-1", "first\n");
  branch("T-2", "second\n");
  branch("T-3", "third\n", "third.txt");
  const batch: MergeBatch = {
    id: 1,
    project: "demo",
    machineId: "gate",
    instance: "aabbccdd",
    config: mergeQueueConfigSchema.parse({
      commands,
      mode: "push"
    }),
    items: ["T-1", "T-2", "T-3"].map(taskId => ({
      taskId,
      branch: `ai/${taskId}`,
      runId: taskId,
      machineId: "gate",
      readyAt: "2026-10-07T08:00:00.000Z"
    })),
    status: "running",
    step: "prepare",
    log: "",
    result: null,
    createdAt: "2026-10-07T08:00:00.000Z"
  };
  return {
    root,
    repo,
    git,
    base,
    batch,
    options: {
      repo,
      directory: path.join(root, "batch"),
      local: true,
      progress: async () => {}
    },
    close: () => rmSync(root, {
      recursive: true,
      force: true
    })
  };
}
it("isolates conflicts, runs gate on accepted branches and publishes once; user checkout stays intact", async () => {
  const s = fixture();
  try {
    writeFileSync(path.join(s.repo, "personal.txt"), "keep");
    let pushes = 0;
    const opts = {
      ...s.options,
      publish: async (sha: string) => {
        pushes++;
        assert.equal(s.git("show", `${sha}:third.txt`), "third");
      }
    };
    const r = await runMergeBatch(s.batch, opts);
    assert.equal(r.status, "landed");
    assert.equal(pushes, 1);
    assert.deepEqual(r.outcomes.map(o => o.status), ["included", "conflict", "included"]);
    assert.match(r.outcomes[1]!.reason, /shared.txt/);
    assert.equal(s.git("rev-parse", "main"), s.base);
    assert.equal(readFileSync(path.join(s.repo, "personal.txt"), "utf8"), "keep");
    assert.deepEqual(await runMergeBatch(s.batch, opts), r);
    assert.equal(pushes, 1);
  } finally {
    s.close();
  }
});
it("retries a red gate exactly once, stops subsequent gates and never publishes", async () => {
  const s = fixture(["echo attempted >> attempts; false", "touch should-not-run"]);
  try {
    const r = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => {
        assert.fail("published red batch");
      }
    });
    assert.equal(r.status, "failed");
    assert.match(r.step, /gate 1/);
    assert.equal(readFileSync(path.join(s.options.directory, "worktree", "attempts"), "utf8"), "attempted\nattempted\n");
    assert.equal(s.git("rev-parse", "main"), s.base);
  } finally {
    s.close();
  }
});
it("a flaky gate may pass on its one retry", async () => {
  const s = fixture(["if test -f tried; then true; else touch tried; false; fi"]);
  try {
    let published = false;
    const r = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => {
        published = true;
      }
    });
    assert.equal(r.status, "landed");
    assert.equal(published, true);
  } finally {
    s.close();
  }
});
it("MR waits for target ancestry and restart verifies the same checked SHA without republishing", async () => {
  const s = fixture();
  try {
    s.batch.config.mode = "mr";
    let opened = 0;
    const opts = {
      ...s.options,
      openMr: async () => {
        opened++;
        return "https://example.test/pull/1";
      }
    };
    const r = await runMergeBatch(s.batch, opts);
    assert.equal(r.status, "awaiting");
    assert.equal(opened, 1);
    assert.equal((await runMergeBatch(s.batch, opts)).status, "awaiting");
    assert.equal(opened, 1);
    s.git("merge", "--ff-only", r.sha!);
    assert.equal((await runMergeBatch(s.batch, opts)).status, "landed");
    assert.equal(opened, 1);
  } finally {
    s.close();
  }
});
it("gate edits to tracked code cannot be published as checked code", async () => {
  const s = fixture(["echo changed >> shared.txt"]);
  try {
    const r = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => assert.fail("dirty code published")
    });
    assert.equal(r.status, "failed");
    assert.match(r.log, /changed tracked/);
  } finally {
    s.close();
  }
});
it("recovers a lost MR response using the same immutable source branch", async () => {
  const s = fixture();
  try {
    s.batch.config.mode = "mr";
    let calls = 0;
    const branches: string[] = [];
    const opts = {
      ...s.options,
      openMr: async (branch: string) => {
        branches.push(branch);
        if (++calls === 1) throw new Error("lost response");
        return "https://example.test/pull/2";
      }
    };
    await assert.rejects(runMergeBatch(s.batch, opts), /lost response/);
    const r = await runMergeBatch(s.batch, opts);
    assert.equal(r.status, "awaiting");
    assert.deepEqual(branches, [branches[0], branches[0]]);
  } finally {
    s.close();
  }
});
it("recovers an interrupted publish only when target already contains the checked commit", async () => {
  const s = fixture();
  try {
    const r = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => {}
    });
    const journal = path.join(s.options.directory, "result.json");
    writeFileSync(journal, JSON.stringify({
      phase: "publishing",
      result: r
    }));
    s.git("merge", "--ff-only", r.sha!);
    const recovered = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => assert.fail("duplicate publish")
    });
    assert.equal(recovered.status, "landed");
  } finally {
    s.close();
  }
});
it("recovers an interrupted gate as failed, without rerunning or publishing", async () => {
  const s = fixture(["false"]);
  try {
    const r = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => assert.fail("red published")
    });
    const journal = path.join(s.options.directory, "result.json");
    writeFileSync(journal, JSON.stringify({
      phase: "preparing",
      result: r
    }));
    const recovered = await runMergeBatch(s.batch, {
      ...s.options,
      publish: async () => assert.fail("interrupted published")
    });
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.step, "recovery");
  } finally {
    s.close();
  }
});
it("runner polls the hub once, uploads the batch report, and finishes tasks through the hub API", async () => {
  const {
    SqliteHive
  } = await import("@xdev-hive/core/node");
  const {
    MergeQueueRunner
  } = await import("#desktop/main/runner/merge-queue.ts");
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-merge-driver-"));
  const hive = new SqliteHive(":memory:");
  const actor = {
    name: "runner.gate",
    role: "agent"
  } as const;
  const admin = {
    name: "admin",
    role: "admin"
  } as const;
  try {
    await hive.call("machines.heartbeat", {
      machine: "gate",
      instance: "aabbccdd",
      projects: ["demo"],
      gateRunner: true
    }, actor);
    await hive.call("tasks.create", {
      id: "T-driver",
      project: "demo",
      title: "Driver",
      kind: "feature"
    }, admin);
    await hive.call("tasks.update", {
      id: "T-driver",
      status: "review"
    }, admin);
    const at = new Date().toISOString();
    hive.db.prepare(`INSERT INTO run_records(machine_id,run_id,machine,project,task_id,task_title,role,status,branch,created_at,finished_at,updated_at) VALUES (?,'run-driver','gate','demo','T-driver','Driver','implement','succeeded','ai/T-driver',?,?,?)`).run(actor.name, at, at, at);
    await hive.call("mergeQueue.configure", {
      project: "demo",
      config: mergeQueueConfigSchema.parse({
        enabled: true,
        machineId: actor.name,
        maxBranches: 1,
        commands: ["true"],
        mode: "push"
      })
    }, admin);
    let calls = 0;
    const worker = new MergeQueueRunner();
    const options = {
      backend: hive,
      actor,
      instance: "aabbccdd",
      projects: [{
        name: "demo",
        repo: root
      }],
      dataDir: root,
      env: {},
      execute: async (batch: MergeBatch) => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          status: "landed" as const,
          sha: "a".repeat(40),
          url: null,
          step: "landed",
          log: "true",
          outcomes: batch.items.map(i => ({
            taskId: i.taskId,
            status: "included" as const,
            sha: "b".repeat(40),
            reason: ""
          }))
        };
      }
    };
    await Promise.all([worker.poll(options), worker.poll(options)]);
    await worker.poll(options);
    assert.equal(calls, 1);
    assert.equal((await hive.call("tasks.list", {
      project: "demo"
    }, admin))[0]?.status, "done");
    const artifacts = await hive.call("artifacts.list", {
      project: "demo",
      runId: "MERGE-1"
    }, admin);
    assert.equal(artifacts[0]?.name, "batch-result.json");
    worker.stop();
    await worker.poll(options);
    assert.equal(calls, 1);
  } finally {
    hive.close();
    rmSync(root, {
      recursive: true,
      force: true
    });
  }
});
it("does not retry MR publication if its checked branch changed after interruption", async () => {
  const s = fixture();
  try {
    s.batch.config.mode = "mr";
    let branch = "";
    await assert.rejects(runMergeBatch(s.batch, { ...s.options, openMr: async name => { branch = name; throw new Error("interrupted"); } }));
    s.git("update-ref", `refs/heads/${branch}`, s.base);
    const recovered = await runMergeBatch(s.batch, { ...s.options, openMr: async () => { assert.fail("unchecked branch published"); } });
    assert.equal(recovered.status, "failed");
    assert.match(recovered.log, /branch changed/);
  } finally { s.close(); }
});


it("reserves a stable release version above failed and successful earlier batches", async () => {
  const { nextReleaseVersion } = await import("#desktop/main/runner/merge-queue.ts");
  assert.equal(nextReleaseVersion("1.2.3", []), "1.2.4");
  assert.equal(nextReleaseVersion("1.2.3", ["1.2.4", "1.3.0"]), "1.3.1");
  assert.throws(() => nextReleaseVersion("1.2.3-beta", []));
});
