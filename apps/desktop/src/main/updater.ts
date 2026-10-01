// App updates from the hub (roadmap 22i). The heartbeat reply may offer a newer build (the hub admin's rollout); this
// downloads it with the machine's token, checks its SHA-256, and swaps it in when the person restarts (or at quit, or
// once no run is going, as the rollout says). macOS: the .zip replaces the .app bundle; Windows: the NSIS installer
// runs silently; Linux: the AppImage file is replaced. Builds are not code-signed, so no OS updater framework is used.
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { compareVersions, HiveError, type InstallWhen, type UpdateOffer, type UpdateReport } from "@xdev-hive/core";

const run = promisify(execFile);

export interface UpdateStatus extends UpdateReport {
  installWhen: InstallWhen | null;
  notes: string | null;
  /** The running app can replace itself (packaged, and the platform is supported). */
  supported: boolean;
}

export interface UpdaterHost {
  version: string;
  dataDir: string;
  /** The hub to download from, with this machine's token. */
  hub(): { url: string; token: string } | null;
  /** A packaged app: dev builds (electron-vite dev) never update themselves. */
  packaged: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  /** process.env.APPIMAGE on Linux. */
  appImage?: string;
  /** Something changed (progress, ready, failed): the window and tray may want to know. */
  onChange?: (status: UpdateStatus) => void;
  /** Starts the install helper (default: node's spawn). Tests pass their own, so no helper ever swaps a real app. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
}

/** The hub's name for this platform. */
export const platformKey = (p: NodeJS.Platform): "mac" | "win" | "linux" | null => (p === "darwin" ? "mac" : p === "win32" ? "win" : p === "linux" ? "linux" : null);

export class Updater {
  readonly #host: UpdaterHost;
  #offer: UpdateOffer | null = null;
  #state: UpdateReport = { state: "idle", version: null, percent: null, error: null };
  #file: string | null = null;
  #downloading: Promise<void> | null = null;

  constructor(host: UpdaterHost) {
    this.#host = host;
  }

  get #supported(): boolean {
    return this.#host.packaged && platformKey(this.#host.platform) !== null && (this.#host.platform !== "linux" || Boolean(this.#host.appImage));
  }

