import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { backupDatabase, backupFiles, filesDir } from "#web/backup.ts";
import { seaweedFromEnv, seaweedStore } from "#web/seaweed.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const tmp = () => testTmpDir(path.join(os.tmpdir(), "hive-seaweed-"));
const png = (...tail: number[]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]);
const body = async (req: IncomingMessage) => {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

/** A filer as SeaweedFS 4.48 answers: PUT 201, GET 200 or 404, DELETE 204 even for nothing. */
async function fakeFiler() {
  const files = new Map<string, { bytes: Buffer; type: string }>();
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    seen.push(`${req.method} ${url}`);
    if (req.method === "PUT") {
      const bytes = await body(req);
      files.set(url, { bytes, type: String(req.headers["content-type"] ?? "") });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ name: url.split("/").pop(), size: bytes.length }));
    } else if (req.method === "GET") {
      const f = files.get(url);
      if (!f) res.writeHead(404).end();
      else res.writeHead(200, { "content-type": f.type }).end(f.bytes);
    } else if (req.method === "DELETE") {
      files.delete(url);
      res.writeHead(204).end();
    } else res.writeHead(405).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, files, seen };
}

async function roundTrip(url: string, prefix: string) {
  const store = seaweedStore({ url, prefix });
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
  const id = hex(bytes);
  assert.equal(await store.get(id), null);
  await store.put(id, bytes, "application/pdf");
  await store.put(id, bytes, "application/pdf");
  assert.deepEqual(await store.get(id), bytes);
  await store.remove(id);
  await store.remove(id);
  assert.equal(await store.get(id), null);
}

describe("SeaweedFS for doc files (roadmap 23c)", () => {
  it("puts, gets and removes a file by its SHA-256 under the prefix", async () => {
    const filer = await fakeFiler();
    await roundTrip(filer.url, "/xdev-hive/doc-files");
    const id = hex(new Uint8Array(300_000).map((_, i) => (i * 31) % 251));
    assert.ok(filer.seen.includes(`PUT /xdev-hive/doc-files/${id.slice(0, 2)}/${id}`));
    assert.throws(() => seaweedStore({ url: "ftp://x" }), /http/);
    await assert.rejects(seaweedStore({ url: filer.url }).get("../../etc/passwd"), /SHA-256/);
  });

  it("reads HIVE_SEAWEEDFS_URL, and without it doc files stay in the database", () => {
    assert.equal(seaweedFromEnv({}), null);
    assert.equal(seaweedFromEnv({ HIVE_SEAWEEDFS_URL: " " }), null);
    const store = seaweedFromEnv({ HIVE_SEAWEEDFS_URL: "http://seaweedfs:8888" });
    assert.equal(store?.name, "seaweedfs");
    assert.equal(store?.where, "http://seaweedfs:8888");
  });

  it("works against a real filer when HIVE_TEST_SEAWEEDFS_URL is set", { skip: !process.env.HIVE_TEST_SEAWEEDFS_URL }, async () => {
    await roundTrip(process.env.HIVE_TEST_SEAWEEDFS_URL!, `/xdev-hive-test/${Date.now()}`);
  });

  it("keeps a hub's files there, and copies them into backups/files with each backup", async () => {
    const filer = await fakeFiler();
    const root = tmp();
    const hive = new SqliteHive(path.join(root, "hub.db"), { blobs: seaweedStore({ url: filer.url }) });
    const key = "org/style";
    await hive.call("docs.save", { key, content: "Tabs" }, admin);
    const a = png(1);
    const b = png(2);
    await hive.call("docs.assetPut", { key, name: "a.png", data: Buffer.from(a).toString("base64") }, admin);
    await hive.call("docs.assetPut", { key, name: "b.png", data: Buffer.from(b).toString("base64") }, admin);
    const artifact = png(3);
    await hive.call("tasks.create", { id: "APP-1", project: "app", title: "Task" }, admin);
    await hive.call("artifacts.put", {
      project: "app", taskId: "APP-1", runId: "R-1", name: "run.png", data: Buffer.from(artifact).toString("base64"),
    }, { name: "runner.test", role: "agent", source: { via: "api", machine: "test", run: "R-1", task: "APP-1" } });
    assert.equal(filer.files.size, 3);

    const dir = path.join(root, "backups");
    backupDatabase(hive.db, { dir, keep: 1 });
    mkdirSync(filesDir(dir), { recursive: true });
    writeFileSync(path.join(filesDir(dir), "notes.txt"), "not a file of the hub");
    assert.deepEqual(await backupFiles(hive, dir), { copied: 3, kept: 3, removed: 0, missing: [] });
    assert.deepEqual(new Uint8Array(readFileSync(path.join(filesDir(dir), hex(a)))), a);
    assert.deepEqual(await backupFiles(hive, dir), { copied: 0, kept: 3, removed: 0, missing: [] }, "only what is new");
    assert.deepEqual(new Uint8Array(readFileSync(path.join(filesDir(dir), hex(artifact)))), artifact, "run artifacts are included");

    // The snapshot still points at an artifact even after its row is removed from the live database.
    await hive.call("artifacts.remove", { id: (await hive.call("artifacts.list", { project: "app", runId: "R-1" }, admin))[0]!.id }, admin);
    assert.equal((await backupFiles(hive, dir)).removed, 0);

    // b removed: the snapshot still points at it, so the backup keeps it until that snapshot goes.
    await hive.call("docs.assetRemove", { key, name: "b.png" }, admin);
    assert.equal((await backupFiles(hive, dir)).removed, 0);
    await new Promise((r) => setTimeout(r, 5));
    backupDatabase(hive.db, { dir, keep: 1 });
    // The new snapshot has neither b nor the removed artifact, and the old one is gone: both leave the backup.
    assert.deepEqual(await backupFiles(hive, dir), { copied: 0, kept: 1, removed: 2, missing: [] });
    assert.equal(existsSync(path.join(filesDir(dir), hex(b))), false);
    assert.equal(existsSync(path.join(filesDir(dir), hex(artifact))), false);
    assert.ok(readdirSync(filesDir(dir)).includes("notes.txt"), "leaves other files alone");

    // A file the store lost is reported, not copied.
    filer.files.clear();
    await hive.call("docs.assetPut", { key, name: "c.png", data: Buffer.from(png(3)).toString("base64") }, admin);
    filer.files.clear();
    assert.deepEqual((await backupFiles(hive, dir)).missing, [hex(png(3))]);
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
