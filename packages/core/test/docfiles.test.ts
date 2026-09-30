import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HiveError, type Actor, type BlobStore } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const png = (...tail: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]).toString("base64");
const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const code = (c: string, key?: string) => (e: unknown) => e instanceof HiveError && e.code === c && (!key || e.key === key);

/** A store in memory, with a switch to make it fail like a store that is down. */
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const store = {
    down: false as boolean,
    files,
    name: "seaweedfs",
    where: "http://seaweedfs:8888",
    async put(id: string, bytes: Uint8Array) {
      if (store.down) throw new Error("connect ECONNREFUSED");
      files.set(id, new Uint8Array(bytes));
    },
    async get(id: string) {
      if (store.down) throw new Error("connect ECONNREFUSED");
      return files.get(id) ?? null;
    },
    async remove(id: string) {
      if (store.down) throw new Error("connect ECONNREFUSED");
      files.delete(id);
    },
  } satisfies BlobStore & { down: boolean; files: Map<string, Uint8Array> };
  return store;
}

async function page(hive: SqliteHive, key = "project/app/arch") {
  await hive.call("docs.save", { key, content: "# Kiến trúc" }, admin);
  return key;
}
// Rows from node:sqlite have no prototype: copied into plain objects to compare.
const inDb = (db: DatabaseSync) =>
  (db.prepare("SELECT name, stored, length(data) AS n FROM doc_assets ORDER BY name").all() as Array<{ name: string; stored: string | null; n: number }>).map((r) => ({ ...r }));

describe("doc files in a store (roadmap 23c)", () => {
  it("keeps the bytes in the store and what the file is in the database", async () => {
    const store = memoryStore();
    const hive = new SqliteHive(":memory:", { blobs: store });
    const key = await page(hive);
    const data = png(1, 2, 3);
    const put = await hive.call("docs.assetPut", { key, name: "a.png", data }, admin);
    assert.equal(put.size, 11);
    assert.deepEqual(inDb(hive.db), [{ name: "a.png", stored: "seaweedfs", n: 0 }]);
    assert.deepEqual([...store.files.keys()], [sha(data)]);
    assert.equal((await hive.call("docs.assetGet", { key, name: "a.png" }, admin))?.data, data);
    assert.deepEqual(hive.storedFileIds(), [sha(data)]);
    assert.deepEqual({ ...hive.filesInfo(), lastError: null }, { store: "seaweedfs", where: "http://seaweedfs:8888", count: 1, bytes: 11, inDb: 0, lastError: null });
  });

  it("keeps the same bytes once, and removes them when no file points at them", async () => {
    const store = memoryStore();
    const hive = new SqliteHive(":memory:", { blobs: store });
    const a = await page(hive, "project/app/a");
    const b = await page(hive, "project/app/b");
    const data = png(9);
    await hive.call("docs.assetPut", { key: a, name: "x.png", data }, admin);
    await hive.call("docs.assetPut", { key: b, name: "y.png", data }, admin);
    assert.equal(store.files.size, 1);
    await hive.call("docs.assetRemove", { key: a, name: "x.png" }, admin);
    assert.equal(store.files.size, 1, "b still points at it");
    // Replacing b's file with other bytes lets the old ones go.
    await hive.call("docs.assetPut", { key: b, name: "y.png", data: png(7, 7) }, admin);
    assert.deepEqual([...store.files.keys()], [sha(png(7, 7))]);
    await hive.call("docs.assetRemove", { key: b, name: "y.png" }, admin);
    assert.equal(store.files.size, 0);
  });

  it("keeps no file when the store is down, and says the store did not answer", async () => {
    const store = memoryStore();
    const hive = new SqliteHive(":memory:", { blobs: store });
    const key = await page(hive);
    await hive.call("docs.assetPut", { key, name: "a.png", data: png(1) }, admin);
    store.down = true;
    await assert.rejects(hive.call("docs.assetPut", { key, name: "b.png", data: png(2) }, admin), code("unavailable", "errors.fileStore"));
    await assert.rejects(hive.call("docs.assetGet", { key, name: "a.png" }, admin), code("unavailable", "errors.fileStore"));
    assert.deepEqual(inDb(hive.db).map((r) => r.name), ["a.png"]);
    assert.match(hive.filesInfo().lastError ?? "", /ECONNREFUSED/);
  });

  it("moves files kept in the database into the store, and a hub without the store says where they are", async () => {
    const db = new DatabaseSync(":memory:");
    const before = new SqliteHive(db);
    const key = await page(before);
    const one = png(1);
    const two = png(2, 2);
    await before.call("docs.assetPut", { key, name: "one.png", data: one }, admin);
    await before.call("docs.assetPut", { key, name: "two.png", data: two }, admin);
    assert.deepEqual(inDb(db).map((r) => r.stored), [null, null]);
    assert.equal(await before.moveFilesToStore(), 0, "no store: nothing moves");

    const store = memoryStore();
    const hub = new SqliteHive(db, { blobs: store });
    assert.equal(hub.filesInfo().inDb, 2);
    assert.equal(await hub.moveFilesToStore(1), 1);
    assert.equal(await hub.moveFilesToStore(), 1);
    assert.equal(await hub.moveFilesToStore(), 0);
    assert.deepEqual(inDb(db), [
      { name: "one.png", stored: "seaweedfs", n: 0 },
      { name: "two.png", stored: "seaweedfs", n: 0 },
    ]);
    assert.equal((await hub.call("docs.assetGet", { key, name: "two.png" }, admin))?.data, two);
    assert.equal(hub.filesInfo().inDb, 0);

    // The same database opened without the store cannot give the bytes: it says so instead of an empty file.
    const without = new SqliteHive(db);
    await assert.rejects(without.call("docs.assetGet", { key, name: "one.png" }, admin), code("unavailable", "errors.fileStoreOff"));
  });

  it("says a file is missing when the store lost it or holds other bytes", async () => {
    const store = memoryStore();
    const hive = new SqliteHive(":memory:", { blobs: store });
    const key = await page(hive);
    const data = png(5);
    await hive.call("docs.assetPut", { key, name: "a.png", data }, admin);
    store.files.set(sha(data), new Uint8Array([1, 2, 3]));
    await assert.rejects(hive.call("docs.assetGet", { key, name: "a.png" }, admin), code("not_found", "errors.fileMissing"));
    store.files.clear();
    await assert.rejects(hive.call("docs.assetGet", { key, name: "a.png" }, admin), code("not_found", "errors.fileMissing"));
  });

  it("stays in the database without a store, as before", async () => {
    const hive = new SqliteHive(":memory:");
    const key = await page(hive);
    await hive.call("docs.assetPut", { key, name: "a.png", data: png(1) }, admin);
    assert.deepEqual(inDb(hive.db), [{ name: "a.png", stored: null, n: 9 }]);
    assert.deepEqual(hive.storedFileIds(), []);
    assert.deepEqual(hive.filesInfo(), { store: null, where: null, count: 1, bytes: 9, inDb: 1, lastError: null });
  });
});
