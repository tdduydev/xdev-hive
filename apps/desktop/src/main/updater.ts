// App updates from the hub (roadmap 22i). The heartbeat reply may offer a newer build (the hub admin's rollout); this
// downloads it with the machine's token, checks its SHA-256, and swaps it in when the person restarts (or at quit, or
// once no run is going, as the rollout says). macOS: the .zip replaces the .app bundle; Windows: the NSIS installer
// runs silently; Linux: AppImage is replaced, deb opens the system installer for user authorization. Builds are not code-signed, so no OS updater framework is used.
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { compareVersions, HiveError, type InstallWhen, type UpdateOffer, type UpdateReport } from "@xdev-hive/core";
import { markStartHidden, START_HIDDEN } from "#desktop/main/applog.ts";
import { extractedInstallScript, extractLinuxUpdate, linuxLayout, linuxUpdateService, updateCommand, type UpdateCommand } from "#desktop/main/linux-update.ts";

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
  deb?: boolean;
  /** Opens the verified package in the system installer; an empty result means success. */
  openPackage?: (file: string) => Promise<string>;
  /** Extraction and systemd commands; tests confine execution to their temporary runtime. */
  command?: UpdateCommand;
  /** An injected transport keeps updater tests independent of localhost listeners. */
  fetch?: typeof fetch;
  /** Tests inject cgroup contents; production reads /proc/self/cgroup only on Linux. */
  cgroup?: string;
  logFile?: string;
  /** Something changed (progress, ready, failed): the window and tray may want to know. */
  onChange?: (status: UpdateStatus) => void;
  /** Starts the install helper (default: node's spawn). Tests pass their own, so no helper ever swaps a real app. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
  /** Each step (offer, download, install) for main.log: an update that went wrong is otherwise invisible. */
  log?: (line: string) => void;
}

/** The hub's name for this platform. */
export const platformKey = (p: NodeJS.Platform): "mac" | "win" | "linux" | null => (p === "darwin" ? "mac" : p === "win32" ? "win" : p === "linux" ? "linux" : null);

/** dpkg owns the executable only for a system-installed Debian package. */
export function isDebInstall(execPath: string): boolean {
  try {
    return execFileSync("dpkg-query", ["-S", execPath], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).split("\n").some((line) => /^xdev-hive(?::(?:amd64|arm64))?: /.test(line));
  } catch { return false; }
}

export class Updater {
  readonly #host: UpdaterHost;
  #offer: UpdateOffer | null = null;
  #state: UpdateReport = { state: "idle", version: null, percent: null, error: null };
  #file: string | null = null;
  #downloading: Promise<void> | null = null;

  constructor(host: UpdaterHost) {
    this.#host = host;
    const error = path.join(host.dataDir, "updates", "install-error");
    if (existsSync(error)) {
      this.#state = { state: "failed", version: null, percent: null, error: readFileSync(error, "utf8").slice(0, 300) };
      this.#log(`previous helper failed: ${this.#state.error}`);
      rmSync(error, { force: true });
    }
  }

