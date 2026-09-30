// Reading a run's log and diff for the Lượt chạy page: the runner writes a readable log (▶ tool calls, ✓ ✗ results,
// the agent's words, # notes, ## sections) and the diff is `git diff` output.

export type LogLevel = "tool" | "ok" | "error" | "agent" | "meta" | "section";

export interface LogLine {
  level: LogLevel;
  text: string;
  /** The ## section the line is in (Prompt, Output, Result), null before the first one. */
  section: string | null;
}

/** Splits the log into lines with a level, the way the design's log viewer labels them (TOOL / OK / LỖI / AGENT). */
export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trimStart();
    if (trimmed.startsWith("## ")) {
      section = trimmed.slice(3).trim();
      out.push({ level: "section", text: section, section });
      continue;
    }
    if (!trimmed) {
      // Blank lines only matter inside text the agent wrote.
      if (out.length && out[out.length - 1]!.level === "agent") out.push({ level: "agent", text: "", section });
      continue;
    }
    const level: LogLevel = trimmed.startsWith("▶")
      ? "tool"
      : trimmed.startsWith("✓")
        ? "ok"
        : trimmed.startsWith("✗")
          ? "error"
          : trimmed.startsWith("# ") || trimmed.startsWith("$ ")
            ? "meta"
            : "agent";
    const body = level === "tool" || level === "ok" || level === "error" ? trimmed.slice(1).trimStart() : level === "meta" ? trimmed : line;
    out.push({ level, text: body, section });
  }
  // A trailing blank agent line adds nothing.
  while (out.length && out[out.length - 1]!.level === "agent" && !out[out.length - 1]!.text) out.pop();
  return out;
}

export interface DiffFile {
  path: string;
  adds: number;
  dels: number;
  binary: boolean;
  lines: Array<{ kind: "hunk" | "add" | "del" | "ctx"; text: string }>;
}

/** Files of a `git diff` (unified) with their +/− counts and lines. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of patch.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!, adds: 0, dels: 0, binary: false, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ") || /^(new|deleted) file mode|^similarity index|^rename (from|to)|^old mode|^new mode/.test(line)) {
      const to = /^\+\+\+ b\/(.+)$/.exec(line);
      if (to) cur.path = to[1]!;
      continue;
    }
    if (line.startsWith("Binary files")) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith("@@")) cur.lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) {
      cur.adds++;
      cur.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      cur.dels++;
      cur.lines.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) cur.lines.push({ kind: "ctx", text: line.slice(1) });
  }
  return files;
}
