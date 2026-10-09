// A run's full log stays on the machine after the hub got its tail (runs.push keeps 200 lines); nothing removed it, so
// the folder grew with every run. Old ones go with the worktree retention (DATA-cleanup-machine).
import { readdirSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { redactLines } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";

/** What a run leaves next to its record: the log and the plan an approved plan run wrote. */
const RUN_FILE = /^(.+?)\.(log|plan\.md)$/;
export const redactedMarker = (file: string) => `${file}.redacted`;

/** Read a bounded suffix, including overlap so secrets split at the boundary can be redacted again. */
export async function readRunLogTail(file: string, maxBytes: number): Promise<{ size: number; mtimeMs: number; text: string }> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    const limit = Math.max(0, Math.floor(maxBytes));
    const length = Math.min(stat.size, limit + 4096);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const { bytesRead } = await handle.read(buffer, used, length - used, start + used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const raw = buffer.subarray(0, used);
    // A partial first line may hold a credential. Keep it only when the whole
    // window is one long final line, whose suffix the caller must still see.
    let visible = raw.toString("utf8");
    if (start > 0) {
      const firstNewline = visible.indexOf("\n");
      if (firstNewline >= 0) visible = visible.slice(firstNewline + 1);
      const firstBegin = visible.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      const firstEnd = /-----END [A-Z ]*PRIVATE KEY-----/.exec(visible);
      // The opening delimiter can be before the bounded window. An ending delimiter proves
      // the preceding suffix belongs to that key, even though the writer's state is unavailable.
      if (firstEnd && (firstBegin < 0 || firstEnd.index < firstBegin)) {
        visible = `(line hidden: it looked like a private key)\n${visible.slice(firstEnd.index + firstEnd[0].length)}`;
      }
    }
    const redacted = redactLines(visible).replace(/(^|\n)[A-Za-z0-9+/]{40,100}={0,2}(?=\n|$)/g,
      "$1(line hidden: it looked like a private key)");
    const tail = limit ? Buffer.from(redacted).subarray(-limit).toString("utf8") : "";
    return { size: stat.size, mtimeMs: stat.mtimeMs, text: (stat.size > limit ? `${tr("runNote.logClipped")}\n` : "") + tail };
  } finally {
    await handle.close();
  }
}

/** Legacy logs use the same bounded read and redaction at the read boundary. */
export async function readLegacyRunLogTail(file: string, maxBytes: number): Promise<{ size: number; mtimeMs: number; text: string }> {
  return readRunLogTail(file, maxBytes);
}

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
      if (m[2] === "log") rmSync(redactedMarker(file), { force: true });
      out.removed++;
      out.bytes += st.size;
    } catch { /* gone meanwhile or unreadable: the next round tries again */ }
  }
  return out;
}
