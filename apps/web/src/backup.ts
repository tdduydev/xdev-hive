// Hub database snapshots. VACUUM INTO writes a consistent, compacted copy of a live WAL database,
// so it is safe while the hub serves requests (unlike copying hub.db, which misses the -wal file). Doc files kept in
// SeaweedFS (roadmap 23c) are copied next to the snapshots, in files/, so a backup is still the whole hub.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHA256_HEX } from "@xdev-hive/core";

const FILE = /^hub-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

export interface BackupOptions {
  dir: string;
  /** Snapshots to keep in `dir`; older ones (by name) are deleted. */
  keep: number;
  now?: () => Date;
}

export interface BackupResult {
  file: string;
  removed: string[];
}

/** `hub-2026-09-27T09-00-00-000Z.db`: sorts by time, and prune only ever touches names of this shape. */
export const backupName = (at: Date) => `hub-${at.toISOString().replace(/[:.]/g, "-")}.db`;

export function backupDatabase(db: DatabaseSync, { dir, keep, now = () => new Date() }: BackupOptions): BackupResult {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a whole number ≥ 1 (got ${keep})`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, backupName(now()));
  db.prepare("VACUUM INTO ?").run(file);
  const snapshots = readdirSync(dir).filter((f) => FILE.test(f)).sort();
  const removed = snapshots.slice(0, Math.max(0, snapshots.length - keep)).map((f) => path.join(dir, f));
  for (const f of removed) rmSync(f);
  return { file, removed };
}

/** Snapshot of a database file that no server has open yet (before migrations), or null if there is none. */
export function backupFile(dbPath: string, opts: BackupOptions): BackupResult | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    return backupDatabase(db, opts);
  } finally {
    db.close();
  }
}

/** Reads HIVE_BACKUP_DIR / HIVE_BACKUP_HOURS / HIVE_BACKUP_KEEP. Null when backups are off. */
export function backupSettings(env: NodeJS.ProcessEnv): { dir: string; hours: number; keep: number } | null {
  if (!env.HIVE_BACKUP_DIR) return null;
  const hours = Number(env.HIVE_BACKUP_HOURS ?? 24);
  const keep = Number(env.HIVE_BACKUP_KEEP ?? 7);
  if (!(hours > 0)) throw new Error(`HIVE_BACKUP_HOURS must be > 0 (got ${env.HIVE_BACKUP_HOURS})`);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`HIVE_BACKUP_KEEP must be a whole number ≥ 1 (got ${env.HIVE_BACKUP_KEEP})`);
  return { dir: path.resolve(env.HIVE_BACKUP_DIR), hours, keep };
}

/** What a backup of the doc files needs from the hub. */
export interface StoredFiles {
  storedFileIds(): string[];
  readStoredFile(sha: string): Promise<Uint8Array | null>;
}

export interface FilesBackupResult {
  copied: number;
  /** Files the folder keeps: the database's and the kept snapshots'. */
  kept: number;
  removed: number;
  /** In the database but not in the store (or not the bytes they should be). */
  missing: string[];
}

/** Folder of the doc files in a backup directory: files/<sha256>. */
export const filesDir = (dir: string) => path.join(dir, "files");

/**
 * Copies the files the database keeps in the store and the backup does not have yet (checked against their SHA-256),
 * then removes the ones neither the database nor any kept snapshot points at. Each file is written once: a backup
 * costs only what was added since the last.
 */
export async function backupFiles(source: StoredFiles, dir: string): Promise<FilesBackupResult> {
  const folder = filesDir(dir);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const want = new Set(source.storedFileIds());
  let copied = 0;
  const missing: string[] = [];
  for (const sha of want) {
    const file = path.join(folder, sha);
    if (existsSync(file)) continue;
    const bytes = await source.readStoredFile(sha);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== sha) {
      missing.push(sha);
      continue;
    }
    writeFileSync(`${file}.part`, bytes, { mode: 0o600 });
    renameSync(`${file}.part`, file);
    copied++;
  }
  for (const f of readdirSync(dir)) if (FILE.test(f)) for (const sha of snapshotFileIds(path.join(dir, f))) want.add(sha);
  let removed = 0;
  for (const f of readdirSync(folder)) {
    if (want.has(f) || !(SHA256_HEX.test(f) || f.endsWith(".part"))) continue;
    rmSync(path.join(folder, f));
    removed++;
  }
  return { copied, kept: want.size, removed, missing };
}

/** The files a snapshot keeps in the store; none for a snapshot from before 23c (its files are inside it). */
function snapshotFileIds(file: string): string[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return (db.prepare("SELECT DISTINCT sha256 FROM doc_assets WHERE stored IS NOT NULL AND sha256 IS NOT NULL").all() as Array<{ sha256: string }>).map((r) => r.sha256);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
