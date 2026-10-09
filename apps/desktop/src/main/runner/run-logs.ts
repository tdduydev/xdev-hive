// A run's full log stays on the machine after the hub got its tail (runs.push keeps 200 lines); nothing removed it, so
// the folder grew with every run. Old ones go with the worktree retention (DATA-cleanup-machine).
import { createReadStream, readdirSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { redactLines, SecretRedactor } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";
import { StringDecoder } from "node:string_decoder";

/** What a run leaves next to its record: the log and the plan an approved plan run wrote. */
const RUN_FILE = /^(.+?)\.(log|plan\.md)$/;
export const redactedMarker = (file: string) => `${file}.redacted`;

/** The writer redacts marked logs. Read only their bounded suffix, dropping a partial first line. */
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
    let raw = buffer.subarray(0, used);
    if (start > 0) {
      const newline = raw.indexOf(10);
      raw = newline < 0 ? Buffer.alloc(0) : raw.subarray(newline + 1);
    }
    const redacted = redactLines(raw.toString("utf8"));
    const tail = limit ? Buffer.from(redacted).subarray(-limit).toString("utf8") : "";
    return { size: stat.size, mtimeMs: stat.mtimeMs, text: (stat.size > limit ? `${tr("runNote.logClipped")}\n` : "") + tail };
  } finally {
    await handle.close();
  }
}

/** Legacy files may contain an open PEM block before the suffix, so stream them before caching. */
export async function readLegacyRunLogTail(file: string, maxBytes: number): Promise<{ size: number; mtimeMs: number; text: string }> {
  const handle = await open(file, "r");
  const stat = await handle.stat();
  await handle.close();
  const limit = Math.max(0, Math.floor(maxBytes));
  const redactor = new SecretRedactor();
  const decoder = new StringDecoder("utf8");
  let tail = Buffer.alloc(0);
  const keep = (text: string) => { tail = limit ? Buffer.concat([tail, Buffer.from(text)]).subarray(-limit) : Buffer.alloc(0); };
  for await (const chunk of createReadStream(file)) keep(redactor.write(decoder.write(chunk as Buffer)));
  keep(redactor.write(decoder.end()) + redactor.end());
  return { size: stat.size, mtimeMs: stat.mtimeMs, text: (stat.size > limit ? `${tr("runNote.logClipped")}\n` : "") + tail.toString("utf8") };
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
