import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docAssetPath, docAssetRef, docLinkRefs, HiveError, replaceDocLinks, resolveDocLink, transferHive, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
/** Manages web, contributes to app. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "contribute", web: "manage" } } };
const hoa: Actor = { name: "hoa", role: "member", access: { projects: { app: "contribute" } } };
const code = (c: string, key?: string) => (e: unknown) => e instanceof HiveError && e.code === c && (!key || e.key === key);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");

async function tree() {
  const hive = new SqliteHive(":memory:");
  const save = (key: string, content: string, extra: Record<string, unknown> = {}) => hive.call("docs.save", { key, content, ...extra }, admin);
  await save("project/app/arch", "", { title: "Kiến trúc", folder: true });
  await save("project/app/arch-sys", "# Sơ đồ\nXem [[arch-db]] và [[org/security|Bảo mật]].", { title: "Sơ đồ hệ thống", parent: "project/app/arch" });
  await save("project/app/arch-db", "# DB\n```\n[[not-a-link]]\n```\nQuay lại [[arch-sys]]. Chưa có [[arch-cache]].", { title: "Cơ sở dữ liệu", parent: "project/app/arch" });
  await save("org/security", "Theo `[[code]]` và [[testing]].", { title: "Bảo mật" });
  await save("project/web/home", "Xem [[project/app/arch-sys]].", { title: "Trang web" });
  return hive;
}

describe("doc links (browser-safe helpers)", () => {
  it("finds [[links]] outside code, each once, with their text", () => {
    const md = "Xem [[a]] và [[b|Bê]], lại [[a]].\n`[[inline]]`\n```js\n[[fenced]]\n```\n~~~\n[[tilde]]\n~~~\nCuối [[c]]";
    assert.deepEqual(docLinkRefs(md), [
      { target: "a", label: null },
      { target: "b", label: "Bê" },
      { target: "c", label: null },
    ]);
    assert.equal(replaceDocLinks("[[a|A]] `[[b]]`", (t, l) => `<${t}:${l}>`), "<a:A> `[[b]]`");
  });

  it("resolves a slug in the page's space, then the team's, and full keys as they are", () => {
    const have = new Set(["project/app/x", "org/y"]);
    const exists = (k: string) => have.has(k);
    assert.deepEqual(resolveDocLink("x", "project/app/z", exists), { key: "project/app/x", exists: true });
    assert.deepEqual(resolveDocLink("y", "project/app/z", exists), { key: "org/y", exists: true }, "falls back to the team's page");
    assert.deepEqual(resolveDocLink("q", "project/app/z", exists), { key: "project/app/q", exists: false }, "broken: points at its own space");
    assert.deepEqual(resolveDocLink("org/y", "project/web/a", exists), { key: "org/y", exists: true });
    assert.equal(resolveDocLink("Not A Slug!", "org/a", exists), null);
  });

  it("names a page's files assets/<slug>/<name>", () => {
    assert.deepEqual(docAssetRef("assets/arch-sys/overview.png", "project/app/arch-db"), { key: "project/app/arch-sys", name: "overview.png" });
    assert.deepEqual(docAssetRef(docAssetPath("org/security", "Sơ đồ 1.png"), "org/x"), { key: "org/security", name: "Sơ đồ 1.png" });
    assert.equal(docAssetRef("https://example.com/a.png", "org/x"), null);
    assert.equal(docAssetRef("assets/../x.png", "org/x"), null);
  });
});

describe("doc tree", () => {
  it("keeps where a page sits and whether it is a folder", async () => {
    const hive = await tree();
    const list = await hive.call("docs.list", { project: "app" }, admin);
    const byKey = new Map(list.map((d) => [d.key, d]));
    assert.equal(byKey.get("project/app/arch")?.folder, true);
    assert.equal(byKey.get("project/app/arch-sys")?.parent, "project/app/arch");
    // A new version without parent keeps where the page is.
    const again = await hive.call("docs.save", { key: "project/app/arch-sys", content: "v2" }, admin);
    assert.equal(again.parent, "project/app/arch");
    assert.equal(again.version, 2);
  });

  it("moves a page without a new version, and refuses loops, other spaces, skills and missing parents", async () => {
    const hive = await tree();
    const moved = await hive.call("docs.move", { key: "project/app/arch-db", parent: "project/app/arch-sys" }, admin);
    assert.equal(moved.parent, "project/app/arch-sys");
    assert.equal((await hive.call("docs.get", { key: "project/app/arch-db" }, admin))?.version, 1);
    const move = (key: string, parent: string | null) => hive.call("docs.move", { key, parent }, admin);
    await assert.rejects(move("project/app/arch", "project/app/arch-db"), code("bad_request", "errors.docParentCycle"));
    await assert.rejects(move("project/app/arch", "project/app/arch"), code("bad_request", "errors.docParentSelf"));
    await assert.rejects(move("project/app/arch", "org/security"), code("bad_request", "errors.docParentSpace"));
    await assert.rejects(move("project/app/arch", "project/app/nope"), code("bad_request", "errors.docParentMissing"));
    await hive.call("docs.save", { key: "project/app/skills/deploy", content: "---\nname: deploy\ndescription: Deploy\n---\nSteps" }, admin);
    await assert.rejects(move("project/app/arch", "project/app/skills/deploy"), code("bad_request", "errors.docParentSkill"));
    assert.equal((await move("project/app/arch-db", null)).parent, null, "back to the top");
    await assert.rejects(hive.call("docs.move", { key: "project/app/arch-db", parent: "project/app/arch" }, lan), code("forbidden"), "contributors do not move pages");
  });

  it("stops nesting at the depth limit", async () => {
    const hive = new SqliteHive(":memory:");
    let parent: string | null = null;
    for (let i = 1; i <= 9; i++) {
      const key = `org/level-${i}`;
      const save = hive.call("docs.save", { key, content: String(i), parent }, admin);
      if (i <= 8) await save;
      else await assert.rejects(save, code("bad_request", "errors.docParentDepth"));
      parent = key;
    }
  });
});

describe("doc links on the hub", () => {
  it("lists the links out (broken ones too), the pages linking in with a line of context, and memory naming the page", async () => {
    const hive = await tree();
    await hive.call("memory.write", { project: "app", kind: "decision", content: "Sơ đồ ở project/app/arch-sys là bản đúng." }, admin);
    const links = await hive.call("docs.links", { key: "project/app/arch-sys" }, admin);
    assert.deepEqual(
      links.out.map((l) => [l.key, l.title, l.exists]),
      [
        ["project/app/arch-db", "Cơ sở dữ liệu", true],
        ["org/security", "Bảo mật", true],
      ],
    );
    assert.deepEqual(
      links.back.map((b) => [b.key, b.snippet]),
      [
        ["project/app/arch-db", "Quay lại Sơ đồ hệ thống. Chưa có arch-cache."],
        ["project/web/home", "Xem Sơ đồ hệ thống."],
      ],
    );
    assert.equal(links.memory.length, 1);
    const db = await hive.call("docs.links", { key: "project/app/arch-db" }, admin);
    assert.deepEqual(
      db.out.map((l) => [l.key, l.exists]),
      [
        ["project/app/arch-sys", true],
        ["project/app/arch-cache", false],
      ],
      "a link inside a code block is not a link",
    );
  });

  it("shows only pages the person can see", async () => {
    const hive = await tree();
    const links = await hive.call("docs.links", { key: "project/app/arch-sys" }, hoa);
    assert.deepEqual(
      links.back.map((b) => b.key),
      ["project/app/arch-db"],
      "hoa has nothing on web",
    );
  });
});

describe("files on a page", () => {
  it("keeps a file, gives it back, replaces one of the same name, and lists them", async () => {
    const hive = await tree();
    const put = await hive.call("docs.assetPut", { key: "project/app/arch-sys", name: "overview.png", data: PNG }, lan);
    assert.equal(put.type, "image/png");
    assert.equal(put.size, 12);
    assert.equal(put.uploadedBy, "lan");
    const got = await hive.call("docs.assetGet", { key: "project/app/arch-sys", name: "overview.png" }, hoa);
    assert.equal(got?.data, PNG);
    await hive.call("docs.assetPut", { key: "project/app/arch-sys", name: "overview.png", data: PNG }, lan);
    assert.equal((await hive.call("docs.assets", { key: "project/app/arch-sys" }, admin)).length, 1);
    assert.equal(await hive.call("docs.assetGet", { key: "project/app/arch-sys", name: "nope.png" }, admin), null);
  });

  it("refuses what chat refuses too, and lets only the uploader or a manager remove a file", async () => {
    const hive = await tree();
    const exe = Buffer.from("MZ\u0090\u0000binary").toString("base64");
    await assert.rejects(hive.call("docs.assetPut", { key: "project/app/arch-sys", name: "tool.exe", data: exe }, admin), code("bad_request", "errors.chatFileType"));
    await hive.call("docs.assetPut", { key: "project/app/arch-sys", name: "a.png", data: PNG }, lan);
    await assert.rejects(hive.call("docs.assetRemove", { key: "project/app/arch-sys", name: "a.png" }, hoa), code("forbidden"), "hoa only contributes");
    await assert.rejects(hive.call("docs.assetPut", { key: "project/app/arch-sys", name: "a.png", data: PNG }, hoa), code("forbidden"), "nor replaces lan's file");
    assert.deepEqual(await hive.call("docs.assetRemove", { key: "project/app/arch-sys", name: "a.png" }, lan), { removed: true });
    const viewer: Actor = { name: "vi", role: "member", access: { projects: { app: "view" } } };
    await assert.rejects(hive.call("docs.assetPut", { key: "project/app/arch-sys", name: "b.png", data: PNG }, viewer), code("forbidden"));
  });
});

describe("moving a machine's docs to the hub", () => {
  it("keeps where pages sit and the files they carry", async () => {
    const local = await tree();
    await local.call("docs.assetPut", { key: "project/app/arch-sys", name: "overview.png", data: PNG }, admin);
    const hub = new SqliteHive(":memory:");
    await transferHive({ backend: local, actor: admin, label: "máy" }, { backend: hub, actor: admin, label: "hub" });
    const list = await hub.call("docs.list", { project: "app" }, admin);
    assert.equal(list.find((d) => d.key === "project/app/arch-sys")?.parent, "project/app/arch");
    assert.equal(list.find((d) => d.key === "project/app/arch")?.folder, true);
    assert.equal((await hub.call("docs.assetGet", { key: "project/app/arch-sys", name: "overview.png" }, admin))?.data, PNG);
  });
});
