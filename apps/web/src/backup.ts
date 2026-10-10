// Hub database snapshots. VACUUM INTO writes a consistent, compacted copy of a live WAL database,
// so it is safe while the hub serves requests (unlike copying hub.db, which misses the -wal file). Doc files kept in
// SeaweedFS (roadmap 23c) are copied next to the snapshots, in files/, so a backup is still the whole hub.
//
// Pins (ADM-backup-restore): the snapshot projects.delete makes, and one asked for by hand, is pinned: the
// HIVE_BACKUP_KEEP rotation counts and removes only unpinned ones, so a week of restarts can no longer rotate away the
// one way back from a deletion. A pin still ends, HIVE_BACKUP_PIN_DAYS after it was set, and pinning by hand stops at
// HIVE_BACKUP_PIN_MAX_MB: both are shown on the Hub page next to the list. Why a snapshot was made and whether it is
// pinned sits next to it, in <name>.json, so the CLI and an older hub that only know the .db files keep working.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HiveError, SHA256_HEX, type BackupEntry, type BackupList, type BackupReason } from "@xdev-hive/core";

const FILE = /^hub-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;
const DAY = 86_400_000;

/** How long a pin protects a snapshot, and how much pinning by hand may take. */
export interface PinPolicy {
  /** 0: until someone unpins it. */
  pinDays: number;
  /** 0: no cap. */
  pinMaxBytes: number;
}

export const DEFAULT_PIN_DAYS = 180;
export const DEFAULT_PIN_MAX_MB = 20_480;

export interface BackupOptions {
  dir: string;
  /** Unpinned snapshots to keep in `dir`; older ones (by name) are deleted. */
  keep: number;
  now?: () => Date;
  reason?: BackupReason;
  /** Left out of the rotation while the pin lasts. Snapshots made by hand and before a deletion are pinned. */
  pin?: boolean;
  /** Days a pin lasts; 0 or left out: until unpinned. */
  pinDays?: number;
  /** Who asked, written next to the pin. */
  by?: string;
}

export interface BackupResult {
  file: string;
  removed: string[];
}

interface BackupMeta {
  reason: BackupReason | null;
  pinned: boolean;
  pinnedAt: string | null;
  pinnedBy: string | null;
}

/** `hub-2026-09-27T09-00-00-000Z.db`: sorts by time, and prune only ever touches names of this shape. */
export const backupName = (at: Date) => `hub-${at.toISOString().replace(/[:.]/g, "-")}.db`;

/** The time in a snapshot's name, back as an ISO date. */
const nameTime = (name: string) => name.slice(4, -3).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");

const metaFile = (file: string) => `${file}.json`;

function readMeta(file: string): BackupMeta {
  try {
    const m = JSON.parse(readFileSync(metaFile(file), "utf8")) as Partial<BackupMeta>;
    return { reason: m.reason ?? null, pinned: m.pinned === true, pinnedAt: m.pinnedAt ?? null, pinnedBy: m.pinnedBy ?? null };
  } catch {
    // A snapshot from before pins, or one whose note was lost: unpinned, reason unknown.
    return { reason: null, pinned: false, pinnedAt: null, pinnedBy: null };
  }
}

function writeMeta(file: string, meta: BackupMeta): void {
  writeFileSync(`${metaFile(file)}.part`, JSON.stringify(meta), { mode: 0o600 });
  renameSync(`${metaFile(file)}.part`, metaFile(file));
}

/** When a pin stops protecting its snapshot; null: never, or not pinned. */
const pinEnds = (meta: BackupMeta, name: string, pinDays: number) =>
  meta.pinned && pinDays > 0 ? new Date(Date.parse(meta.pinnedAt ?? nameTime(name)) + pinDays * DAY).toISOString() : null;

const pinHolds = (meta: BackupMeta, name: string, pinDays: number, now: Date) => {
  if (!meta.pinned) return false;
  const ends = pinEnds(meta, name, pinDays);
  return ends === null || Date.parse(ends) > now.getTime();
};

/** Removes the oldest unpinned snapshots (pins that ran out count as unpinned) beyond `keep`, with their notes. */
function prune(dir: string, keep: number, pinDays: number, now: Date): string[] {
  const rotating = readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .filter((f) => !pinHolds(readMeta(path.join(dir, f)), f, pinDays, now));
  const removed = rotating.slice(0, Math.max(0, rotating.length - keep)).map((f) => path.join(dir, f));
  for (const f of removed) {
    rmSync(f);
    rmSync(metaFile(f), { force: true });
  }
  return removed;
}

