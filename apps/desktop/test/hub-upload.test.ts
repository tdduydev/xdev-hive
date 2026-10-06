import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { describeBuild, uploadToHub } from "#desktop/scripts/hub-upload.mjs";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const version = "0.90.0";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Big enough that the body comes in several chunks, so "cut" really breaks it off part-way.
const macBytes = Buffer.alloc(1_000_000, "m");
const winBytes = Buffer.from("the windows build");
const dir = testTmpDir(path.join(os.tmpdir(), "hive-hub-upload-"));
const mac = path.join(dir, `xdev-hive-${version}-mac-arm64.zip`);
const win = path.join(dir, `xdev-hive-${version}-win-x64-setup.exe`);
const other = path.join(dir, `xdev-hive-${version}.zip`);
writeFileSync(mac, macBytes);
writeFileSync(win, winBytes);
writeFileSync(other, "not a build electron-builder names per platform");

/** What the fake hub does with one upload request: take it, answer 502 / 409 / 400, or drop the connection mid-body. */
type Step = "ok" | 502 | 409 | 400 | "cut";
type Seen = { name: string; part: string | null; upload: string | null; bytes: Buffer };

const servers: (() => void)[] = [];
after(() => servers.forEach((close) => close()));

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
  });

async function fakeHub(opts: { files?: { name: string; sha256: string }[]; uploadPart?: number; plan?: Record<string, Step[]> } = {}) {
  const attempts: string[] = [];
  const uploads: Seen[] = [];
  const notes: unknown[] = [];
  const tokens = new Set<string>();
  const server = createServer(async (req, res) => {
    tokens.add(String(req.headers.authorization ?? ""));
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname === "/api/rpc") {
      const { method, input } = JSON.parse((await body(req)).toString());
      if (method === "releases.list") {
        const releases = [{ version, files: opts.files ?? [] }];
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { releases, uploadPart: opts.uploadPart ?? null } }));
      }
      if (method === "releases.notes") notes.push(input);
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: null }));
    }
    if (url.pathname !== "/api/releases/upload") return void res.writeHead(404).end();
    const name = url.searchParams.get("name") ?? "";
    attempts.push(name);
    const step = opts.plan?.[name]?.shift() ?? "ok";
    if (step === "cut") return void req.once("data", () => req.socket.destroy());
    const bytes = await body(req);
    if (step !== "ok") return void res.writeHead(step).end(`hub says ${step}`);
    uploads.push({ name, part: url.searchParams.get("part"), upload: url.searchParams.get("upload"), bytes });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, attempts, uploads, notes, tokens };
}

function run(hub: string, assets = [mac, win, other]) {
  const log: string[] = [];
  const waits: number[] = [];
  const done = uploadToHub({ hub, token: "admin-token", version, assets, notes: "- đổi gì", log: (l) => log.push(l), wait: async (a) => void waits.push(a) });
  return { done, log, waits };
}