  status(): UpdateStatus {
    return { ...this.#state, installWhen: this.#offer?.installWhen ?? null, notes: this.#offer?.notes ?? null, supported: this.#supported };
  }

  /** What the next heartbeat tells the hub. */
  report(): UpdateReport {
    return { ...this.#state };
  }

  #set(next: Partial<UpdateReport>): void {
    this.#state = { ...this.#state, ...next };
    this.#host.onChange?.(this.status());
  }

  /** The heartbeat's offer (null: none). Starts the download when the rollout says to. */
  offer(offer: UpdateOffer | null | undefined): void {
    if (!offer || compareVersions(offer.version, this.#host.version) <= 0) {
      this.#offer = null;
      if (this.#state.state !== "idle") this.#set({ state: "idle", version: null, percent: null, error: null });
      return;
    }
    const changed = this.#offer?.version !== offer.version || this.#offer?.file.sha256 !== offer.file.sha256;
    this.#offer = offer;
    if (!this.#supported) return;
    if (changed && this.#state.state !== "downloading") {
      this.#file = null;
      this.#set({ state: "idle", version: offer.version, percent: null, error: null });
    }
    if (offer.autoDownload && (this.#state.state === "idle" || (changed && this.#state.state === "failed"))) void this.download();
  }

  /** Downloads the offered build and checks it. Resolves when done (or failed: see status). */
  download(): Promise<void> {
    if (this.#downloading) return this.#downloading;
    const offer = this.#offer;
    const hub = this.#host.hub();
    if (!offer || !hub || !this.#supported) return Promise.resolve();
    this.#downloading = (async () => {
      const dir = path.join(this.#host.dataDir, "updates");
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(offer.file.name));
      const part = `${target}.part`;
      try {
        this.#set({ state: "downloading", version: offer.version, percent: 0, error: null });
        const res = await fetch(`${hub.url.replace(/\/+$/, "")}${offer.url}`, { headers: { authorization: `Bearer ${hub.token}` } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get("content-length")) || offer.file.size;
        const hash = createHash("sha256");
        let got = 0;
        let shown = -1;
        const tap = new Transform({
          transform: (chunk: Buffer, _enc, done) => {
            hash.update(chunk);
            got += chunk.length;
            const pct = total ? Math.floor((got / total) * 100) : null;
            if (pct !== null && pct !== shown) {
              shown = pct;
              this.#set({ percent: pct });
            }
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(part));
        const sum = hash.digest("hex");
        if (sum !== offer.file.sha256) throw new Error(`SHA-256 ${sum.slice(0, 12)}… ≠ ${offer.file.sha256.slice(0, 12)}…`);
        renameSync(part, target);
        // Older downloads are of no use once this one is here.
        for (const f of readdirSync(dir)) if (f !== path.basename(target) && !f.startsWith("stage")) rmSync(path.join(dir, f), { recursive: true, force: true });
        this.#file = target;
        this.#set({ state: "ready", percent: 100, error: null });
      } catch (err) {
        rmSync(part, { force: true });
        this.#set({ state: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      } finally {
        this.#downloading = null;
      }
    })();
    return this.#downloading;
  }

  /** Ready, and the rollout wants it installed without asking at this moment. */
  installsOn(when: "quit" | "idle"): boolean {
    return this.#state.state === "ready" && this.#offer?.installWhen === when;
  }

  /**
   * Prepares the swap and starts the helper that performs it once this process has exited. The caller quits the app
   * right after (a restart relaunches it; an install at quit does not).
   */
  async install({ relaunch }: { relaunch: boolean }): Promise<void> {
    const file = this.#file;
    if (this.#state.state !== "ready" || !file || !existsSync(file)) throw new HiveError("conflict", "No update is ready to install.", { key: "errors.updateNotReady" });
    this.#set({ state: "installing" });
    const start = this.#host.spawn ?? spawn;
    try {
      const dir = path.dirname(file);
      const pid = String(process.pid);
      if (this.#host.platform === "darwin") {
        // …/xDev Hive.app/Contents/MacOS/xDev Hive → …/xDev Hive.app
        const app = path.resolve(this.#host.execPath, "..", "..", "..");
        if (!app.endsWith(".app")) throw new Error(`Not inside an .app bundle: ${app}`);
        accessSync(path.dirname(app), constants.W_OK);
        const stage = path.join(dir, "stage");
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage);
        await run("/usr/bin/ditto", ["-x", "-k", file, stage]);
        const bundle = readdirSync(stage).find((f) => f.endsWith(".app"));
        if (!bundle) throw new Error("The update has no .app inside.");
        const script = path.join(dir, "install.sh");
        writeFileSync(
          script,
          [
            "#!/bin/sh",
            'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
            'rm -rf "$APP.old"',
            'if mv "$APP" "$APP.old" && mv "$NEW" "$APP"; then rm -rf "$APP.old"; else [ -d "$APP.old" ] && mv "$APP.old" "$APP"; fi',
            'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
            '[ "$RELAUNCH" = 1 ] && open "$APP"',
            "",
          ].join("\n"),
        );
        start("/bin/sh", [script], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PID: pid, APP: app, NEW: path.join(stage, bundle), RELAUNCH: relaunch ? "1" : "0" } }).unref();
      } else if (this.#host.platform === "win32") {
        // The NSIS installer updates in place; --force-run starts the app when it is done.
        start(file, relaunch ? ["/S", "--force-run"] : ["/S"], { detached: true, stdio: "ignore" }).unref();
      } else {
        const image = this.#host.appImage;
        if (!image) throw new Error("Not running from an AppImage.");
        accessSync(path.dirname(image), constants.W_OK);
        const script = path.join(dir, "install.sh");
        writeFileSync(
          script,
          [
            "#!/bin/sh",
            'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
            'cp "$NEW" "$IMAGE.new" && chmod +x "$IMAGE.new" && mv "$IMAGE.new" "$IMAGE"',
            '[ "$RELAUNCH" = 1 ] && nohup "$IMAGE" >/dev/null 2>&1 &',
            "",
          ].join("\n"),
        );
        start("/bin/sh", [script], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", PID: pid, IMAGE: image, NEW: file, RELAUNCH: relaunch ? "1" : "0" } }).unref();
      }
    } catch (err) {
      this.#set({ state: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      throw new HiveError("bad_request", `Could not install the update: ${this.#state.error}`, { key: "errors.updateInstall", vars: { reason: this.#state.error ?? "" } });
    }
  }
}
