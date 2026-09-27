// Hub database snapshots. VACUUM INTO writes a consistent, compacted copy of a live WAL database,
// so it is safe while the hub serves requests (unlike copying hub.db, which misses the -wal file).
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