export function backupDatabase(db: DatabaseSync, { dir, keep, now = () => new Date(), reason, pin = false, pinDays = 0, by }: BackupOptions): BackupResult {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a whole number ≥ 1 (got ${keep})`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = now();
  const file = path.join(dir, backupName(at));
  db.prepare("VACUUM INTO ?").run(file);
  writeMeta(file, { reason: reason ?? null, pinned: pin, pinnedAt: pin ? at.toISOString() : null, pinnedBy: pin ? (by ?? null) : null });
  return { file, removed: prune(dir, keep, pinDays, at) };
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

/** The snapshots in `dir`, newest first, with why each was made and how long its pin lasts. */
export function listBackups(dir: string, keep: number, policy: PinPolicy, now = new Date()): BackupList {
  const backups: BackupEntry[] = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => FILE.test(f))
    .sort()
    .reverse()
    .map((name) => {
      const file = path.join(dir, name);
      const meta = readMeta(file);
      const pinned = pinHolds(meta, name, policy.pinDays, now);
      return {
        name,
        createdAt: nameTime(name),
        bytes: statSync(file).size,
        reason: meta.reason,
        pinned,
        pinnedAt: pinned ? meta.pinnedAt : null,
        pinnedBy: pinned ? meta.pinnedBy : null,
        expiresAt: pinned ? pinEnds(meta, name, policy.pinDays) : null,
      };
    });
  const pinnedBytes = backups.filter((b) => b.pinned).reduce((sum, b) => sum + b.bytes, 0);
  return { dir, keep, pinDays: policy.pinDays, pinMaxBytes: policy.pinMaxBytes, pinnedBytes, backups };
}

/** A snapshot of `dir` by its name; anything that is not one (a path, a note, another file) is not found. */
export function backupPath(dir: string, name: string): string {
  const file = path.join(dir, name);
  if (!FILE.test(name) || !existsSync(file)) throw new HiveError("not_found", `No backup ${name}.`, { key: "errors.backupNotFound", vars: { name } });
  return file;
}

/**
 * Pins a snapshot (again: a pin that ran out, or one renewed, starts its days over) or unpins it, which hands it back
 * to the rotation. A pin by hand past the policy's cap is refused; the automatic ones never are, a deletion's least.
 */
export function setPinned(dir: string, name: string, pinned: boolean, { by, now = new Date(), policy }: { by: string; now?: Date; policy: PinPolicy }): BackupEntry {
  const file = backupPath(dir, name);
  const meta = readMeta(file);
  if (pinned && policy.pinMaxBytes > 0) {
    const others = listBackups(dir, 1, policy, now).backups.filter((b) => b.pinned && b.name !== name).reduce((sum, b) => sum + b.bytes, 0);
    if (others + statSync(file).size > policy.pinMaxBytes) {
      const mb = Math.round(policy.pinMaxBytes / 1_048_576);
      throw new HiveError("conflict", `Pinned backups would pass ${mb} MB (HIVE_BACKUP_PIN_MAX_MB): unpin one first.`, { key: "errors.backupPinFull", vars: { mb } });
    }
  }
  writeMeta(file, { ...meta, pinned, pinnedAt: pinned ? now.toISOString() : null, pinnedBy: pinned ? by : null });
  return listBackups(dir, 1, policy, now).backups.find((b) => b.name === name)!;
}

export type BackupSettings = { dir: string; hours: number; keep: number } & PinPolicy;

/** Reads HIVE_BACKUP_DIR / _HOURS / _KEEP / _PIN_DAYS / _PIN_MAX_MB. Null when backups are off. */
export function backupSettings(env: NodeJS.ProcessEnv): BackupSettings | null {
  if (!env.HIVE_BACKUP_DIR) return null;
  const hours = Number(env.HIVE_BACKUP_HOURS ?? 24);
  const keep = Number(env.HIVE_BACKUP_KEEP ?? 7);
  const pinDays = Number(env.HIVE_BACKUP_PIN_DAYS ?? DEFAULT_PIN_DAYS);
  const pinMaxMb = Number(env.HIVE_BACKUP_PIN_MAX_MB ?? DEFAULT_PIN_MAX_MB);
  if (!(hours > 0)) throw new Error(`HIVE_BACKUP_HOURS must be > 0 (got ${env.HIVE_BACKUP_HOURS})`);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`HIVE_BACKUP_KEEP must be a whole number ≥ 1 (got ${env.HIVE_BACKUP_KEEP})`);
  if (!Number.isInteger(pinDays) || pinDays < 0) throw new Error(`HIVE_BACKUP_PIN_DAYS must be a whole number ≥ 0 (got ${env.HIVE_BACKUP_PIN_DAYS})`);
  if (!(pinMaxMb >= 0)) throw new Error(`HIVE_BACKUP_PIN_MAX_MB must be ≥ 0 (got ${env.HIVE_BACKUP_PIN_MAX_MB})`);
  return { dir: path.resolve(env.HIVE_BACKUP_DIR), hours, keep, pinDays, pinMaxBytes: Math.round(pinMaxMb * 1_048_576) };
}

/** What a backup of the stored files needs from the hub. */
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

/** Folder of stored files in a backup directory: files/<sha256>. */
export const filesDir = (dir: string) => path.join(dir, "files");

/** A stored file kept in the backup folder, checked against its name; null when it is not there. */
export function backedUpFile(dir: string, sha: string): Uint8Array | null {
  const file = path.join(filesDir(dir), sha);
  if (!SHA256_HEX.test(sha) || !existsSync(file)) return null;
  const bytes = new Uint8Array(readFileSync(file));
  return createHash("sha256").update(bytes).digest("hex") === sha ? bytes : null;
}

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

/** The files a snapshot keeps in the store; older schemas may not have every blob table. */
function snapshotFileIds(file: string): string[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const existing = new Set(tables.map((r) => r.name));
    return (["doc_assets", "artifacts"] as const).filter((table) => existing.has(table)).flatMap((table) =>
      (db!.prepare(`SELECT DISTINCT sha256 FROM ${table} WHERE stored IS NOT NULL AND sha256 IS NOT NULL`).all() as Array<{ sha256: string }>).map((r) => r.sha256),
    );
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
