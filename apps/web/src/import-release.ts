// Adds desktop builds to the hub from files already on its disk, for a release run by someone who can reach the hub's
// host over SSH (apps/desktop/scripts/release.mjs, HIVE_RELEASE_SSH). SSH access to the host is the authorization, as
// for deploy/update.sh: no hub admin token has to live on the releasing machine. Run inside the hub's container:
//   node apps/web/src/import-release.ts --dir /data/incoming/<version> --version <version> [--notes <file>] [--by <who>]
// The folder holds the builds, SHA256SUMS.txt and optionally the notes; every build is checked against SHA256SUMS.txt,
// moved into the release store and the folder is removed.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { DEFAULT_RELEASE_KEEP, ReleaseStore } from "#web/releases.ts";

/** platform, arch and kind from electron-builder's file names, as hub-upload.mjs reads them for the HTTP upload. */
export function describeBuild(name: string): { platform: string; arch: string; kind: string } | null {
  const m = /-(mac|win|linux)-(arm64|x64|x86_64|amd64)(?:-setup)?\.(dmg|zip|exe|AppImage|deb)$/.exec(name);
  return m ? { platform: m[1]!, arch: ["x86_64", "amd64"].includes(m[2]!) ? "x64" : m[2]!, kind: m[3]! } : null;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export interface ImportResult { added: string[]; kept: string[] }

/**
 * Builds a copy can corrupt (a cut-off scp/tar) never reach machines: a file missing from SHA256SUMS.txt, or with
 * another hash, stops the import before anything is stored.
 */
export async function importRelease({ db, store, from, version, notes, by, log = () => {} }: {
  db: DatabaseSync; store: ReleaseStore; from: string; version: string; notes?: string; by: string; log?: (line: string) => void;
}): Promise<ImportResult> {
  const sumsFile = path.join(from, "SHA256SUMS.txt");
  if (!existsSync(sumsFile)) throw new Error(`${sumsFile} is missing.`);
  const sums = new Map(readFileSync(sumsFile, "utf8").split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([h, n]) => [n!, h!]));
  const builds = readdirSync(from).filter((n) => describeBuild(n)).sort();
  if (!builds.length) throw new Error(`No builds in ${from}.`);
  const hashes = new Map<string, string>();
  for (const name of builds) {
    const want = sums.get(name);
    if (!want) throw new Error(`${name} is not in SHA256SUMS.txt.`);
    const got = await sha256(path.join(from, name));
    if (got !== want) throw new Error(`${name}: SHA-256 ${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}… (copy damaged?)`);
    hashes.set(name, got);
  }
  const have = new Set(store.list().filter((r) => r.version === version).flatMap((r) => r.files).map((f) => `${f.name} ${f.sha256}`));
  const result: ImportResult = { added: [], kept: [] };
  for (const name of builds) {
    const hash = hashes.get(name)!;
    if (have.has(`${name} ${hash}`)) {
      result.kept.push(name);
      log(`= ${name} (already there)`);
      continue;
    }
    const file = store.add({ version, channel: "stable", ...describeBuild(name)!, name, tmpFile: path.join(from, name), sha256: hash });
    // The same audit line as an upload through /api/releases/upload, so the hub's log shows who put a build there.
    db.prepare("INSERT INTO audit(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), by, "releases.upload", `${file.version}/${file.name}`, `${file.platform}-${file.arch} · ${(file.size / 1e6).toFixed(0)} MB · ssh`);
    result.added.push(name);
    log(`← ${name}`);
  }
  if (notes !== undefined) store.setNotes(version, notes);
  return result;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const from = arg("dir");
  const version = arg("version");
  if (!from || !version) {
    console.error("Usage: node apps/web/src/import-release.ts --dir <folder> --version <x.y.z> [--notes <file>] [--by <who>]");
    process.exit(2);
  }
  const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(import.meta.dirname, "..", "data", "hub.db"));
  const db = new DatabaseSync(dbPath);
  // The running hub holds the same file: wait for its writes instead of failing on a lock.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;");
  const keep = Number(process.env.HIVE_RELEASE_KEEP);
  const store = new ReleaseStore(db, path.join(path.dirname(dbPath), "releases"), undefined, Number.isFinite(keep) && keep >= 1 ? keep : DEFAULT_RELEASE_KEEP);
  const notesFile = arg("notes");
  try {
    const r = await importRelease({ db, store, from, version, notes: notesFile ? readFileSync(notesFile, "utf8") : undefined, by: arg("by") ?? "ssh", log: console.log });
    console.log(`hub has ${version}: ${r.added.length} added, ${r.kept.length} already there. Pick it on Phiên bản app to roll it out.`);
    rmSync(from, { recursive: true, force: true });
  } catch (err) {
    // The folder stays for a look at what arrived; the next import of this version replaces it.
    console.error(`import failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
