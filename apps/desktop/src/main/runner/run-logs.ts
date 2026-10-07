// A run's full log stays on the machine after the hub got its tail (runs.push keeps 200 lines); nothing removed it, so
// the folder grew with every run. Old ones go with the worktree retention (DATA-cleanup-machine).
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** What a run leaves next to its record: the log and the plan an approved plan run wrote. */
const RUN_FILE = /^(.+?)\.(log|plan\.md)$/;

/** Removes run files untouched for `days`, never those of a run still going; returns how many and their bytes. */
export function pruneRunLogs(dir: string, days: number, now: Date, active: ReadonlySet<string>): { removed: number; bytes: number } {
  const out = { removed: 0, bytes: 0 };
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  const cutoff = +now - days * 86400_000;
  for (const name of names) {
    const m = RUN_FILE.exec(name);
    if (!m || active.has(m[1]!)) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      rmSync(file, { force: true });
      out.removed++;
      out.bytes += st.size;
    } catch { /* gone meanwhile or unreadable: the next round tries again */ }
  }
  return out;
}
