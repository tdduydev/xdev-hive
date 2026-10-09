// Archiving and deleting a project (roadmap 47). The deletion test does not list the tables it expects by hand: it
// reads every table with a `project` column out of sqlite_master, so a table a later migration adds has to be handled
// too or this test fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HiveError, type Actor, type BlobStore } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
/** A project manager: never a hub admin, whatever they may do inside their projects. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { old: "manage", keep: "manage" } } };

const png = (...tail: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]).toString("base64");
const shaOf = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const code = (c: string, key?: string) => (e: unknown) => e instanceof HiveError && e.code === c && (!key || e.key === key);

function memoryStore() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    name: "seaweedfs",
    where: "http://seaweedfs:8888",
    async put(id: string, bytes: Uint8Array) {
      files.set(id, new Uint8Array(bytes));
    },
    async get(id: string) {
      return files.get(id) ?? null;
    },
    async remove(id: string) {
      files.delete(id);
    },
  } satisfies BlobStore & { files: Map<string, Uint8Array> };
}

const run = (runId: string, project: string) => ({
  runId,
  project,
  taskId: `${project}-1`,
  taskTitle: `${project} task`,
  role: "implement" as const,
  status: "succeeded" as const,
  profileId: "claude-1",
  activity: null,
  log: "",
  createdAt: "2026-10-05T04:00:00.000Z",
});

/** Two projects with something of every kind in them: `old` is the one to archive, `keep` must come through untouched. */
async function hub(opts: { backup?: () => Promise<{ file: string }> } = {}) {
  const blobs = memoryStore();
  const hive = new SqliteHive(":memory:", {
    now: () => new Date("2026-10-05T08:00:00.000Z"),
    backup: opts.backup ?? (async () => ({ file: "/backups/hub-2026-10-05T08-00-00-000Z.db" })),
    blobs,
  });
  hive.seed("hub");
  // Before the rest: chat defaults name a machine the hub has to know already.
  await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", version: "0.130.0", runs: [], projects: ["old", "keep"] }, machine);
  for (const p of ["old", "keep"]) {
    await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, admin);
    await hive.call("memory.write", { project: p, kind: "gotcha", content: `${p} gotcha` }, admin);
    await hive.call("docs.save", { key: `project/${p}/arch`, content: `# ${p}` }, admin);
    // Different bytes per project: a file is named after its bytes, so one shared by both would be kept on purpose.
    await hive.call("docs.assetPut", { key: `project/${p}/arch`, name: "shot.png", data: png(p.length) }, admin);
    await hive.call("chat.setDefaults", { project: p, machineId: machine.name, profileId: null, model: null, effort: null }, admin);
    await hive.call("tools.setProject", { id: "codegraph", project: p, enabled: true }, admin);
    await hive.call("sdlc.setProject", { project: p, settings: { gates: { plan: "auto" } } }, admin);
    await hive.call("agentPolicy.set", { project: p, policy: { mcp: [] } }, admin);
  }
  // A cross-service dependency: keep-1 waits on old-1, so deleting `old` has to clear the other project's row too.
  // Only services of one system may depend on each other (roadmap 19d), so the system comes first.
  await hive.call("systems.save", { name: "shop", projects: ["old", "keep"] }, admin);
  await hive.call("tasks.setDeps", { id: "keep-1", dependsOn: ["old-1"] }, admin);
  await hive.call("budgets.set", { budgets: [{ scope: { kind: "project", project: "old" }, period: "day", limit: { usd: 5 } }] }, admin);
  await hive.call("policy.set", { requiredClis: [], requireShim: false, projects: { old: ["agents"] }, profileTemplates: [], selfApproval: "admins" }, admin);
  await hive.call("agents.stop", { project: "old" }, admin);
  await hive.call("runs.push", { machine: "duy-mbp", runs: [run("R-1", "old"), run("R-2", "keep")] }, machine);
  await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", version: "0.130.0", runs: [], projects: ["old", "keep"] }, machine);
  return { hive, blobs };
}

const names = (list: ReadonlyArray<{ project: string | null }>) => list.map((x) => x.project).sort();

