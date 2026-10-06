import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
/** Manages app, contributes to web. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "manage", web: "contribute" } } };
const code = (c: string, key?: string) => (e: unknown) => e instanceof HiveError && e.code === c && (!key || e.key === key);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");

async function hive() {
  const h = new SqliteHive(":memory:");
  const save = (key: string, content: string, extra: Record<string, unknown> = {}) => h.call("docs.save", { key, content, ...extra }, admin);
  await save("project/app/arch", "# Kiến trúc", { title: "Kiến trúc", folder: true });
  await save("project/app/arch-sys", "# Sơ đồ\nXem [[arch-db]].", { title: "Sơ đồ hệ thống", parent: "project/app/arch" });
  await save("project/app/arch-db", "# DB\nQuay lại [[arch-sys]].", { title: "Cơ sở dữ liệu", parent: "project/app/arch-sys" });
  return h;
}

describe("removing a page (roadmap 38g)", () => {
  it("takes the page and those under it out of every list, keeps the versions, and puts them back", async () => {
    const h = await hive();
    const removed = await h.call("docs.remove", { key: "project/app/arch-sys", note: "gộp vào Kiến trúc" }, admin);
    assert.deepEqual(removed.keys, ["project/app/arch-sys", "project/app/arch-db"], "the page and the one under it");

    const keys = (await h.call("docs.list", { project: "app" }, admin)).map((d) => d.key);
    assert.deepEqual(keys, ["project/app/arch"], "out of the list");
    const context = await h.call("docs.context", { project: "app" }, admin);
    assert.equal(context.agentsMd.includes("Sơ đồ"), false, "out of AGENTS.md and so of the next sync");

    // Still there to read back: the versions stay and the page says who removed it and why.
    assert.equal((await h.call("docs.history", { key: "project/app/arch-sys" }, admin)).length, 1);
    const gone = await h.call("docs.get", { key: "project/app/arch-sys" }, admin);
    assert.equal(gone?.removedBy, "duy");
    assert.equal(gone?.removedNote, "gộp vào Kiến trúc");
    const trash = await h.call("docs.removed", { project: "app" }, admin);
    assert.deepEqual(trash.map((d) => d.key).sort(), ["project/app/arch-db", "project/app/arch-sys"]);

    const back = await h.call("docs.restore", { key: "project/app/arch-sys" }, admin);
    assert.deepEqual(back.keys, ["project/app/arch-sys", "project/app/arch-db"], "the restore undoes exactly that removal");
    assert.equal((await h.call("docs.list", { project: "app" }, admin)).length, 3);
    assert.equal((await h.call("docs.get", { key: "project/app/arch-sys" }, admin))?.version, 1, "no new version either way");
    assert.deepEqual(await h.call("docs.removed", {}, admin), []);
  });

  it("leaves a page removed earlier where it is, and asks for the page above first", async () => {
    const h = await hive();
    await h.call("docs.remove", { key: "project/app/arch-db" }, admin);
    await h.call("docs.remove", { key: "project/app/arch-sys" }, admin);
    await assert.rejects(h.call("docs.restore", { key: "project/app/arch-db" }, admin), code("conflict", "errors.docParentRemoved"));
    await h.call("docs.restore", { key: "project/app/arch-sys" }, admin);
    assert.equal((await h.call("docs.get", { key: "project/app/arch-db" }, admin))?.removedAt != null, true, "its own removal still stands");
    await h.call("docs.restore", { key: "project/app/arch-db" }, admin);
    assert.equal((await h.call("docs.list", { project: "app" }, admin)).length, 3);
  });

  it("refuses a mirrored page, a second removal and writing over a removed one", async () => {
    const h = await hive();
    await h.call("docs.save", { key: "project/app/readme", content: "# Đọc", mirror: { from: "README.md", commit: "abc123" } }, admin);
    await assert.rejects(h.call("docs.remove", { key: "project/app/readme" }, admin), code("bad_request", "errors.docMirrorRemove"));

    await h.call("docs.remove", { key: "project/app/arch-db" }, admin);
    await assert.rejects(h.call("docs.remove", { key: "project/app/arch-db" }, admin), code("not_found"));
    await assert.rejects(h.call("docs.save", { key: "project/app/arch-db", content: "lại" }, admin), code("conflict", "errors.docRemoved"));
    await assert.rejects(h.call("docs.restore", { key: "project/app/arch" }, admin), code("conflict", "errors.docNotRemoved"));
  });

  it("takes what changing the page takes: a contributor does not remove one, and a page agents read needs the context", async () => {
    const h = await hive();
    await h.call("docs.save", { key: "project/web/home", content: "# Web" }, admin);
    await assert.rejects(h.call("docs.remove", { key: "project/web/home" }, lan), code("forbidden"), "lan only contributes to web");
    await h.call("docs.save", { key: "project/app/agents", content: "# app" }, admin);
    // Writes pages but does not touch what agents read: AGENTS.md is the Context agent's.
    const writer: Actor = { name: "mai", role: "member", access: { projects: { app: { permissions: ["view", "docEdit"] } } } };
    await assert.rejects(h.call("docs.remove", { key: "project/app/agents" }, writer), code("forbidden"));
    assert.deepEqual((await h.call("docs.remove", { key: "project/app/arch-db" }, writer)).keys, ["project/app/arch-db"]);
    await h.call("docs.remove", { key: "project/app/agents" }, admin);
    await assert.rejects(h.call("docs.restore", { key: "project/app/agents" }, writer), code("forbidden"), "and does not bring it back either");
  });

  it("stops being a skill in the repo and does not hold a page under it", async () => {
    const h = await hive();
    await h.call("docs.save", { key: "project/app/skills/deploy", content: "---\nname: deploy\ndescription: Deploy nó\n---\nCác bước" }, admin);
    assert.equal((await h.call("skills.list", { project: "app" }, admin)).length, 1);
    await h.call("docs.remove", { key: "project/app/skills/deploy" }, admin);
    assert.deepEqual(await h.call("skills.list", { project: "app" }, admin), []);
    await h.call("docs.remove", { key: "project/app/arch" }, admin);
    await assert.rejects(
      h.call("docs.save", { key: "project/app/new", content: "mới", parent: "project/app/arch" }, admin),
      code("bad_request", "errors.docParentMissing"),
    );
  });
});

describe("moving a page to another space (roadmap 38g)", () => {
  const withSystem = async () => {
    const h = await hive();
    await h.call("systems.save", { name: "customer-ai", projects: ["app"] }, admin);
    return h;
  };

  it("keeps the versions and files, takes the pages under it along, and leaves the old key pointing at the new one", async () => {
    const h = await withSystem();
    await h.call("docs.save", { key: "project/app/arch-sys", content: "# Sơ đồ v2" }, admin);
    await h.call("docs.assetPut", { key: "project/app/arch-sys", name: "overview.png", data: PNG }, admin);

    const moved = await h.call("docs.move", { key: "project/app/arch-sys", to: "system/customer-ai/arch-sys" }, admin);
    assert.equal(moved.key, "system/customer-ai/arch-sys");
    assert.equal(moved.project, "sys:customer-ai");
    assert.equal(moved.parent, null, "it left the space its parent is in");
    assert.deepEqual(moved.moved, [
      { from: "project/app/arch-sys", to: "system/customer-ai/arch-sys" },
      { from: "project/app/arch-db", to: "system/customer-ai/arch-db" },
    ]);

    const at = await h.call("docs.get", { key: "system/customer-ai/arch-sys" }, admin);
    assert.equal(at?.version, 2, "no new version");
    assert.deepEqual((await h.call("docs.history", { key: "system/customer-ai/arch-sys" }, admin)).map((v) => v.version), [2, 1], "the history came along");
    assert.equal((await h.call("docs.assetGet", { key: "system/customer-ai/arch-sys", name: "overview.png" }, admin))?.data, PNG);
    assert.equal((await h.call("docs.get", { key: "system/customer-ai/arch-db" }, admin))?.parent, "system/customer-ai/arch-sys", "the page under it still sits under it");

    // The key it had leads to where it is now, for a link or a bookmark from before.
    assert.equal((await h.call("docs.get", { key: "project/app/arch-sys" }, admin))?.key, "system/customer-ai/arch-sys");
    // app is a service of the system, so its list still has the page — under the system's key now, not the project's.
    const keys = (await h.call("docs.list", { project: "app" }, admin)).map((d) => d.key);
    assert.deepEqual(keys.filter((k) => k.startsWith("project/")), ["project/app/arch"]);
    assert.deepEqual(keys.filter((k) => k.startsWith("system/")).sort(), ["system/customer-ai/arch-db", "system/customer-ai/arch-sys"]);
  });

  it("keeps the links of the pages that stayed behind working", async () => {
    const h = await withSystem();
    await h.call("docs.save", { key: "project/app/arch", content: "Xem [[arch-sys]].", title: "Kiến trúc" }, admin);
    await h.call("docs.move", { key: "project/app/arch-sys", to: "system/customer-ai/arch-sys" }, admin);
    const links = await h.call("docs.links", { key: "project/app/arch" }, admin);
    assert.deepEqual(links.out.map((l) => [l.key, l.exists]), [["system/customer-ai/arch-sys", true]], "the old link leads to the new key");
    const back = await h.call("docs.links", { key: "system/customer-ai/arch-sys" }, admin);
    assert.deepEqual(back.back.map((b) => b.key), ["system/customer-ai/arch-db", "project/app/arch"], "and counts as a link in");
    assert.equal(back.back.at(-1)?.snippet, "Xem Sơ đồ hệ thống.", "the line reads with the page's title");
  });

  it("refuses a key already taken, an unknown system, and a space the person does not hold", async () => {
    const h = await withSystem();
    await assert.rejects(h.call("docs.move", { key: "project/app/arch-sys", to: "project/app/arch" }, admin), code("conflict", "errors.docKeyTaken"));
    await assert.rejects(h.call("docs.move", { key: "project/app/arch-sys", to: "system/nope/arch-sys" }, admin), code("not_found", "errors.systemNotFound"));
    const mai: Actor = { name: "mai", role: "member", access: { projects: { app: "manage" } } };
    await assert.rejects(h.call("docs.move", { key: "project/app/arch-sys", to: "project/web/arch-sys" }, mai), code("not_found"), "web is not hers");

    // A new key must not slip a page past the rules: into AGENTS.md, into the skills folder, or away from its repo.
    const writer: Actor = { name: "tu", role: "member", access: { projects: { app: { permissions: ["view", "docEdit"] } } } };
    await assert.rejects(h.call("docs.move", { key: "project/app/arch-sys", to: "project/app/agents" }, writer), code("forbidden"), "AGENTS.md is the Context agent's");
    await assert.rejects(h.call("docs.move", { key: "project/app/arch-sys", to: "project/app/skills/arch-sys" }, admin), code("bad_request", "errors.docMoveSkill"));
    await h.call("docs.save", { key: "project/app/readme", content: "# Đọc", mirror: { from: "README.md", commit: "abc123" } }, admin);
    await assert.rejects(h.call("docs.move", { key: "project/app/readme", to: "system/customer-ai/readme" }, admin), code("bad_request", "errors.docMirrorMove"));

    // Moving inside one space still works the way it did.
    assert.equal((await h.call("docs.move", { key: "project/app/arch-db", parent: null }, admin)).parent, null);
  });

  it("does not bring a page back into a system that is gone", async () => {
    const h = await withSystem();
    await h.call("docs.move", { key: "project/app/arch-db", to: "system/customer-ai/arch-db" }, admin);
    await h.call("docs.remove", { key: "system/customer-ai/arch-db" }, admin);
    assert.deepEqual(await h.call("systems.remove", { name: "customer-ai" }, admin), { removed: true }, "its last page in use is gone");
    await assert.rejects(h.call("docs.restore", { key: "system/customer-ai/arch-db" }, admin), code("not_found", "errors.systemNotFound"));
  });

  it("renames a page in its own space without touching the pages under it", async () => {
    const h = await withSystem();
    const moved = await h.call("docs.move", { key: "project/app/arch-sys", to: "project/app/so-do" }, admin);
    assert.deepEqual(moved.moved, [{ from: "project/app/arch-sys", to: "project/app/so-do" }], "only the page itself got a new key");
    assert.equal((await h.call("docs.get", { key: "project/app/arch-db" }, admin))?.parent, "project/app/so-do", "and the page under it followed");
  });

  it("takes a removed page under it along, still removed and still restorable", async () => {
    const h = await withSystem();
    await h.call("docs.remove", { key: "project/app/arch-db" }, admin);
    await h.call("docs.move", { key: "project/app/arch-sys", to: "system/customer-ai/arch-sys" }, admin);
    const gone = await h.call("docs.get", { key: "system/customer-ai/arch-db" }, admin);
    assert.equal(gone?.removedAt != null, true, "it moved and stayed removed");
    await h.call("docs.restore", { key: "system/customer-ai/arch-db" }, admin);
    assert.equal((await h.call("docs.get", { key: "system/customer-ai/arch-db" }, admin))?.parent, "system/customer-ai/arch-sys");
  });

  it("sends the keys a page had before straight to where it ended up", async () => {
    const h = await withSystem();
    await h.call("docs.move", { key: "project/app/arch-db", to: "project/app/db" }, admin);
    await h.call("docs.move", { key: "project/app/db", to: "system/customer-ai/db" }, admin);
    assert.equal((await h.call("docs.get", { key: "project/app/arch-db" }, admin))?.key, "system/customer-ai/db");
    // A new page at a key that was left behind is itself again, not a signpost.
    await h.call("docs.save", { key: "project/app/db", content: "# DB mới" }, admin);
    assert.equal((await h.call("docs.get", { key: "project/app/db" }, admin))?.content, "# DB mới");
  });
});

describe("letting a project key rest (roadmap 38g)", () => {
  it("keeps it listed while something is still on it, and hides it once nothing is", async () => {
    const h = await hive();
    await h.call("tasks.create", { id: "A-1", project: "app", title: "Việc cũ" }, admin);
    const retired = await h.call("projects.retire", { project: "app", note: "xong dự án" }, admin);
    assert.equal(retired.hidden, false);
    assert.deepEqual(retired.left, { machines: 0, docs: 3, openTasks: 1 });

    await h.call("docs.remove", { key: "project/app/arch" }, admin);
    await h.call("tasks.update", { id: "A-1", status: "done" }, admin);
    const [now] = await h.call("projects.retired", {}, admin);
    assert.equal(now?.hidden, true, "no machine, page or open task left");
    assert.equal(now?.by, "duy");
    assert.equal(now?.note, "xong dự án");

    assert.deepEqual(await h.call("projects.resume", { project: "app" }, admin), { removed: true });
    assert.deepEqual(await h.call("projects.retired", {}, admin), [], "it can be undone");
    assert.deepEqual(await h.call("projects.resume", { project: "app" }, admin), { removed: false });
  });

  it("is a hub admin's to do, and goes in the log", async () => {
    const h = await hive();
    const manager: Actor = { name: "mai", role: "member", access: { projects: { app: "manage" } } };
    await assert.rejects(h.call("projects.retire", { project: "app" }, manager), code("forbidden"));
    await assert.rejects(h.call("projects.resume", { project: "app" }, manager), code("forbidden"));
    await h.call("projects.retire", { project: "app", note: "xong" }, admin);
    const log = await h.call("admin.audit", { limit: 10, action: "projects.retire" }, admin);
    assert.equal(log[0]?.target, "app");
    assert.equal(log[0]?.detail, "xong");
  });
});