  get #supported(): boolean {
    return this.#host.packaged && platformKey(this.#host.platform) !== null && (this.#host.platform !== "linux" || Boolean(this.#host.deb) || Boolean(this.#host.appImage) || linuxLayout(this.#host.execPath) !== null);
  }

  get updateKind(): "deb" | undefined {
    return this.#host.platform === "linux" && this.#host.deb ? "deb" : undefined;
  }

  status(): UpdateStatus {
    return { ...this.#state, installWhen: this.#offer?.installWhen ?? null, notes: this.#offer?.notes ?? null, supported: this.#supported };
  }

  /** What the next heartbeat tells the hub. */
  report(): UpdateReport {
    return { ...this.#state };
  }

  #log(line: string): void {
    this.#host.log?.(`updater: ${line}`);
  }

  #set(next: Partial<UpdateReport>): void {
    this.#state = { ...this.#state, ...next };
    this.#host.onChange?.(this.status());
  }

  /** The heartbeat's offer (null: none). Starts the download when the rollout says to. */
  offer(offer: UpdateOffer | null | undefined): void {
    if (this.#state.state === "installing") return;
    if (!offer || compareVersions(offer.version, this.#host.version) <= 0) {
      this.#offer = null;
      if (this.#state.state !== "idle") this.#set({ state: "idle", version: null, percent: null, error: null });
      return;
    }
    if (this.#host.platform === "linux" && offer.file.kind !== (this.updateKind ?? "AppImage")) {
      this.#offer = null;
      this.#file = null;
      this.#set({ state: "failed", version: offer.version, error: "Update package does not match this Linux installation." });
      return;
    }
    const changed = this.#offer?.version !== offer.version || this.#offer?.file.sha256 !== offer.file.sha256;
    // Every heartbeat repeats the offer: only a new one (or a changed rollout) is worth a line.
    if (changed || this.#offer?.installWhen !== offer.installWhen || this.#offer?.autoDownload !== offer.autoDownload) {
      this.#log(`offer ${offer.version} (installWhen ${offer.installWhen}, autoDownload ${offer.autoDownload}${this.#supported ? "" : ", this app cannot update itself"})`);
    }
    this.#offer = offer;
    if (!this.#supported) {
      if (this.#host.packaged && this.#host.platform === "linux") this.#set({ state: "failed", version: offer.version, error: "Linux auto-update requires an AppImage or app-<version> selected by a current symlink with AppRun." });
      return;
    }
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
        this.#log(`download ${offer.version} ${offer.file.name}`);
        this.#set({ state: "downloading", version: offer.version, percent: 0, error: null });
        const res = await (this.#host.fetch ?? fetch)(`${hub.url.replace(/\/+$/, "")}${offer.url}`, { headers: { authorization: `Bearer ${hub.token}` } });
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
        if (this.#offer?.version !== offer.version || this.#offer?.file.sha256 !== offer.file.sha256) {
          this.#log(`discard withdrawn/replaced download ${offer.version}`);
          rmSync(target, { force: true });
          this.#set({ state: "idle", version: this.#offer?.version ?? null, percent: null, error: null });
          return;
        }
        this.#file = target;
        this.#set({ state: "ready", percent: 100, error: null });
        this.#log(`ready ${offer.version} (SHA-256 checked)`);
      } catch (err) {
        rmSync(part, { force: true });
        if (this.#offer?.version !== offer.version || this.#offer?.file.sha256 !== offer.file.sha256) {
          this.#log(`discard failure of withdrawn/replaced download ${offer.version}`);
          this.#set({ state: "idle", version: this.#offer?.version ?? null, percent: null, error: null });
          return;
        }
        this.#set({ state: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
        this.#log(`download failed: ${this.#state.error}`);
      } finally {
        this.#downloading = null;
        if (this.#offer?.autoDownload && this.#state.state === "idle") queueMicrotask(() => void this.download());
      }
    })();
    return this.#downloading;
  }

  async #startHelper(command: string, args: string[], options: SpawnOptions): Promise<void> {
    const child = (this.#host.spawn ?? spawn)(command, args, options);
    // A failed spawn is reported before quitting; otherwise the runner could stop with no installer alive.
    if (!this.#host.spawn) await new Promise<void>((resolve, reject) => {
      (child as ChildProcess).once("spawn", resolve).once("error", reject);
    });
    child.unref();
  }

  /** Ready, and the rollout wants it installed without asking at this moment. */
  installsOn(when: "quit" | "idle"): boolean {
    return this.updateKind !== "deb" && this.#state.state === "ready" && this.#offer?.installWhen === when;
  }

  /**
   * Prepares the swap and starts the helper that performs it once this process has exited. The caller quits the app
   * right after. relaunch: the helper starts the new build (a restart always; an install at quit when
   * relaunchAfterQuitInstall says so). hidden: that start stays in the tray, through the start-hidden marker.
   */
  async install({ relaunch, hidden = false, beforeHelper }: { relaunch: boolean; hidden?: boolean; beforeHelper?: () => void }): Promise<void> {
    const file = this.#file;
    if (this.#state.state !== "ready" || !file || !existsSync(file)) {
      this.#log(`install skipped: nothing ready (state ${this.#state.state})`);
      throw new HiveError("conflict", "No update is ready to install.", { key: "errors.updateNotReady" });
    }
    if (this.updateKind === "deb") {
      // apt/dpkg must own system files; the desktop never replaces them as the current user.
      try {
        if (!this.#host.openPackage) throw new Error("System package installer is unavailable.");
        const error = await this.#host.openPackage(file);
        if (error) throw new Error(error);
        this.#log(`opened Debian installer for ${file}; awaiting user authorization`);
        return;
      } catch (err) {
        this.#set({ state: "failed", error: String(err).slice(0, 300) });
        throw err;
      }
    }
    this.#log(`install ${this.#state.version} (relaunch ${relaunch}${relaunch && hidden ? ", hidden" : ""})`);
    this.#set({ state: "installing" });
    try {
      const dir = path.dirname(file);
      const pid = String(process.pid);
      rmSync(path.join(dir, "install-error"), { force: true });
      if (relaunch && hidden) markStartHidden(dir);
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
        beforeHelper?.();
        await this.#startHelper("/bin/sh", [script], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PID: pid, APP: app, NEW: path.join(stage, bundle), RELAUNCH: relaunch ? "1" : "0" } });
      } else if (this.#host.platform === "win32") {
        // The NSIS installer updates in place; --force-run starts the app when it is done.
        beforeHelper?.();
        await this.#startHelper(file, relaunch ? ["/S", "--force-run"] : ["/S"], { detached: true, stdio: "ignore" });
      } else if (linuxLayout(this.#host.execPath)) {
        const layout = linuxLayout(this.#host.execPath)!;
        const command = this.#host.command ?? updateCommand;
        const service = await linuxUpdateService(command, this.#host.cgroup, layout);
        const target = await extractLinuxUpdate(layout, file, this.#state.version!, command);
        const script = path.join(dir, "install.sh");
        writeFileSync(script, extractedInstallScript);
        const env = {
          PATH: "/usr/local/bin:/usr/bin:/bin", PID: pid, NEW: target, OLD: layout.app, CURRENT: layout.current,
          RELAUNCH: relaunch ? "1" : "0", UNIT: service?.unit ?? "", USER_MANAGER: service?.user ? "1" : "0",
          LOG: this.#host.logFile ?? path.join(dir, "install.log"), ERROR: path.join(dir, "install-error"),
        };
        try {
          beforeHelper?.();
          if (service) {
            this.#log(`install via systemd ${service.user ? "user" : "system"} service ${service.unit}`);
            await command("systemd-run", [
              ...(service.user ? ["--user"] : []), "--collect", `--unit=xdev-hive-update-${pid}`,
              ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), "/bin/sh", script,
            ], { timeout: 10_000 });
          } else {
            await this.#startHelper("/bin/sh", [script], { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
          }
        } catch (err) {
          // A timed-out systemd-run may already have scheduled the helper; retain its prepared directory.
          this.#log(`prepared Linux build retained at ${target}`);
          throw err;
        }
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
        beforeHelper?.();
        await this.#startHelper("/bin/sh", [script], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", PID: pid, IMAGE: image, NEW: file, RELAUNCH: relaunch ? "1" : "0" } });
      }
      this.#log("install helper started: it swaps the build once this process has exited");
    } catch (err) {
      // Nothing will start the new build, so the marker must not hide the window of the next start by hand.
      rmSync(path.join(path.dirname(file), START_HIDDEN), { force: true });
      this.#set({ state: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      this.#log(`install failed: ${this.#state.error}`);
      throw new HiveError("bad_request", `Could not install the update: ${this.#state.error}`, { key: "errors.updateInstall", vars: { reason: this.#state.error ?? "" } });
    }
  }
}