describe("archiving a project (roadmap 47)", () => {
  it("lists every project the hub knows with its numbers and where it is", async () => {
    const { hive } = await hub();
    const list = await hive.call("projects.list", {}, admin);
    assert.deepEqual(names(list), ["keep", "old"]);
    const old = list.find((p) => p.project === "old")!;
    assert.deepEqual(
      [old.state, old.tasks, old.openTasks, old.docs, old.memory, old.runs, old.machines, old.systems],
      [null, 1, 1, 1, 1, 1, ["duy-mbp"], ["shop"]],
    );
  });

  it("hides an archived project from the lists but still reads it, and shows it again after a restore", async () => {
    const { hive } = await hub();
    const archived = await hive.call("projects.archive", { project: "old" }, admin);
    assert.deepEqual([archived.state, archived.stateBy], ["archived", "duy"]);

    assert.deepEqual(names(await hive.call("tasks.list", {}, admin)), ["keep"]);
    assert.deepEqual(names(await hive.call("runs.list", {}, admin)), ["keep"]);
    assert.deepEqual(names(await hive.call("memory.list", { limit: 50 }, admin)), ["keep"]);
    assert.deepEqual((await hive.call("docs.list", {}, admin)).filter((d) => d.project === "old"), []);
    assert.deepEqual((await hive.call("systems.list", {}, admin))[0]!.projects, ["keep"]);
    assert.deepEqual((await hive.call("machines.list", {}, admin))[0]!.projects, ["keep"]);
    // Asked for by name it is all still there: that is how an admin looks before restoring or deleting.
    assert.deepEqual(names(await hive.call("tasks.list", { project: "old" }, admin)), ["old"]);
    assert.equal((await hive.call("docs.get", { key: "project/old/arch" }, admin))?.content, "# old");
    // Still counted on the admin table, which is the one list that has to keep showing it.
    assert.equal((await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!.tasks, 1);

    await hive.call("projects.restore", { project: "old" }, admin);
    assert.deepEqual(names(await hive.call("tasks.list", {}, admin)), ["keep", "old"]);
    assert.equal((await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!.state, null);
  });

  it("refuses writes to an archived project, by its name or through what it owns", async () => {
    const { hive } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    const gone = code("conflict", "errors.projectArchived");
    await assert.rejects(hive.call("tasks.create", { id: "old-2", project: "old", title: "x" }, admin), gone);
    await assert.rejects(hive.call("tasks.update", { id: "old-1", status: "doing" }, admin), gone);
    await assert.rejects(hive.call("tasks.claim", { id: "old-1" }, admin), gone);
    await assert.rejects(hive.call("memory.write", { project: "old", kind: "gotcha", content: "x" }, admin), gone);
    await assert.rejects(hive.call("docs.save", { key: "project/old/arch", content: "# nope" }, admin), gone);
    await assert.rejects(hive.call("chat.send", { project: "old", text: "hi" }, admin), gone);
    await assert.rejects(hive.call("runs.prompt", { project: "old", prompt: "do", machineId: "duy-mbp" }, admin), gone);
    // The other project goes on as before.
    await hive.call("tasks.create", { id: "keep-2", project: "keep", title: "ok" }, admin);
    // And the machine still reports its runs: work already going has to be able to finish.
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run("R-3", "old")] }, machine);
  });

  it("keeps a machine from putting an archived project back, and tells the app it is archived", async () => {
    const { hive } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    const beat = await hive.call(
      "machines.heartbeat",
      { machine: "duy-mbp", instance: "aaaaaaaa", version: "0.130.0", runs: [], projects: ["old", "keep"] },
      machine,
    );
    assert.deepEqual(beat.archivedProjects, ["old"]);
    assert.deepEqual((await hive.call("machines.list", {}, admin))[0]!.projects, ["keep"]);
  });

  it("is a hub admin's alone", async () => {
    const { hive } = await hub();
    for (const call of [hive.call("projects.archive", { project: "old" }, lan), hive.call("projects.delete", { project: "old", confirm: "old" }, lan)]) {
      await assert.rejects(call, (e: unknown) => e instanceof HiveError && (e.key === "errors.hubAdminOnly" || e.key === "errors.roleTooLow"));
    }
  });
});

