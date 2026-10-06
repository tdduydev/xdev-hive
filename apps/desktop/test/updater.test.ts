import assert from "node:assert/strict";
import { execFile, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { HiveError, type UpdateOffer } from "@xdev-hive/core";
import { platformKey, Updater, type UpdaterHost, type UpdateStatus } from "#desktop/main/updater.ts";

const run = promisify(execFile);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = Buffer.from("the 0.80.0 build");
const sha = sha256(bytes);
let hub = "";
let close: () => void;
const seenTokens: string[] = [];
/** What the fake hub serves, by URL: tests add builds of their own (a real .zip for the macOS install). */
const files = new Map<string, Buffer>([["/api/releases/files/7", bytes]]);

before(async () => {
  const server = createServer((req, res) => {
    seenTokens.push(String(req.headers.authorization ?? ""));
    const body = files.get(req.url ?? "");
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": String(body.length) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const offer = (over: Partial<UpdateOffer["file"]> = {}, url = "/api/releases/files/7"): UpdateOffer => ({
  version: "0.80.0",
  file: { id: 7, version: "0.80.0", platform: "mac", arch: "arm64", kind: "zip", name: "xdev-hive-0.80.0-mac-arm64.zip", size: bytes.length, sha256: sha, ...over },
  url,
  autoDownload: false,
  installWhen: "ask",
  notes: "- tự cập nhật",
});

/** Serves `body` as a new build and offers it. */
let nextId = 100;
function served(body: Buffer, name: string): UpdateOffer {
  const url = `/api/releases/files/${nextId++}`;
  files.set(url, body);
  return offer({ name, size: body.length, sha256: sha256(body) }, url);
}

interface Spawned {
  command: string;
  args: string[];
  options: SpawnOptions;
  unrefs: number;
}

function updater(packaged = true, over: Partial<UpdaterHost> = {}) {
  const changes: UpdateStatus[] = [];
  const spawned: Spawned[] = [];
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hive-update-"));
  const host: UpdaterHost = {
    version: "0.75.0",
    dataDir,
    hub: () => ({ url: hub, token: "machine-token" }),
    packaged,
    platform: "darwin",
    execPath: "/Applications/xDev Hive.app/Contents/MacOS/xDev Hive",
    onChange: (s) => changes.push(s),
    // Never the real spawn: an install helper must not touch an app on this machine.
    spawn: (command, args, options) => {
      const s: Spawned = { command, args, options, unrefs: 0 };
      spawned.push(s);
      return { unref: () => void s.unrefs++ };
    },
    ...over,
  };
  const u = new Updater(host);
  return { u, host, dataDir, changes, spawned };
}

/** Waits for the download an offer started by itself (autoDownload). */
async function settled(u: Updater): Promise<void> {
  for (let i = 0; i < 200 && (u.status().state === "idle" || u.status().state === "downloading"); i++) await new Promise((r) => setTimeout(r, 10));
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
    assert.equal(existsSync(path.join(dataDir, "updates", "xdev-hive-0.80.0-mac-arm64.zip.part")), false, "the partial file goes too");
  });

  it("fails a download the hub refuses, and leaves no partial file", async () => {
    const { u, dataDir } = updater();
    u.offer(offer({}, "/api/releases/files/404"));
    await u.download();
    assert.equal(u.status().state, "failed");
    assert.equal(u.status().error, "HTTP 404");
    assert.equal(existsSync(path.join(dataDir, "updates", "xdev-hive-0.80.0-mac-arm64.zip.part")), false);
  });

  it("downloads by itself when the rollout says so, and tries again when a failed offer is replaced", async () => {
    const { u } = updater();
    u.offer({ ...offer({ sha256: "0".repeat(64) }), autoDownload: true });
    await settled(u);
    assert.equal(u.status().state, "failed");
    u.offer({ ...offer(), autoDownload: true });
    await settled(u);
    assert.equal(u.status().state, "ready", "a new build (other SHA-256) is downloaded again");
    u.offer(null);
    assert.equal(u.status().state, "idle", "the offer withdrawn: nothing to install");
    assert.equal(u.status().version, null);
  });

  it("installs at quit (or once idle) only when the rollout says so", async () => {
    const { u } = updater();
    u.offer({ ...offer(), installWhen: "quit" });
    assert.equal(u.installsOn("quit"), false, "not before the build is ready");
    await u.download();
    assert.equal(u.installsOn("quit"), true);
    assert.equal(u.installsOn("idle"), false);
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

describe("app updater: install", () => {
  it("refuses to install before a build is ready", async () => {
    const { u, spawned } = updater();
    await assert.rejects(
      () => u.install({ relaunch: true }),
      (err: unknown) => err instanceof HiveError && err.code === "conflict" && err.key === "errors.updateNotReady",
    );
    u.offer(offer());
    await assert.rejects(() => u.install({ relaunch: true }), (err: unknown) => err instanceof HiveError && err.key === "errors.updateNotReady", "offered is not downloaded");
    assert.equal(spawned.length, 0);
    assert.equal(u.status().state, "idle", "a refused install changes nothing");
  });

  it("fails on macOS when the app does not run from an .app bundle", async () => {
    const { u, spawned } = updater(true, { execPath: "/usr/local/bin/xdev-hive" });
    u.offer(offer());
    await u.download();
    await assert.rejects(
      () => u.install({ relaunch: true }),
      (err: unknown) =>
        err instanceof HiveError && err.code === "bad_request" && err.key === "errors.updateInstall" && /Not inside an \.app bundle/.test(String(err.vars?.reason)),
    );
    assert.equal(u.status().state, "failed");
    assert.match(u.status().error ?? "", /Not inside an \.app bundle/);
    assert.equal(spawned.length, 0);
  });

  it("runs the NSIS installer silently on Windows, starting the app again only on a restart", async () => {
    for (const relaunch of [true, false]) {
      const { u, spawned } = updater(true, { platform: "win32" });
      u.offer(served(Buffer.from(`setup ${relaunch}`), "xdev-hive-0.80.0-win-x64.exe"));
      await u.download();
      await u.install({ relaunch });
      assert.equal(u.status().state, "installing");
      assert.equal(spawned.length, 1);
      assert.match(spawned[0]!.command, /xdev-hive-0\.80\.0-win-x64\.exe$/);
      assert.deepEqual(spawned[0]!.args, relaunch ? ["/S", "--force-run"] : ["/S"]);
      assert.equal(spawned[0]!.options.detached, true);
      assert.equal(spawned[0]!.unrefs, 1, "the app may quit without waiting for the installer");
    }
  });

  it("logs each step and leaves the start-hidden marker only for a hidden relaunch (BUG-update-relaunch)", async () => {
    for (const [relaunch, hidden, marker] of [
      [true, true, true],
      [false, true, false],
      [true, false, false],
    ] as const) {
      const lines: string[] = [];
      const { u, dataDir } = updater(true, { platform: "win32", log: (l) => lines.push(l) });
      const o = served(Buffer.from(`setup hidden ${relaunch} ${hidden}`), "xdev-hive-0.80.0-win-x64.exe");
      u.offer({ ...o, installWhen: "quit" });
      u.offer({ ...o, installWhen: "quit" });
      await u.download();
      await u.install({ relaunch, hidden });
      assert.equal(existsSync(path.join(dataDir, "updates", "start-hidden")), marker, `relaunch ${relaunch}, hidden ${hidden}`);
      assert.deepEqual(lines, [
        "updater: offer 0.80.0 (installWhen quit, autoDownload false)",
        "updater: download 0.80.0 xdev-hive-0.80.0-win-x64.exe",
        "updater: ready 0.80.0 (SHA-256 checked)",
        `updater: install 0.80.0 (relaunch ${relaunch}${marker ? ", hidden" : ""})`,
        "updater: install helper started: it swaps the build once this process has exited",
      ], "a repeated offer (every heartbeat) is not logged again");
    }
  });

  it("removes the start-hidden marker and logs it when the install fails", async () => {
    const lines: string[] = [];
    const { u, dataDir } = updater(true, { platform: "linux", appImage: "/nonexistent-dir/xDev-Hive.AppImage", log: (l) => lines.push(l) });
    u.offer(served(Buffer.from("appimage hidden"), "xdev-hive-0.80.0-linux-x64.AppImage"));
    await u.download();
    await assert.rejects(() => u.install({ relaunch: true, hidden: true }));
    assert.equal(existsSync(path.join(dataDir, "updates", "start-hidden")), false);
    assert.match(lines.at(-1) ?? "", /^updater: install failed: /);
  });

  it("fails on Linux when the app no longer runs from an AppImage", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-appimage-"));
    const { u, host, spawned } = updater(true, { platform: "linux", appImage: path.join(dir, "xDev-Hive.AppImage") });
    u.offer(served(Buffer.from("appimage a"), "xdev-hive-0.80.0-linux-x64.AppImage"));
    await u.download();
    assert.equal(u.status().state, "ready");
    // APPIMAGE gone after the download (an app started some other way): nothing to replace.
    delete host.appImage;
    await assert.rejects(() => u.install({ relaunch: false }), (err: unknown) => err instanceof HiveError && err.key === "errors.updateInstall");
    assert.equal(u.status().state, "failed");
    assert.equal(u.status().error, "Not running from an AppImage.");
    assert.equal(spawned.length, 0);
  });

  it("writes the Linux helper that swaps the AppImage once the app has quit", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-appimage-"));
    const image = path.join(dir, "xDev-Hive.AppImage");
    writeFileSync(image, "old build");
    const { u, dataDir, spawned } = updater(true, { platform: "linux", appImage: image });
    u.offer(served(Buffer.from("appimage b"), "xdev-hive-0.80.0-linux-x64.AppImage"));
    await u.download();
    await u.install({ relaunch: true });
    const script = path.join(dataDir, "updates", "install.sh");
    assert.equal(
      readFileSync(script, "utf8"),
      [
        "#!/bin/sh",
        'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
        'cp "$NEW" "$IMAGE.new" && chmod +x "$IMAGE.new" && mv "$IMAGE.new" "$IMAGE"',
        '[ "$RELAUNCH" = 1 ] && nohup "$IMAGE" >/dev/null 2>&1 &',
        "",
      ].join("\n"),
    );
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.command, "/bin/sh");
    assert.deepEqual(spawned[0]!.args, [script]);
    assert.deepEqual(spawned[0]!.options.env, {
      PATH: "/usr/bin:/bin",
      PID: String(process.pid),
      IMAGE: image,
      NEW: path.join(dataDir, "updates", "xdev-hive-0.80.0-linux-x64.AppImage"),
      RELAUNCH: "1",
    });
    assert.equal(spawned[0]!.unrefs, 1);
    assert.equal(readFileSync(image, "utf8"), "old build", "the helper (not run here) swaps it, not the app itself");
  });

  // ditto only exists on macOS: these run the real unzip, but the helper script itself is never started.
  const mac = { skip: process.platform !== "darwin" ? "needs /usr/bin/ditto" : false };

  it("unpacks the macOS .zip and writes the helper that swaps the .app bundle", mac, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-mac-"));
    const build = path.join(root, "build", "xDev Hive.app");
    mkdirSync(path.join(build, "Contents"), { recursive: true });
    writeFileSync(path.join(build, "Contents", "Info.plist"), "<plist/>");
    const zip = path.join(root, "update.zip");
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", build, zip]);
    const installed = path.join(root, "Applications", "xDev Hive.app");
    mkdirSync(path.join(installed, "Contents", "MacOS"), { recursive: true });

    const { u, dataDir, spawned } = updater(true, { execPath: path.join(installed, "Contents", "MacOS", "xDev Hive") });
    u.offer(served(readFileSync(zip), "xdev-hive-0.80.0-mac-arm64.zip"));
    await u.download();
    await u.install({ relaunch: false });
    const stage = path.join(dataDir, "updates", "stage");
    assert.ok(existsSync(path.join(stage, "xDev Hive.app", "Contents", "Info.plist")), "the new bundle is unpacked beside the download");
    const script = path.join(dataDir, "updates", "install.sh");
    assert.match(readFileSync(script, "utf8"), /mv "\$APP" "\$APP\.old" && mv "\$NEW" "\$APP"/);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.args, [script]);
    assert.deepEqual(spawned[0]!.options.env, {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PID: String(process.pid),
      APP: installed,
      NEW: path.join(stage, "xDev Hive.app"),
      RELAUNCH: "0",
    });
    assert.ok(existsSync(path.join(installed, "Contents", "MacOS")), "the running app is left alone");
  });

  it("fails a macOS update whose .zip holds no .app", mac, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-mac-"));
    mkdirSync(path.join(root, "payload"));
    writeFileSync(path.join(root, "payload", "README"), "not an app");
    const zip = path.join(root, "update.zip");
    await run("/usr/bin/ditto", ["-c", "-k", path.join(root, "payload"), zip]);
    const installed = path.join(root, "Applications", "xDev Hive.app");
    mkdirSync(path.join(installed, "Contents", "MacOS"), { recursive: true });

    const { u, spawned } = updater(true, { execPath: path.join(installed, "Contents", "MacOS", "xDev Hive") });
    u.offer(served(readFileSync(zip), "xdev-hive-0.80.0-mac-arm64.zip"));
    await u.download();
    await assert.rejects(() => u.install({ relaunch: true }), (err: unknown) => err instanceof HiveError && err.key === "errors.updateInstall");
    assert.equal(u.status().error, "The update has no .app inside.");
    assert.equal(spawned.length, 0);
  });
});
