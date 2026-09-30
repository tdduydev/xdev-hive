// Desktop app updates (roadmap 22i). The release script uploads each build here; hub admins pick the version machines
// should run (the rollout); a machine hears its offer in the heartbeat reply, downloads the build with its token and
// reports how the update goes. Builds are files in the hub's data folder, not rows: they are large.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  compareVersions,
  HiveError,
  INSTALL_WHEN,
  RELEASE_CHANNELS,
  UPDATE_STATES,
  type AppRelease,
  type AppReleaseFile,
  type AppRollout,
  type InstallWhen,
  type MachineUpdate,
  type ReleaseArch,
  type ReleaseChannel,
  type ReleaseKind,
  type ReleasePlatform,
  type UpdateOffer,
  type UpdateReport,
} from "@xdev-hive/core";

type Row = Record<string, unknown>;

const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const PLATFORMS: ReleasePlatform[] = ["mac", "win", "linux"];
const ARCHES: ReleaseArch[] = ["arm64", "x64"];
const KINDS: ReleaseKind[] = ["zip", "dmg", "exe", "AppImage"];
/** What a machine installs from, per platform (the dmg is for people). */
const UPDATE_KIND: Record<ReleasePlatform, ReleaseKind> = { mac: "zip", win: "exe", linux: "AppImage" };
/** Releases whose builds are kept on disk; older ones keep their row, not their files. */
const KEEP_FILES = 5;

const toFile = (r: Row): AppReleaseFile => ({
  id: Number(r.id),
  version: String(r.version),
  platform: String(r.platform) as ReleasePlatform,
  arch: String(r.arch) as ReleaseArch,
  kind: String(r.kind) as ReleaseKind,
  name: String(r.name),
  size: Number(r.size),
  sha256: String(r.sha256),
});

/** A stable 0–99 bucket for a machine, so a rollout of 25% always picks the same quarter. */
export function bucket(machineId: string): number {
  return createHash("sha256").update(machineId).digest().readUInt32BE(0) % 100;
}