describe("release upload to the hub", () => {
  it("reads platform, arch and kind from electron-builder's file names", () => {
    assert.deepEqual(describeBuild(`xdev-hive-${version}-mac-arm64.dmg`), { platform: "mac", arch: "arm64", kind: "dmg" });
    assert.deepEqual(describeBuild(`xdev-hive-${version}-win-x64-setup.exe`), { platform: "win", arch: "x64", kind: "exe" });
    assert.deepEqual(describeBuild(`xdev-hive-${version}-linux-x86_64.AppImage`), { platform: "linux", arch: "x64", kind: "AppImage" });
    assert.equal(describeBuild(`xdev-hive-${version}.zip`), null);
    assert.equal(describeBuild("SHA256SUMS.txt"), null);
  });

  it("sends every build once with its metadata, then the notes", async () => {
    const hub = await fakeHub();
    const { done } = run(hub.url);
    await done;
    assert.deepEqual(hub.attempts, [path.basename(mac), path.basename(win)]);
    assert.ok(hub.uploads[0]?.bytes.equals(macBytes));
    assert.ok(hub.uploads[1]?.bytes.equals(winBytes));
    assert.deepEqual(hub.notes, [{ version, notes: "- đổi gì" }]);
    assert.deepEqual([...hub.tokens], ["Bearer admin-token"]);
  });

  it("skips a file the hub has with the same name and sha, sends one whose sha differs", async () => {
    const hub = await fakeHub({ files: [{ name: path.basename(mac), sha256: sha(macBytes) }, { name: path.basename(win), sha256: sha(Buffer.from("an older win build")) }] });
    const { done, log } = run(hub.url);
    await done;
    assert.deepEqual(hub.attempts, [path.basename(win)]);
    assert.ok(log.includes(`hub = ${path.basename(mac)} (already there)`));
    assert.equal(hub.notes.length, 1);
  });

  it("sends the whole file again after a 502", async () => {
    const hub = await fakeHub({ plan: { [path.basename(mac)]: [502] } });
    const { done, log, waits } = run(hub.url, [mac]);
    await done;
    assert.deepEqual(hub.attempts, [path.basename(mac), path.basename(mac)]);
    assert.equal(hub.uploads.length, 1);
    assert.ok(hub.uploads[0]?.bytes.equals(macBytes));
    assert.deepEqual(waits, [1]);
    assert.ok(log.some((l) => l.includes("sending it again (2/3)")));
  });

  it("sends the whole file again after the connection drops mid-body", async () => {
    const hub = await fakeHub({ plan: { [path.basename(mac)]: ["cut"] } });
    const { done } = run(hub.url, [mac]);
    await done;
    assert.equal(hub.attempts.length, 2);
    assert.equal(hub.uploads.length, 1);
    assert.ok(hub.uploads[0]?.bytes.equals(macBytes));
  });

  it("starts a file in parts over from its first part, under a new upload id", async () => {
    // 1 MB in parts of 400 KB: three parts; the second one is cut off (or the hub dropped the parts: 409).
    const hub = await fakeHub({ uploadPart: 400_000, plan: { [path.basename(mac)]: ["ok", "cut", "ok", 409] } });
    const { done, waits } = run(hub.url, [mac]);
    await done;
    assert.deepEqual(
      hub.uploads.map((u) => u.part),
      ["0", "0", "0", "1", "2"],
    );
    const last = hub.uploads.slice(-3);
    assert.equal(new Set(hub.uploads.map((u) => u.upload)).size, 3);
    assert.equal(new Set(last.map((u) => u.upload)).size, 1);
    assert.ok(Buffer.concat(last.map((u) => u.bytes)).equals(macBytes));
    assert.deepEqual(waits, [1, 2]);
  });

  it("stops after three failures with an error naming the file, and sends no notes", async () => {
    const hub = await fakeHub({ plan: { [path.basename(mac)]: [502, 502, 502] } });
    const { done, waits } = run(hub.url);
    await assert.rejects(done, (err: Error) => {
      assert.match(err.message, /xdev-hive-0\.90\.0-mac-arm64\.zip/);
      assert.match(err.message, /3 times/);
      return true;
    });
    assert.equal(hub.attempts.length, 3);
    assert.ok(!hub.attempts.includes(path.basename(win)), "the release stops at the failing file");
    assert.deepEqual(waits, [1, 2]);
    assert.deepEqual(hub.notes, []);
  });

  it("names the file when the connection keeps dropping, where fetch alone only says it failed", async () => {
    const hub = await fakeHub({ plan: { [path.basename(mac)]: ["cut", "cut", "cut"] } });
    const { done } = run(hub.url, [mac]);
    await assert.rejects(done, /hub upload xdev-hive-0\.90\.0-mac-arm64\.zip: failed 3 times/);
    assert.equal(hub.attempts.length, 3);
  });

  it("does not send again when the hub refuses the file (4xx other than 409)", async () => {
    const hub = await fakeHub({ plan: { [path.basename(mac)]: [400] } });
    const { done, waits } = run(hub.url, [mac]);
    await assert.rejects(done, /hub upload xdev-hive-0\.90\.0-mac-arm64\.zip: HTTP 400/);
    assert.equal(hub.attempts.length, 1);
    assert.deepEqual(waits, []);
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
