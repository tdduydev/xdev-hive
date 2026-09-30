import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { UpdateOffer } from "@xdev-hive/core";
import { platformKey, Updater, type UpdateStatus } from "../src/main/updater.ts";

const bytes = Buffer.from("the 0.80.0 build");
const sha = createHash("sha256").update(bytes).digest("hex");
let hub = "";
let close: () => void;
const seenTokens: string[] = [];

before(async () => {
  const server = createServer((req, res) => {
    seenTokens.push(String(req.headers.authorization ?? ""));
    if (req.url !== "/api/releases/files/7") return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": String(bytes.length) }).end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const offer = (over: Partial<UpdateOffer["file"]> = {}): UpdateOffer => ({
  version: "0.80.0",
  file: { id: 7, version: "0.80.0", platform: "mac", arch: "arm64", kind: "zip", name: "xdev-hive-0.80.0-mac-arm64.zip", size: bytes.length, sha256: sha, ...over },
  url: "/api/releases/files/7",
  autoDownload: false,
  installWhen: "ask",
  notes: "- tự cập nhật",
});

function updater(packaged = true) {
  const changes: UpdateStatus[] = [];
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hive-update-"));
  const u = new Updater({ version: "0.75.0", dataDir, hub: () => ({ url: hub, token: "machine-token" }), packaged, platform: "darwin", execPath: "/Applications/xDev Hive.app/Contents/MacOS/xDev Hive", onChange: (s) => changes.push(s) });
  return { u, dataDir, changes };
}

describe("app updater", () => {
  it("names the platform the way the hub does", () => {
    assert.equal(platformKey("darwin"), "mac");
    assert.equal(platformKey("win32"), "win");
    assert.equal(platformKey("linux"), "linux");
    assert.equal(platformKey("aix"), null);
  });

  it("downloads the offered build with the machine's token, checks its SHA-256 and is then ready", async () => {
    const { u, dataDir, changes } = updater();
    u.offer(offer());
    assert.equal(u.status().state, "idle", "no download until asked (autoDownload off)");
    await u.download();
    const s = u.status();
    assert.equal(s.state, "ready");
    assert.equal(s.version, "0.80.0");
    assert.equal(s.notes, "- tự cập nhật");
    assert.equal(readFileSync(path.join(dataDir, "updates", "xdev-hive-0.80.0-mac-arm64.zip")).toString(), bytes.toString());
    assert.equal(seenTokens.at(-1), "Bearer machine-token");
    assert.ok(changes.some((c) => c.state === "downloading"), "reports progress on the way");
    assert.deepEqual(u.report(), { state: "ready", version: "0.80.0", percent: 100, error: null });
    assert.ok(u.installsOn("quit") === false && u.installsOn("idle") === false, "installWhen ask: only the person restarts");
  });

  it("drops a build whose SHA-256 does not match", async () => {
    const { u, dataDir } = updater();
    u.offer(offer({ sha256: "0".repeat(64) }));
    await u.download();
    assert.equal(u.status().state, "failed");
    assert.match(u.status().error ?? "", /SHA-256/);
    assert.equal(existsSync(path.join(dataDir, "updates", "xdev-hive-0.80.0-mac-arm64.zip")), false);
  });

  it("ignores offers of the version it runs (or older), and every offer in a dev build", async () => {
    const { u } = updater();
    u.offer({ ...offer(), version: "0.75.0" });
    assert.equal(u.status().state, "idle");
    assert.equal(u.status().version, null);
    const dev = updater(false);
    dev.u.offer({ ...offer(), autoDownload: true });
    await dev.u.download();
    assert.equal(dev.u.status().supported, false);
    assert.notEqual(dev.u.status().state, "ready", "a dev build never replaces the app it runs from");
  });
});
