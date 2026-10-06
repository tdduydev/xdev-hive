// The files an agent made during a run (roadmap 41c). It writes them in .xdev-hive/artifacts/ of its worktree, which
// never goes in the commit (see renderedPaths); when the run ends the runner sends them to the hub, so a smoke
// screenshot or a measurement outlives the branch and the machine. What does not fit the limits stays on the machine
// with a line in the run's log: the hub is not the place for a build output.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_DEPTH, ARTIFACT_DIR, ARTIFACT_MAX_BYTES, ARTIFACTS_PER_RUN, artifactName, checkArtifact, checkArtifactSize, toErrorPayload } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";

export interface RunArtifact {
  /** Relative to ARTIFACT_DIR, with forward slashes: the name the hub keeps it under. */
  name: string;
  /** Where it is in the worktree, as read: the runner deletes it once the hub has it. */
  file: string;
  data: string;
  size: number;
}

export interface CollectedArtifacts {
  files: RunArtifact[];
  /** One line per file left behind, in the interface language, for the run's log. */
  skipped: string[];
}

/**
 * Every file under ARTIFACT_DIR, deepest folders last, in path order so two runs of the same work pick the same ones.
 * A link is listed but never followed (Dirent does not follow it): readArtifact then turns it down.
 */
function walk(root: string, rel: string, depth: number, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return; // no artifacts folder, or it went between the two calls
  }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isFile() || e.isSymbolicLink()) out.push(next);
    else if (e.isDirectory() && depth > 1) walk(root, next, depth - 1, out);
  }
}

/**
 * The file's bytes, read through a descriptor that refuses a link (O_NOFOLLOW): the runner deletes the file once the
 * hub has it, and a link would have it read, then delete, something outside the worktree. Its size is checked before
 * reading, and the read stops at the limit, so a huge file the agent left never sits whole in the app's memory.
 */
function readArtifact(file: string, name: string): Uint8Array {
  // Windows has no O_NOFOLLOW (it is undefined there, so 0): the lstat is what turns a link down on it.
  if (lstatSync(file).isSymbolicLink()) throw new Error(tr("runNote.artifactNotFile"));
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new Error(tr("runNote.artifactNotFile"));
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(tr("runNote.artifactNotFile"));
    checkArtifactSize(name, stat.size);
    // One byte past the limit: a file that grew after fstat is still caught by checkArtifact.
    const buf = Buffer.alloc(Math.min(stat.size, ARTIFACT_MAX_BYTES) + 1);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got);
  } finally {
    closeSync(fd);
  }
}

/** True when ARTIFACT_DIR is a real folder of the worktree, not a link to somewhere else that cleanup would empty. */
function ownFolder(worktree: string, root: string): boolean {
  try {
    return realpathSync(root) === path.join(realpathSync(worktree), ARTIFACT_DIR);
  } catch {
    return true; // no artifacts folder: walk finds nothing
  }
}

/**
 * What the run leaves for the hub, and why the rest stays. Reads at most `limit` files; a name that is nothing but
 * folder tricks, two paths that come out as the same name, a link, a kind the hub does not keep, an empty file and
 * one over 5 MB each get their own line.
 */
export function collectArtifacts(worktree: string, limit = ARTIFACTS_PER_RUN): CollectedArtifacts {
  const root = path.join(worktree, ARTIFACT_DIR);
  if (!ownFolder(worktree, root)) return { files: [], skipped: [tr("runNote.artifactsLinked", { dir: ARTIFACT_DIR })] };
  const paths: string[] = [];
  walk(root, "", ARTIFACT_DEPTH, paths);
  const files: RunArtifact[] = [];
  const skipped: string[] = [];
  // Which path got each name: "report.md" and ".report.md" are both "report.md" on the hub, and sending both would
  // have the second replace the first there while the runner deleted both here.
  const taken = new Map<string, string>();
  for (const rel of paths) {
    if (files.length >= limit) {
      skipped.push(tr("runNote.artifactsOverLimit", { count: paths.length - files.length - skipped.length, max: limit }));
      break;
    }
    const name = artifactName(rel);
    const file = path.join(root, rel);
    try {
      if (!name) throw new Error(tr("runNote.artifactBadName"));
      const other = taken.get(name);
      if (other !== undefined) throw new Error(tr("runNote.artifactSameName", { name, other }));
      const bytes = readArtifact(file, name);
      // Most of what the hub refuses is caught here, so it does not travel: the hub checks again anyway.
      checkArtifact(name, bytes);
      taken.set(name, rel);
      files.push({ name, file, data: Buffer.from(bytes).toString("base64"), size: bytes.length });
    } catch (err) {
      skipped.push(tr("runNote.artifactSkipped", { name: rel, reason: toErrorPayload(err).message }));
    }
  }
  return { files, skipped };
}
