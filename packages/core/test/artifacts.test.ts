import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ARTIFACTS_PER_RUN, artifactName, HiveError, type Actor, type BlobStore } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
/** The machine's token, as the runner calls with it. */
const runner: Actor = { name: "runner.mac-mini-1", role: "agent", source: { via: "api", machine: "mac-mini-1", run: "R-1", task: "APP-1" } };
const png = (...tail: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]).toString("base64");
const text = (s: string) => Buffer.from(s, "utf8").toString("base64");
const read = (s: string) => Buffer.from(s, "base64").toString("utf8");
const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
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

async function hub(blobs?: BlobStore) {
  const hive = new SqliteHive(":memory:", blobs ? { blobs } : {});
  hive.seed("hub");
  for (const p of ["app", "web"]) await hive.call("tasks.create", { id: `${p.toUpperCase()}-1`, project: p, title: `${p} task` }, admin);
  return hive;
}

const put = (hive: SqliteHive, over: Partial<{ project: string; taskId: string; runId: string; name: string; data: string; profileId: string }> = {}, actor = runner) =>
  hive.call("artifacts.put", { project: "app", taskId: "APP-1", runId: "R-1", name: "report.md", data: text("# ok\n"), ...over }, actor);

describe("the artifact store (roadmap 41c)", () => {
  it("upgrades the main schema without replaying its migrations", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-artifacts-migration-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hive.db");
    const before = new SqliteHive(file);
    before.seed("hub");
    await before.call("tasks.create", { id: "APP-1", project: "app", title: "Existing task" }, admin);
    const version = Number(before.db.prepare("PRAGMA user_version").get()?.user_version);
    // The artifact migration is last; removing only it leaves the schema shipped on main.
    before.db.exec(`DROP TABLE artifacts; PRAGMA user_version = ${version - 1}`);
    before.close();
    const after = new SqliteHive(file);
    t.after(() => after.close());
    assert.equal(after.db.prepare("PRAGMA user_version").get()?.user_version, version);
    assert.equal((await after.call("tasks.list", { project: "app" }, admin)).find((task) => task.id === "APP-1")?.title, "Existing task");
    const columns = after.db.prepare("PRAGMA table_info(run_records)").all().map((r) => r.name);
    for (const column of ["log_pruned_at", "compression", "kind", "model", "verdict"]) assert.ok(columns.includes(column));
    assert.ok(after.db.prepare("PRAGMA table_info(tasks)").all().some((r) => r.name === "agent_machine"));
    assert.equal((await put(after)).name, "report.md");
  });

  it("keeps a run's file with what made it, and gives it back", async () => {
    const hive = await hub();
    const saved = await put(hive, { name: "shots/board.png", data: png(1, 2), profileId: "claude-1" });
    assert.partialDeepStrictEqual(saved, {
      project: "app",
      taskId: "APP-1",
      runId: "R-1",
      machineId: "runner.mac-mini-1",
      name: "shots/board.png",
      type: "image/png",
      size: 10,
      profileId: "claude-1",
      uploadedBy: "runner.mac-mini-1",
      source: { via: "api", machine: "mac-mini-1", run: "R-1", task: "APP-1" },
    });
    assert.equal(saved.sha256, sha(png(1, 2)));
    const got = await hive.call("artifacts.get", { id: saved.id }, admin);
    assert.equal(got?.data, png(1, 2));
    assert.deepEqual((await hive.call("artifacts.list", { project: "app" }, admin)).map((a) => a.name), ["shots/board.png"]);
    assert.deepEqual((await hive.call("artifacts.list", { project: "app", taskId: "APP-1" }, admin)).map((a) => a.name), ["shots/board.png"]);
    assert.deepEqual((await hive.call("artifacts.list", { project: "app", runId: "R-2" }, admin)), []);
    assert.deepEqual((await hive.call("artifacts.list", { project: "web" }, admin)), []);
    // The run page asks with the run's machineId, which is the machine's hub actor, dots and all.
    assert.deepEqual((await hive.call("artifacts.list", { project: "app", runId: "R-1", machineId: "runner.mac-mini-1" }, admin)).map((a) => a.name), ["shots/board.png"]);
    assert.deepEqual(await hive.call("artifacts.list", { project: "app", runId: "R-1", machineId: "runner.other@other" }, admin), []);
  });

  it("hides a line that looks like a secret, as a run's log does", async () => {
    const hive = await hub();
    const saved = await put(hive, { name: "measure.log", data: text("ok\nTOKEN=ghp_0123456789012345678901234567890123456\nthe rest\n") });
    const got = await hive.call("artifacts.get", { id: saved.id }, admin);
    const kept = read(got!.data);
    assert.match(kept, /^ok\n\(line hidden: it looked like a GitHub token\)\nthe rest\n$/);
    // The row names the bytes that were kept, not the ones that were sent, or reading them back would fail.
    assert.equal(saved.sha256, createHash("sha256").update(kept).digest("hex"));
    assert.equal(saved.size, Buffer.byteLength(kept));
  });

  it("refuses text with a hidden character, and a kind that is not an artifact", async () => {
    const hive = await hub();
    await assert.rejects(put(hive, { name: "plan.md", data: text("đã làm​ gì") }), code("bad_request", "errors.hidden.zeroWidth"));
    await assert.rejects(put(hive, { name: "notes.csv", data: text("a,b\n1,2\n") }), code("bad_request", "errors.artifactType"));
    await assert.rejects(put(hive, { name: "anim.gif", data: Buffer.from("GIF89a123").toString("base64") }), code("bad_request", "errors.artifactType"));
    await assert.rejects(put(hive, { name: "a.png", data: text("not a png") }), code("bad_request", "errors.artifactType"));
    await assert.rejects(put(hive, { name: "big.md", data: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61).toString("base64") }), code("bad_request", "errors.chatFileTooBig"));
    assert.deepEqual(await hive.call("artifacts.list", { project: "app" }, admin), []);
  });

  it("keeps at most twenty files per run, and replaces one sent twice", async () => {
    const hive = await hub();
    for (let n = 0; n < ARTIFACTS_PER_RUN; n++) await put(hive, { name: `f${n}.md`, data: text(`# ${n}\n`) });
    await assert.rejects(put(hive, { name: "one-too-many.md" }), code("bad_request", "errors.artifactsFull"));
    // The same name of the same run is the same row: a run reported twice does not double it.
    const again = await put(hive, { name: "f0.md", data: text("# newer\n") });
    const list = await hive.call("artifacts.list", { project: "app", runId: "R-1" }, admin);
    assert.equal(list.length, ARTIFACTS_PER_RUN);
    assert.equal(read((await hive.call("artifacts.get", { id: again.id }, admin))!.data), "# newer\n");
    // Another run of the same task has its own twenty.
    await put(hive, { runId: "R-2", name: "f0.md" });
    assert.equal((await hive.call("artifacts.list", { project: "app", taskId: "APP-1" }, admin)).length, ARTIFACTS_PER_RUN + 1);
  });

  it("puts the bytes in the store by their SHA-256, and keeps the same bytes once", async () => {
    const store = memoryStore();
    const hive = await hub(store);
    const data = png(7);
    const a = await put(hive, { name: "a.png", data });
    const b = await put(hive, { runId: "R-2", name: "b.png", data });
    assert.deepEqual([...store.files.keys()], [sha(data)]);
    assert.deepEqual(hive.storedFileIds(), [sha(data)]);
    assert.equal((await hive.call("artifacts.get", { id: a.id }, admin))!.data, data, "the bytes come back from the store");
    await hive.call("artifacts.remove", { id: a.id }, admin);
    assert.equal(store.files.size, 1, "the other run still points at them");
    await hive.call("artifacts.remove", { id: b.id }, admin);
    assert.equal(store.files.size, 0);
  });

  it("does not drop bytes a doc's file still points at", async () => {
    const store = memoryStore();
    const hive = await hub(store);
    const data = png(3);
    await hive.call("docs.save", { key: "project/app/arch", content: "# Kiến trúc" }, admin);
    await hive.call("docs.assetPut", { key: "project/app/arch", name: "same.png", data }, admin);
    const mine = await put(hive, { name: "same.png", data });
    assert.equal(store.files.size, 1);
    await hive.call("artifacts.remove", { id: mine.id }, admin);
    assert.deepEqual([...store.files.keys()], [sha(data)], "the page still shows it");
  });

  it("moves bytes kept in the database into a store the hub gets later", async () => {
    const hive = await hub();
    const saved = await put(hive, { name: "a.png", data: png(4) });
    assert.equal(hive.filesInfo().inDb, 1);
    const store = memoryStore();
    const later = new SqliteHive(hive.db, { blobs: store });
    assert.equal(await later.moveFilesToStore(), 1);
    assert.equal(await later.moveFilesToStore(), 0);
    assert.deepEqual([...store.files.keys()], [sha(png(4))]);
    assert.equal((await later.call("artifacts.get", { id: saved.id }, admin))?.data, png(4));
    assert.equal(later.filesInfo().inDb, 0);
  });

  it("goes by the project: only its people read it, only its manager removes it", async () => {
    const hive = await hub();
    const saved = await put(hive);
    const outsider: Actor = { name: "an", role: "member", access: { projects: { web: "lead" } } };
    const member: Actor = { name: "minh", role: "member", access: { projects: { app: "member" } } };
    const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "lead" } } };

    await assert.rejects(hive.call("artifacts.list", { project: "app" }, outsider), code("not_found"));
    await assert.rejects(hive.call("artifacts.get", { id: saved.id }, outsider), code("not_found"));
    await assert.rejects(put(hive, {}, outsider), code("not_found"));
    assert.equal((await hive.call("artifacts.get", { id: saved.id }, member))?.artifact.name, "report.md");
    // Removing is the manager's: a member of the project cannot.
    await assert.rejects(hive.call("artifacts.remove", { id: saved.id }, member), code("forbidden", "errors.need.projectSettings"));
    assert.deepEqual(await hive.call("artifacts.remove", { id: saved.id }, lead), { removed: true, project: "app", name: "report.md" });
    assert.deepEqual(await hive.call("artifacts.remove", { id: saved.id }, lead), { removed: false, project: null, name: null });
    // Removing one is written down; nothing else ever deletes an artifact.
    const log = await hive.call("admin.audit", {}, admin);
    assert.partialDeepStrictEqual(log.filter((e) => e.action === "artifacts.remove").at(-1), {
      actor: "lan",
      action: "artifacts.remove",
      target: "app #1",
      detail: "− report.md",
      detailKey: "audit.artifactRemoved",
    });
  });

  it("deletes a project's artifact blobs while keeping shared files", async (t) => {
    const blobs = memoryStore();
    const hive = new SqliteHive(":memory:", { blobs, backup: async () => ({ file: "/backups/hub.db" }) });
    t.after(() => hive.close());
    hive.seed("hub");
    await hive.call("tasks.create", { id: "APP-1", project: "app", title: "Existing task" }, admin);
    const unique = await put(hive);
    const shared = await put(hive, { name: "shared.png", data: png(1) });
    const other = await put(hive, { name: "other.png", data: png(2) });
    const kept = await put(hive, { project: "web", taskId: "WEB-1", runId: "R-2", name: "other.png", data: png(2) });
    await hive.call("docs.save", { key: "project/web/files", title: "Files", content: "Files", baseVersion: 0 }, admin);
    await hive.call("docs.assetPut", { key: "project/web/files", name: "shared.png", data: png(1) }, admin);
    await hive.call("projects.archive", { project: "app" }, admin);
    await hive.call("projects.delete", { project: "app", confirm: "app" }, admin);
    assert.equal(await hive.call("artifacts.get", { id: unique.id }, admin), null);
    assert.ok(!blobs.files.has(unique.sha256));
    assert.ok(blobs.files.has(shared.sha256));
    assert.ok(blobs.files.has(other.sha256));
    assert.equal((await hive.call("artifacts.get", { id: kept.id }, admin))?.data, png(2));
    assert.equal((await hive.call("docs.assetGet", { key: "project/web/files", name: "shared.png" }, admin))?.data, png(1));
  });

  it("makes a name safe to keep and to show", () => {
    assert.equal(artifactName("shots/board.png"), "shots/board.png");
    assert.equal(artifactName("shots\\board.png"), "shots/board.png");
    assert.equal(artifactName("../../etc/passwd"), "etc/passwd");
    assert.equal(artifactName("/a//b/c.md"), "a/b/c.md");
    assert.equal(artifactName("re​port\nnow.md"), "reportnow.md");
    assert.equal(artifactName("../.."), "");
    assert.equal(artifactName(`${"d/".repeat(200)}x.md`), `${"d/".repeat(200)}x.md`.slice(-200));
  });
});
