import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ARTIFACTS_PER_RUN, artifactName, HiveError, type Actor, type BlobStore } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

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
    // The schema a hub had before 41c: every migration up to (not including) the artifacts one.
    const before = new SqliteHive(file, { migrateTo: migrationIndex("CREATE TABLE artifacts(") });
    before.seed("hub");
    await before.call("tasks.create", { id: "APP-1", project: "app", title: "Existing task" }, admin);
    before.close();
    const after = new SqliteHive(file);
    t.after(() => after.close());
    assert.ok(Number(after.db.prepare("PRAGMA user_version").get()?.user_version) > migrationIndex("CREATE TABLE artifacts("));
    assert.equal((await after.call("tasks.list", { project: "app" }, admin)).find((task) => task.id === "APP-1")?.title, "Existing task");
    const columns = after.db.prepare("PRAGMA table_info(run_records)").all().map((r) => r.name);
    for (const column of ["log_pruned_at", "compression", "kind", "model", "verdict"]) assert.ok(columns.includes(column));
    assert.ok(after.db.prepare("PRAGMA table_info(tasks)").all().some((r) => r.name === "agent_machine"));
    assert.equal((await put(after)).name, "report.md");
  });

  it("migrates stored artifact rows into versioned rows without losing their bytes", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-artifact-versions-migration-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hive.db");
    const before = new SqliteHive(file, { migrateTo: migrationIndex("ALTER TABLE artifacts RENAME TO artifacts_old;") });
    before.seed("hub");
    for (const p of ["app"]) await before.call("tasks.create", { id: "APP-1", project: p, title: "Existing task" }, admin);
    const oldBytes = Buffer.from("<h1>old</h1>");
    const savedId = Number(before.db.prepare(`INSERT INTO artifacts(project, task_id, run_id, machine_id, name, type, size, sha256, stored, data, profile_id, uploaded_by, on_behalf, source, created_at)
      VALUES ('app', 'APP-1', 'R-1', 'runner.mac-mini-1', 'old.html', 'text/html', ?, ?, NULL, ?, NULL, 'runner.mac-mini-1', NULL, NULL, '2026-10-09T00:00:00.000Z')`).run(oldBytes.length, sha(oldBytes.toString("base64")), oldBytes).lastInsertRowid);
    before.close();
    const after = new SqliteHive(file);
    t.after(() => after.close());
    assert.equal((await after.call("artifacts.get", { id: savedId }, admin))?.data, oldBytes.toString("base64"));
    assert.equal((await after.call("artifacts.get", { id: savedId }, admin))?.artifact.version, 1);
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

  it("filters scope, names and kinds before paging, including access and archives", async () => {
    const hive = await hub();
    const report = await put(hive);
    const log = await put(hive, { name: "run.log", data: text("ok") });
    const hidden = await put(hive, { project: "web", taskId: "WEB-1", name: "hidden.json", data: text('{"ok":true}') });
    const viewer: Actor = { name: "reader", role: "viewer", access: { projects: { app: "viewer" } } };
    assert.deepEqual((await hive.call("artifacts.list", { limit: 1 }, viewer)).map((a) => a.id), [log.id]);
    assert.deepEqual((await hive.call("artifacts.list", { limit: 1, offset: 1 }, viewer)).map((a) => a.id), [report.id]);
    assert.deepEqual(await hive.call("artifacts.list", { projects: ["web"] }, viewer), []);
    await assert.rejects(hive.call("artifacts.get", { id: hidden.id, metadataOnly: true }, viewer), code("not_found"));
    assert.deepEqual((await hive.call("artifacts.list", { projects: ["app"], kind: "markdown", name: "REPORT" }, admin)).map((a) => a.id), [report.id]);
    assert.deepEqual((await hive.call("artifacts.list", { kind: "log" }, admin)).map((a) => a.id), [log.id]);
    assert.deepEqual((await hive.call("artifacts.list", { kind: "json", runId: "R-1", taskId: "WEB-1" }, admin)).map((a) => a.id), [hidden.id]);
    assert.deepEqual(await hive.call("artifacts.list", { projects: [] }, admin), []);
    // Search treats SQL wildcard characters literally.
    assert.deepEqual(await hive.call("artifacts.list", { name: "%" }, admin), []);
    hive.db.prepare("INSERT INTO project_states VALUES (?, ?, ?, ?)").run("web", "archived", new Date().toISOString(), "duy");
    assert.deepEqual((await hive.call("artifacts.list", { limit: 1 }, admin)).map((a) => a.id), [log.id]);
    assert.deepEqual((await hive.call("artifacts.list", { project: "web" }, admin)).map((a) => a.id), [hidden.id]);
  });

  it("searches Vietnamese names without case or normalization differences", async () => {
    const hive = await hub();
    const a = await put(hive, { name: "Đo-được.md" });
    assert.deepEqual((await hive.call("artifacts.list", { name: "đo-được".normalize("NFD") }, admin)).map((a) => a.name), [a.name]);
  });

  it("previews bounded UTF-8 text, keeps full downloads and fetches metadata without blob bytes", async () => {
    const store = memoryStore();
    const hive = await hub(store);
    const a = await put(hive, { data: text("ađã làm\n") });
    const preview = await hive.call("artifacts.get", { id: a.id, maxBytes: 2 }, admin);
    assert.equal(read(preview!.data), "a");
    assert.equal(preview!.truncated, true);
    assert.equal(read((await hive.call("artifacts.get", { id: a.id }, admin))!.data), "ađã làm\n");
    store.files.clear();
    assert.equal((await hive.call("artifacts.get", { id: a.id, metadataOnly: true }, admin))!.data, "");
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

  it("keeps at most twenty file names per run and retains each upload as a version", async () => {
    const hive = await hub();
    for (let n = 0; n < ARTIFACTS_PER_RUN; n++) await put(hive, { name: `f${n}.md`, data: text(`# ${n}\n`) });
    await assert.rejects(put(hive, { name: "one-too-many.md" }), code("bad_request", "errors.artifactsFull"));
    const again = await hive.call("artifacts.put", { project: "app", taskId: "APP-1", runId: "R-1", name: "f0.md", data: text("# newer\n"), versionNote: "Updated output" }, runner);
    const list = await hive.call("artifacts.list", { project: "app", runId: "R-1" }, admin);
    assert.equal(list.length, ARTIFACTS_PER_RUN + 1);
    assert.equal(again.version, 2);
    assert.equal(again.versionNote, "Updated output");
    assert.equal(read((await hive.call("artifacts.get", { id: again.id }, admin))!.data), "# newer\n");
    const pinned = await hive.call("artifacts.pin", { id: again.id, pinned: true }, admin);
    assert.equal(pinned.pinned, true);
    assert.equal((await hive.call("artifacts.list", { project: "app", runId: "R-1" }, admin))[0]?.id, again.id);
    // Another run of the same task has its own twenty.
    await put(hive, { runId: "R-2", name: "f0.md" });
    assert.equal((await hive.call("artifacts.list", { project: "app", taskId: "APP-1" }, admin)).length, ARTIFACTS_PER_RUN + 2);
  });

  it("accepts HTML as scanned text and refuses secrets", async () => {
    const hive = await hub();
    const html = await put(hive, { name: "preview.html", data: text("<!doctype html><h1>Preview</h1>") });
    assert.equal(html.type, "text/html");
    assert.equal(read((await hive.call("artifacts.get", { id: html.id }, admin))!.data), "<!doctype html><h1>Preview</h1>");
    const scrubbed = await put(hive, { name: "bad.html", data: text("const token = 'ghp_1234567890123456789012345678901234567890';") });
    assert.doesNotMatch(read((await hive.call("artifacts.get", { id: scrubbed.id }, admin))!.data), /ghp_/);
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
    assert.equal((await hive.call("artifacts.pin", { id: saved.id, pinned: true }, member)).pinned, true);
    await assert.rejects(hive.call("artifacts.pin", { id: saved.id, pinned: false }, outsider), code("not_found"));
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

describe("artifact retention (DATA-cleanup-hub)", () => {
  async function aged(opts: { artifactDays?: number } = {}) {
    let t = Date.parse("2026-10-01T00:00:00Z");
    const store = memoryStore();
    const hive = new SqliteHive(":memory:", { blobs: store, now: () => new Date(t), ...opts });
    hive.seed("hub");
    for (const p of ["app", "web"]) await hive.call("tasks.create", { id: `${p.toUpperCase()}-1`, project: p, title: `${p} task` }, admin);
    await put(hive, { name: "shot.png", data: png(1) });
    await put(hive, { project: "web", taskId: "WEB-1", runId: "R-2", name: "shot.png", data: png(2) });
    await hive.call("tasks.update", { id: "APP-1", status: "done" }, admin);
    return { hive, store, advance: (days: number) => (t += days * 24 * 3_600_000) };
  }

  it("drops a done task's old artifacts and their bytes, and keeps an open task's however old", async () => {
    const { hive, store, advance } = await aged();
    assert.deepEqual(await hive.pruneArtifacts(), { removed: 0, bytes: 0 }, "nothing is old yet");
    advance(31);
    const r = await hive.pruneArtifacts();
    assert.equal(r.removed, 1);
    assert.equal(r.bytes, Buffer.from(png(1), "base64").length);
    assert.deepEqual([...store.files.keys()], [sha(png(2))], "only the open task's bytes stay in the store");
    assert.deepEqual(hive.artifactsInfo(), { count: 1, bytes: Buffer.from(png(2), "base64").length, days: 30, runLogDays: 30 });
    hive.close();
  });

  it("keeps everything when retention is off", async () => {
    const { hive, advance } = await aged({ artifactDays: 0 });
    advance(400);
    assert.deepEqual(await hive.pruneArtifacts(), { removed: 0, bytes: 0 });
    assert.equal(hive.artifactsInfo().count, 2);
    hive.vacuum();
    hive.close();
  });
});