describe("deleting a project (roadmap 47)", () => {
  it("refuses a project that is not archived, and a confirmation that is not its name", async () => {
    const { hive } = await hub();
    await assert.rejects(hive.call("projects.delete", { project: "old", confirm: "old" }, admin), code("conflict", "errors.projectNotArchived"));
    await hive.call("projects.archive", { project: "old" }, admin);
    await assert.rejects(hive.call("projects.delete", { project: "old", confirm: "0ld" }, admin), code("bad_request", "errors.projectConfirm"));
    assert.equal((await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!.tasks, 1, "nothing was deleted");
  });

  it("backs the hub up first, and deletes nothing when the backup fails", async () => {
    const { hive } = await hub({
      backup: async () => {
        throw new Error("no space left on device");
      },
    });
    await hive.call("projects.archive", { project: "old" }, admin);
    await assert.rejects(hive.call("projects.delete", { project: "old", confirm: "old" }, admin), /no space left/);
    assert.equal((await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!.tasks, 1);
    assert.equal((await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!.state, "archived");
  });

  it("counts no file removed on a hub that keeps its doc files in the database", async () => {
    const hive = new SqliteHive(":memory:", { now: () => new Date("2026-10-05T08:00:00.000Z"), backup: async () => ({ file: "/backups/hub.db" }) });
    hive.seed("hub");
    await hive.call("docs.save", { key: "project/old/arch", content: "# old" }, admin);
    await hive.call("docs.assetPut", { key: "project/old/arch", name: "shot.png", data: png(1) }, admin);
    await hive.call("projects.archive", { project: "old" }, admin);
    const deleted = await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    assert.deepEqual(deleted.files, { removed: 0, failed: 0 }, "the bytes were in the row that just went, not in a store");
  });

  it("refuses to delete when the hub has no backup at all", async () => {
    const hive = new SqliteHive(":memory:", { now: () => new Date("2026-10-05T08:00:00.000Z") });
    hive.seed("hub");
    await hive.call("tasks.create", { id: "old-1", project: "old", title: "x" }, admin);
    await hive.call("projects.archive", { project: "old" }, admin);
    await assert.rejects(hive.call("projects.delete", { project: "old", confirm: "old" }, admin), code("conflict", "errors.backupOff"));
  });

  it("leaves no row of the project in any table that has a project column", async () => {
    const { hive, blobs } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    const deleted = await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    assert.equal(deleted.backup, "hub-2026-10-05T08-00-00-000Z.db");
    assert.ok(deleted.rows.tasks && deleted.rows.docs && deleted.rows.memory, `rows: ${JSON.stringify(deleted.rows)}`);

    // The list of tables comes from the schema, not from this test: a table added later is covered by it as it is.
    const tables = (hive.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((t) => t.name)
      .filter((t) => t !== "project_states")
      .filter((t) => (hive.db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).some((c) => c.name === "project"));
    assert.ok(tables.length > 10, `expected many tables with a project column, found ${tables.join(", ")}`);
    for (const table of tables) {
      const left = hive.db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE project = 'old'`).get() as { n: number };
      assert.equal(left.n, 0, `${table} still has rows of the deleted project`);
    }
    // Rows found by a doc key or a task id instead of a project column.
    for (const [table, sql] of [
      ["doc_versions", "SELECT COUNT(*) AS n FROM doc_versions WHERE key LIKE 'project/old/%'"],
      ["doc_assets", "SELECT COUNT(*) AS n FROM doc_assets WHERE doc_key LIKE 'project/old/%'"],
      ["task_deps", "SELECT COUNT(*) AS n FROM task_deps WHERE task_id = 'old-1' OR depends_on = 'old-1'"],
    ] as const) {
      assert.equal((hive.db.prepare(sql).get() as { n: number }).n, 0, `${table} still has rows of the deleted project`);
    }
    // The doc file went from the store with the page that pointed at it.
    assert.equal(blobs.files.size, 1, "only the other project's file is left");
    assert.deepEqual(deleted.files, { removed: 1, failed: 0 });
    // The project that stays is whole, cross-project dependency included.
    assert.deepEqual(names(await hive.call("tasks.list", {}, admin)), ["keep"]);
    assert.equal((await hive.call("docs.get", { key: "project/keep/arch" }, admin))?.content, "# keep");
  });

  it("takes the project out of every list of projects kept as JSON", async () => {
    const { hive } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    const settings = (key: string) => JSON.parse((hive.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value) as any;
    // Only `old` had a repo policy; both had an agent policy and gates, and only the deleted one goes.
    assert.deepEqual(Object.keys(settings("policy").projects), []);
    assert.deepEqual(Object.keys(settings("agentPolicy").projects), ["keep"]);
    assert.deepEqual(Object.keys(settings("sdlcPolicy").projects), ["keep"]);
    assert.deepEqual(settings("paused").projects, []);
    assert.deepEqual(Object.keys(settings("paused").by), []);
    assert.deepEqual(settings("budgets"), []);
    // The system keeps its name with the services it has left: its own docs and memory are not a project's.
    assert.deepEqual((await hive.call("systems.list", {}, admin))[0]!.projects, ["keep"]);
    assert.deepEqual(
      JSON.parse((hive.db.prepare("SELECT projects FROM machines WHERE id = ?").get(machine.name) as { projects: string }).projects),
      ["keep"],
    );
  });

  it("keeps a doc file another project points at", async () => {
    const { hive, blobs } = await hub();
    // The same bytes on both projects: the store keeps one file, named after them.
    await hive.call("docs.assetPut", { key: "project/keep/arch", name: "same.png", data: png(9) }, admin);
    await hive.call("docs.assetPut", { key: "project/old/arch", name: "same.png", data: png(9) }, admin);
    await hive.call("projects.archive", { project: "old" }, admin);
    const deleted = await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    assert.ok(blobs.files.has(shaOf(png(9))), "the file the other project still shows must stay");
    assert.deepEqual(deleted.files, { removed: 1, failed: 0 }, "only the file nothing points at any more");
  });

  it("leaves a headstone, so a machine still reporting the repo cannot bring the name back", async () => {
    const { hive } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    const beat = await hive.call(
      "machines.heartbeat",
      { machine: "duy-mbp", instance: "aaaaaaaa", version: "0.130.0", runs: [], projects: ["old", "keep"] },
      machine,
    );
    assert.deepEqual(beat.archivedProjects, ["old"]);
    assert.deepEqual((await hive.call("machines.list", {}, admin))[0]!.projects, ["keep"]);
    const old = (await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!;
    assert.deepEqual([old.state, old.tasks, old.docs, old.machines], ["deleted", 0, 0, []]);
    await assert.rejects(hive.call("tasks.create", { id: "old-9", project: "old", title: "x" }, admin), code("conflict", "errors.projectDeleted"));
    // Taking the headstone off is how the name is freed for use again.
    await hive.call("projects.restore", { project: "old" }, admin);
    await hive.call("tasks.create", { id: "old-9", project: "old", title: "x" }, admin);
  });

  it("writes the deletion to the audit log", async () => {
    const { hive } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    const audit = await hive.call("admin.audit", { limit: 20 }, admin);
    assert.ok(audit.some((a) => a.action === "projects.archive" && a.target === "old"));
    const entry = audit.find((a) => a.action === "projects.delete" && a.target === "old");
    assert.ok(entry && entry.detail.includes("backup hub-"), `audit detail: ${entry?.detail}`);
  });
});

describe("restoring a deleted project from a snapshot (ADM-backup-restore)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** The hub of the tests above, whose deletion snapshot is a real file: VACUUM INTO, as the hub makes them. */
  async function snapshotHub() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-restore-"));
    dirs.push(dir);
    const file = path.join(dir, "hub-2026-10-05T08-00-00-000Z.db");
    const ref: { hive?: SqliteHive } = {};
    const { hive, blobs } = await hub({
      backup: async () => {
        ref.hive!.db.prepare("VACUUM INTO ?").run(file);
        return { file };
      },
    });
    ref.hive = hive;
    return { hive, blobs, file };
  }

  /** Rows of a project per table: every table with a project column, and the ones found by a doc key or task id. */
  function rowsOf(hive: SqliteHive, project: string): Record<string, number> {
    const tables = (hive.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((t) => t.name)
      .filter((t) => t !== "project_states")
      .filter((t) => (hive.db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).some((c) => c.name === "project"));
    const out: Record<string, number> = {};
    const n = (sql: string, ...args: string[]) => (hive.db.prepare(sql).get(...args) as { n: number }).n;
    for (const t of tables) out[t] = n(`SELECT COUNT(*) AS n FROM "${t}" WHERE project = ?`, project);
    out.doc_versions = n("SELECT COUNT(*) AS n FROM doc_versions WHERE key LIKE ?", `project/${project}/%`);
    out.doc_assets = n("SELECT COUNT(*) AS n FROM doc_assets WHERE doc_key LIKE ?", `project/${project}/%`);
    out.task_deps = n("SELECT COUNT(*) AS n FROM task_deps WHERE task_id LIKE ? OR depends_on LIKE ?", `${project}-%`, `${project}-%`);
    return out;
  }

  it("brings back every row the deletion took, the lists that named it and its stored files, and lifts the headstone", async () => {
    const { hive, blobs, file } = await snapshotHub();
    const before = rowsOf(hive, "old");
    assert.ok(before.tasks === 1 && before.docs === 1 && before.memory === 1 && before.task_deps === 1, JSON.stringify(before));
    const stored = new Map(blobs.files);
    await hive.call("projects.archive", { project: "old" }, admin);
    await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    assert.equal(rowsOf(hive, "old").tasks, 0);
    // What the hub does on its own every minute must not leave rows under the deleted name that would block a restore.
    hive.queueMemoryCleanup();
    hive.learnModels();

    const inBackup = hive.backupProjects(file);
    assert.deepEqual(
      inBackup.map((p) => [p.project, p.tasks, p.docs, p.memory, p.runs, p.live]),
      [["keep", 1, 1, 1, 1, true], ["old", 1, 1, 1, 1, false]],
    );

    const restored = await hive.restoreProject(file, "old", admin, (sha) => stored.get(sha) ?? null);
    assert.equal(restored.backup, path.basename(file));
    assert.deepEqual(rowsOf(hive, "old"), before);
    assert.ok(restored.rows.tasks === 1 && restored.rows.task_deps === 1, JSON.stringify(restored.rows));
    assert.deepEqual(restored.files, { restored: 1, missing: 0 });
    assert.ok(blobs.files.has(shaOf(png(3))), "the page's image is back in the store");

    const old = (await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!;
    assert.deepEqual([old.state, old.tasks, old.docs, old.memory, old.runs, old.systems], [null, 1, 1, 1, 1, ["shop"]]);
    assert.equal((await hive.call("docs.get", { key: "project/old/arch" }, admin))?.content, "# old");
    assert.ok((await hive.call("memory.search", { project: "old", query: "gotcha" }, admin)).some((m) => m.content === "old gotcha"), "found through the full-text index again");
    const settings = (key: string) => JSON.parse((hive.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value) as any;
    assert.deepEqual(Object.keys(settings("agentPolicy").projects).sort(), ["keep", "old"]);
    assert.deepEqual(Object.keys(settings("policy").projects), ["old"]);
    assert.deepEqual(settings("budgets").map((b: any) => b.scope.project), ["old"]);
    // Writable again: the headstone is off.
    await hive.call("tasks.create", { id: "old-2", project: "old", title: "after the restore" }, admin);

    const audit = await hive.call("admin.audit", { limit: 20 }, admin);
    const entry = audit.find((a) => a.action === "backups.restoreProject" && a.target === "old");
    assert.ok(entry && entry.detail.includes(path.basename(file)), `audit detail: ${entry?.detail}`);
  });

  it("refuses a project the hub has data of: a restore never merges", async () => {
    const { hive, file } = await snapshotHub();
    await hive.call("projects.archive", { project: "old" }, admin);
    await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    await assert.rejects(hive.restoreProject(file, "keep", admin), code("conflict", "errors.restoreHasData"));
    await hive.restoreProject(file, "old", admin);
    const rows = rowsOf(hive, "old");
    await assert.rejects(hive.restoreProject(file, "old", admin), code("conflict", "errors.restoreHasData"));
    assert.deepEqual(rowsOf(hive, "old"), rows, "nothing was copied twice");
    // The name freed and used again since the deletion counts as data too.
    const second = await snapshotHub();
    await second.hive.call("projects.archive", { project: "old" }, admin);
    await second.hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    await second.hive.call("projects.restore", { project: "old" }, admin);
    await second.hive.call("tasks.create", { id: "old-7", project: "old", title: "new work" }, admin);
    await assert.rejects(second.hive.restoreProject(second.file, "old", admin), code("conflict", "errors.restoreHasData"));
    assert.equal(rowsOf(second.hive, "old").tasks, 1);
  });

  it("rolls back the whole copy when a row clashes with one the hub made since", async () => {
    const { hive, file } = await snapshotHub();
    await hive.call("projects.archive", { project: "old" }, admin);
    await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    // Task ids are the hub's: one taken by another project since the deletion cannot come back beside it.
    await hive.call("tasks.create", { id: "old-1", project: "keep", title: "same id, other project" }, admin);
    await assert.rejects(hive.restoreProject(file, "old", admin), code("conflict", "errors.restoreConflict"));
    assert.deepEqual(Object.values(rowsOf(hive, "old")).filter(Boolean), [], "no row of it is left half-copied");
    assert.equal((await hive.call("projects.list", {}, admin)).find((p) => p.project === "old")!.state, "deleted", "the headstone stays");
  });
});