export class ReleaseStore {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, dir: string, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#dir = dir;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS app_releases(version TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'stable', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_release_files(id INTEGER PRIMARY KEY, version TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(version, name));
      CREATE TABLE IF NOT EXISTS app_rollout(id INTEGER PRIMARY KEY CHECK (id = 1), target TEXT, percent INTEGER NOT NULL DEFAULT 100, paused INTEGER NOT NULL DEFAULT 0,
        auto_download INTEGER NOT NULL DEFAULT 1, install_when TEXT NOT NULL DEFAULT 'ask', min_version TEXT, updated_by TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS app_machine_updates(machine_id TEXT PRIMARY KEY, machine TEXT NOT NULL, current TEXT NOT NULL, state TEXT NOT NULL, version TEXT,
        percent INTEGER, error TEXT, updated_at TEXT NOT NULL);`);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  list(): AppRelease[] {
    const files = (this.#db.prepare("SELECT * FROM app_release_files ORDER BY platform, arch, kind").all() as Row[]).map(toFile);
    return (this.#db.prepare("SELECT * FROM app_releases").all() as Row[])
      .map((r) => ({
        version: String(r.version),
        channel: String(r.channel) as ReleaseChannel,
        notes: String(r.notes),
        createdAt: String(r.created_at),
        files: files.filter((f) => f.version === String(r.version) && existsSync(this.#path(f))),
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  #path(f: Pick<AppReleaseFile, "version" | "name">): string {
    return path.join(this.#dir, f.version, f.name);
  }

  /** Stores one build (streamed to `tmpFile` and hashed by the caller) and its release row. */
  add(input: { version: string; channel: string; platform: string; arch: string; kind: string; name: string; tmpFile: string; sha256: string }): AppReleaseFile {
    const { version, platform, arch, kind } = input;
    const channel = (RELEASE_CHANNELS as readonly string[]).includes(input.channel) ? (input.channel as ReleaseChannel) : "stable";
    const name = path.basename(input.name);
    if (!VERSION.test(version)) throw new HiveError("bad_request", "Version must look like 1.2.3.", { key: "errors.releaseVersion" });
    if (!PLATFORMS.includes(platform as ReleasePlatform) || !ARCHES.includes(arch as ReleaseArch) || !KINDS.includes(kind as ReleaseKind) || !name || name.startsWith(".")) {
      throw new HiveError("bad_request", "Unknown build: platform mac|win|linux, arch arm64|x64, kind zip|dmg|exe|AppImage.", { key: "errors.releaseFile" });
    }
    const target = this.#path({ version, name });
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(input.tmpFile, target);
    const size = statSync(target).size;
    const at = this.#iso();
    this.#db.prepare("INSERT INTO app_releases(version, channel, created_at) VALUES (?, ?, ?) ON CONFLICT(version) DO UPDATE SET channel = excluded.channel").run(version, channel, at);
    this.#db
      .prepare(
        `INSERT INTO app_release_files(version, platform, arch, kind, name, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(version, name) DO UPDATE SET platform = excluded.platform, arch = excluded.arch, kind = excluded.kind, size = excluded.size, sha256 = excluded.sha256`,
      )
      .run(version, platform, arch, kind, name, size, input.sha256, at);
    this.#prune();
    return toFile(this.#db.prepare("SELECT * FROM app_release_files WHERE version = ? AND name = ?").get(version, name) as Row);
  }

  setNotes(version: string, notes: string): void {
    const r = this.#db.prepare("UPDATE app_releases SET notes = ? WHERE version = ?").run(notes.slice(0, 20_000), version);
    if (!r.changes) throw new HiveError("not_found", "No such release.", { key: "errors.releaseNotFound" });
  }

  /** Drops the builds of all but the newest releases (and never the target's). */
  #prune(): void {
    const target = this.rollout().target;
    const versions = this.list().map((r) => r.version);
    for (const v of versions.slice(KEEP_FILES)) {
      if (v === target) continue;
      rmSync(path.join(this.#dir, v), { recursive: true, force: true });
    }
  }

  file(id: number): (AppReleaseFile & { path: string }) | null {
    const row = this.#db.prepare("SELECT * FROM app_release_files WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const f = toFile(row);
    const p = this.#path(f);
    return existsSync(p) ? { ...f, path: p } : null;
  }

  stream(id: number) {
    const f = this.file(id);
    return f ? { file: f, body: createReadStream(f.path) } : null;
  }

  rollout(): AppRollout {
    const r = this.#db.prepare("SELECT * FROM app_rollout WHERE id = 1").get() as Row | undefined;
    return {
      target: r?.target == null ? null : String(r.target),
      percent: r ? Number(r.percent) : 100,
      paused: r ? Number(r.paused) === 1 : false,
      autoDownload: r ? Number(r.auto_download) === 1 : true,
      installWhen: (r ? String(r.install_when) : "ask") as InstallWhen,
      minVersion: r?.min_version == null ? null : String(r.min_version),
      updatedBy: r?.updated_by == null ? null : String(r.updated_by),
      updatedAt: r?.updated_at == null ? null : String(r.updated_at),
    };
  }

  setRollout(patch: Partial<Omit<AppRollout, "updatedBy" | "updatedAt">>, by: string): AppRollout {
    const cur = this.rollout();
    const next = { ...cur, ...patch };
    if (next.target !== null && !this.list().some((r) => r.version === next.target)) {
      throw new HiveError("bad_request", `No release ${next.target} on this hub.`, { key: "errors.releaseNotFound" });
    }
    if (next.minVersion !== null && !VERSION.test(next.minVersion)) throw new HiveError("bad_request", "Version must look like 1.2.3.", { key: "errors.releaseVersion" });
    if (!(INSTALL_WHEN as readonly string[]).includes(next.installWhen)) throw new HiveError("bad_request", "installWhen: ask | quit | idle.", { key: "errors.releaseFile" });
    const percent = Math.max(0, Math.min(100, Math.round(Number(next.percent) || 0)));
    this.#db
      .prepare(
        `INSERT INTO app_rollout(id, target, percent, paused, auto_download, install_when, min_version, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET target = excluded.target, percent = excluded.percent, paused = excluded.paused, auto_download = excluded.auto_download,
           install_when = excluded.install_when, min_version = excluded.min_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(next.target, percent, next.paused ? 1 : 0, next.autoDownload ? 1 : 0, next.installWhen, next.minVersion, by, this.#iso());
    return this.rollout();
  }

  /**
   * The update a machine should take, if any: the rollout's target when it runs something older, is in the rollout's
   * share, and a build for its platform exists.
   */
  offerFor(machineId: string, current: string, platform: string, arch: string): UpdateOffer | null {
    const r = this.rollout();
    if (!r.target || r.paused || !current || compareVersions(current, r.target) >= 0) return null;
    if (bucket(machineId) >= r.percent) return null;
    const plat = platform as ReleasePlatform;
    if (!PLATFORMS.includes(plat)) return null;
    const release = this.list().find((x) => x.version === r.target);
    const file = release?.files.find((f) => f.platform === plat && f.arch === arch && f.kind === UPDATE_KIND[plat]);
    if (!release || !file) return null;
    return { version: r.target, file, url: `/api/releases/files/${file.id}`, autoDownload: r.autoDownload, installWhen: r.installWhen, notes: release.notes };
  }

  report(machineId: string, machine: string, current: string, report: UpdateReport | null): void {
    const state = report && (UPDATE_STATES as readonly string[]).includes(report.state) ? report.state : "idle";
    this.#db
      .prepare(
        `INSERT INTO app_machine_updates(machine_id, machine, current, state, version, percent, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id) DO UPDATE SET machine = excluded.machine, current = excluded.current, state = excluded.state, version = excluded.version,
           percent = excluded.percent, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(
        machineId,
        machine.slice(0, 100),
        current.slice(0, 40),
        state,
        report?.version?.slice(0, 40) ?? null,
        typeof report?.percent === "number" ? Math.max(0, Math.min(100, Math.round(report.percent))) : null,
        report?.error?.slice(0, 500) ?? null,
        this.#iso(),
      );
  }

  machines(): MachineUpdate[] {
    return (this.#db.prepare("SELECT * FROM app_machine_updates ORDER BY machine").all() as Row[]).map((r) => ({
      machineId: String(r.machine_id),
      machine: String(r.machine),
      current: String(r.current),
      state: String(r.state) as MachineUpdate["state"],
      version: r.version == null ? null : String(r.version),
      percent: r.percent == null ? null : Number(r.percent),
      error: r.error == null ? null : String(r.error),
      updatedAt: String(r.updated_at),
    }));
  }

  /** For tests: where the builds go. */
  get dir(): string {
    return this.#dir;
  }

  /** A temporary file in the builds folder, for an upload to be streamed into before add(). */
  tmpFile(): string {
    mkdirSync(this.#dir, { recursive: true });
    return path.join(this.#dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  /** Writes bytes as a build (tests, small files). */
  addBytes(input: Omit<Parameters<ReleaseStore["add"]>[0], "tmpFile" | "sha256">, bytes: Uint8Array): AppReleaseFile {
    const tmp = this.tmpFile();
    writeFileSync(tmp, bytes);
    return this.add({ ...input, tmpFile: tmp, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}
