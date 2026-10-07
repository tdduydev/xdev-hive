import type { DeployLog } from "#web/deploy-log.ts";
// Trang Hub (docs/design/2026-09-redesign, xDev Hive Web Admin; roadmap 22n): what the hub is and how it is doing, for
// hub admins, and a backup made on request.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HiveError, type HubCleanup, type HubInfo } from "@xdev-hive/core";
import type { SqliteHive } from "@xdev-hive/core/node";
import { backupDatabase, backupFiles, type BackupResult, type FilesBackupResult } from "./backup.ts";
import type { UserStore } from "./users.ts";
import type { ReleaseStore } from "./releases.ts";

export interface HubInfoOptions {
  hive: SqliteHive;
  deployLog?: DeployLog;
  dbPath: string;
  users?: UserStore;
  backup?: { dir: string; hours: number; keep: number } | null;
  releases?: ReleaseStore;
  embedUrl?: string | null;
  sso?: { name: string; issuer: string } | null;
  allowedHosts?: string[] | null;
  publicUrl?: string | null;
  trustProxy?: boolean;
  /** The commit the deploy built (HIVE_COMMIT). */
  commit?: string | null;
  now?: () => Date;
}

/** The version the repo is at: the desktop app's, which every roadmap item bumps. */
function repoVersion(): string {
  try {
    const file = new URL("../../desktop/package.json", import.meta.url);
    return String((JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "?");
  } catch {
    return "?";
  }
}

const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);
const SNAPSHOT = /^hub-.*\.db$/;

export class HubInfoSource {
  readonly #o: HubInfoOptions & { now: () => Date };
  readonly #startedAt: Date;
  readonly #version = repoVersion();

  constructor(opts: HubInfoOptions) {
    this.#o = { now: () => new Date(), ...opts };
    this.#startedAt = this.#o.now();
  }

  async info(): Promise<HubInfo> {
    const o = this.#o;
    const count = (table: string) => Number((o.hive.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const search = await o.hive.call("memory.searchInfo", {}, { name: "hub", role: "admin" });
    let last: string | null = null;
    let snapshots = 0;
    if (o.backup && existsSync(o.backup.dir)) {
      for (const f of readdirSync(o.backup.dir)) {
        if (!SNAPSHOT.test(f)) continue;
        snapshots++;
        const at = statSync(path.join(o.backup.dir, f)).mtime.toISOString();
        if (!last || at > last) last = at;
      }
    }
    return {
      version: this.#version,
      commit: o.commit ?? null,
      node: process.version,
      container: existsSync("/.dockerenv"),
      startedAt: this.#startedAt.toISOString(),
      deployLog: o.deployLog?.info(),
      uptimeSeconds: Math.round((o.now().getTime() - this.#startedAt.getTime()) / 1000),
      db: {
        path: o.dbPath,
        bytes: size(o.dbPath),
        walBytes: size(`${o.dbPath}-wal`),
        counts: { docs: count("docs"), memory: count("memory"), tasks: count("tasks"), runs: count("run_records"), machines: count("machines"), users: o.users ? o.users.list().length : 0 },
      },
      backup: o.backup ? { dir: o.backup.dir, hours: o.backup.hours, keep: o.backup.keep, last, count: snapshots } : null,
      search: { mode: search.mode, model: search.model, url: o.embedUrl ?? null, indexed: search.indexed, total: search.total, lastError: search.lastError },
      files: o.hive.filesInfo(),
      storage: { releases: o.releases?.storage() ?? null, artifacts: (({ count, bytes, days }) => ({ count, bytes, days }))(o.hive.artifactsInfo()), runLogDays: o.hive.artifactsInfo().runLogDays },
      sso: o.sso ? { name: o.sso.name, issuer: o.sso.issuer, linked: o.users ? o.users.list().filter((u) => u.sso).length : 0 } : null,
      hosts: { allowed: o.allowedHosts ?? null, publicUrl: o.publicUrl ?? null, trustProxy: o.trustProxy ?? false },
    };
  }

  /** "Dọn dữ liệu": old app builds, old artifacts of done tasks, then the database file shrunk. */
  async cleanup(): Promise<HubCleanup> {
    const o = this.#o;
    const releases = o.releases?.prune() ?? null;
    const artifacts = await o.hive.pruneArtifacts();
    // The WAL holds recent pages: counting the main file alone would show VACUUM growing the database.
    const dbBytes = () => size(o.dbPath) + size(`${o.dbPath}-wal`);
    const before = dbBytes();
    o.hive.vacuum();
    return { releases, artifacts, db: { before, after: dbBytes() } };
  }

  /** "Backup ngay": a snapshot now, the oldest beyond the kept number removed, and the doc files in the store. */
  async backup(): Promise<BackupResult & { files: FilesBackupResult | null }> {
    const b = this.#o.backup;
    if (!b) throw new HiveError("bad_request", "Backups are off: set HIVE_BACKUP_DIR.", { key: "errors.backupOff" });
    const r = backupDatabase(this.#o.hive.db, { dir: b.dir, keep: b.keep, now: this.#o.now });
    return { ...r, files: this.#o.hive.filesInfo().store ? await backupFiles(this.#o.hive, b.dir) : null };
  }
}
