import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { filesDir } from "#web/backup.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };
const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const tmp = () => testTmpDir(path.join(os.tmpdir(), "hive-cli-"));
// The shell running the tests may carry a real hub's settings (HIVE_SEAWEEDFS_URL, HIVE_BACKUP_DIR…): the CLI must see only the test's.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));

/** The CLI as the server shell runs it. Async, not execFileSync: the fake filer lives in this process and must keep answering. */
function run(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...cleanEnv, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const body = async (req: IncomingMessage) => {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

/** Same filer as seaweed.test.ts (SeaweedFS 4.48: PUT 201, GET 200 or 404); importing it would run that file's tests too. */
async function fakeFiler() {
  const files = new Map<string, Buffer>();
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "PUT") {
      const bytes = await body(req);
      files.set(url, bytes);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ name: url.split("/").pop(), size: bytes.length }));
    } else if (req.method === "GET") {
      const f = files.get(url);
      if (!f) res.writeHead(404).end();
      else res.writeHead(200).end(f);
    } else res.writeHead(405).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, files };
}

describe("hub CLI (node src/cli.ts)", () => {
  it("files restore puts a backup's files into the filer and skips those whose bytes do not match their name", async () => {
    const filer = await fakeFiler();
    const root = tmp();
    const dir = path.join(root, "backups");
    mkdirSync(filesDir(dir), { recursive: true });
    const good = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const bad = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
    const badName = hex(new Uint8Array([7, 8, 9]));
    writeFileSync(path.join(filesDir(dir), hex(good)), good);
    writeFileSync(path.join(filesDir(dir), badName), bad);
    writeFileSync(path.join(filesDir(dir), "notes.txt"), "not a file of the hub");

    const r = await run(["files", "restore", dir], { HIVE_DB: path.join(root, "hub.db"), HIVE_SEAWEEDFS_URL: filer.url });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^1 files put back into ${filer.url}`));
    assert.match(r.stderr, new RegExp(`skipped ${badName}`));
    assert.deepEqual([...filer.files.keys()], [`/xdev-hive/doc-files/${hex(good).slice(0, 2)}/${hex(good)}`]);
    assert.deepEqual(new Uint8Array(filer.files.values().next().value!), good);

    // HIVE_BACKUP_DIR stands in for the folder argument, and without a filer nothing is touched.
    const viaEnv = await run(["files", "restore"], { HIVE_DB: path.join(root, "hub.db"), HIVE_BACKUP_DIR: dir, HIVE_SEAWEEDFS_URL: filer.url });
    assert.match(viaEnv.stdout, /^1 files put back/);
    const noFiler = await run(["files", "restore", dir], { HIVE_DB: path.join(root, "hub.db") });
    assert.equal(noFiler.code, 1);
    assert.match(noFiler.stderr, /HIVE_SEAWEEDFS_URL/);
  });

  it("backup writes a snapshot of HIVE_DB that SqliteHive opens", async () => {
    const root = tmp();
    const db = path.join(root, "hub.db");
    const hive = new SqliteHive(db);
    await hive.call("docs.save", { key: "org/style", content: "Tabs, not spaces" }, admin);
    hive.close();

    const dir = path.join(root, "backups");
    const r = await run(["backup", dir, "2"], { HIVE_DB: db });
    assert.equal(r.code, 0, r.stderr);
    const file = r.stdout.split("\n")[0]!;
    assert.equal(path.dirname(file), dir);
    assert.ok(existsSync(file));
    const restored = new SqliteHive(file);
    assert.equal((await restored.call("docs.get", { key: "org/style" }, admin))?.content, "Tabs, not spaces");
    restored.close();

    const missing = await run(["backup", dir], { HIVE_DB: path.join(root, "nope.db") });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No database/);
  });

  it("token create prints a token the hub accepts", async () => {
    const db = path.join(tmp(), "hub.db");
    const r = await run(["token", "create", "ci", "agent"], { HIVE_DB: db });
    assert.equal(r.code, 0, r.stderr);
    const [head, token] = r.stdout.trim().split("\n");
    assert.match(head!, /^ci \(agent, id .+\):$/);
    assert.match(token!, /^hive_/);

    const hive = new SqliteHive(db);
    const server = createHubApp({ hive, tokens: new TokenStore(hive.db), users: new UserStore(hive.db), allowedHosts: ["127.0.0.1", "localhost"] }).listen(0, "127.0.0.1");
    await new Promise((ok) => server.once("listening", ok));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const rpc = (bearer: string) =>
        fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ method: "docs.list" }) });
      const ok = await rpc(token!);
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray(((await ok.json()) as { result: unknown }).result));
      assert.equal((await rpc("hive_nope")).status, 401);
    } finally {
      server.close();
      hive.close();
    }
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
