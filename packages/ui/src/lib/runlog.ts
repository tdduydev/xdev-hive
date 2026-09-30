// Reading a run's log and diff for the Lượt chạy page: the runner writes a readable log (▶ tool calls, ✓ ✗ results,
// the agent's words, # notes, ## sections) and the diff is `git diff` output.

export type LogLevel = "tool" | "ok" | "error" | "agent" | "meta" | "section";

export interface LogLine {
  level: LogLevel;
  text: string;
  /** The ## section the line is in (Prompt, Output, Result), null before the first one. */
  section: string | null;
  /** When the agent wrote it (the runner stamps its lines, roadmap 22l); null for the header, the result, older logs. */
  at: string | null;
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\t/;

/** Splits the log into lines with a level, the way the design's log viewer labels them (TOOL / OK / LỖI / AGENT). */
export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  let section: string | null = null;
  for (const stamped of text.split("\n")) {
    const hit = STAMP.exec(stamped);
    const at = hit ? hit[1]! : null;
    const raw = hit ? stamped.slice(hit[0].length) : stamped;
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trimStart();
    if (trimmed.startsWith("## ")) {
      section = trimmed.slice(3).trim();
      out.push({ level: "section", text: section, section, at });
      continue;
    }
    if (!trimmed) {
      // Blank lines only matter inside text the agent wrote.
      if (out.length && out[out.length - 1]!.level === "agent") out.push({ level: "agent", text: "", section, at: null });
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
    out.push({ level, text: body, section, at });
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

export const RUN_STEPS = {
  implement: ["read", "code", "test", "deliver"],
  review: ["readDiff", "check", "comment"],
  plan: ["read", "plan", "write"],
} as const;
export type RunStepId = (typeof RUN_STEPS)[keyof typeof RUN_STEPS][number];

export interface RunStep {
  id: RunStepId;
  state: "done" | "current" | "failed" | "todo";
  /** When the run got to it (the first line of it in the log). */
  at: string | null;
}

const READ = /^(Read|Grep|Glob|WebFetch|WebSearch)\b|^(memory_search|doc_get|doc_list|skill_get|skills_list|task_get|task_claim|task_list)\b/;
const WRITE = /^(Edit|MultiEdit|Write|NotebookEdit)\b/;
const TEST = /^Bash: .*\b(test|tests|pytest|jest|vitest|mocha|go test|mvn|gradle|cargo (test|check|build)|tsc|typecheck|lint|eslint|ruff|mypy|build)\b/;
const DELIVER = /^Bash: .*\bgit (commit|push)\b|^(task_update|memory_write|doc_propose)\b/;
const REVIEW_READ = /^Bash: .*\bgit (diff|log|show)\b|^Read\b|^(task_get|task_claim|memory_search|doc_get)\b/;
const REVIEW_CHECK = /^(Grep|Glob)\b|^Bash: /;
const PLAN_WRITE = /^(task_update|tasks?_create|propose_task|memory_write|doc_propose)\b/;

/** Which step a tool line belongs to, for the run's role (-1: none in particular). */
function stepOf(role: keyof typeof RUN_STEPS, tool: string): number {
  if (role === "implement") return DELIVER.test(tool) ? 3 : TEST.test(tool) ? 2 : WRITE.test(tool) ? 1 : READ.test(tool) ? 0 : -1;
  if (role === "review") return /^(task_update|memory_write)\b/.test(tool) ? 2 : REVIEW_READ.test(tool) ? 0 : REVIEW_CHECK.test(tool) ? 1 : -1;
  return PLAN_WRITE.test(tool) ? 2 : tool === "TodoWrite" ? 1 : READ.test(tool) ? 0 : -1;
}

/**
 * The steps of a run as its log shows them (roadmap 22l): the furthest step it reached is where it is (a run that goes
 * back to reading after writing code is still writing code). Finished: all done; failed: the step it was on failed.
 */
export function runSteps(role: string, lines: LogLine[], status: string): RunStep[] {
  const r = (role in RUN_STEPS ? role : "implement") as keyof typeof RUN_STEPS;
  const ids = RUN_STEPS[r];
  const at: Array<string | null> = ids.map(() => null);
  let reached = -1;
  for (const l of lines) {
    if (l.level !== "tool") continue;
    const i = stepOf(r, l.text);
    if (i < 0) continue;
    at[i] ??= l.at;
    if (i > reached) reached = i;
  }
  const running = status === "running";
  const failed = status === "failed" || status === "cancelled" || status === "rate_limited";
  if (status === "succeeded") return ids.map((id, i) => ({ id, state: "done", at: at[i] ?? null }));
  if (status === "queued" || (!running && !failed && reached < 0)) return ids.map((id, i) => ({ id, state: "todo", at: at[i] ?? null }));
  const now = Math.max(0, reached);
  return ids.map((id, i) => ({ id, state: i < now ? "done" : i === now ? (failed ? "failed" : "current") : "todo", at: at[i] ?? null }));
}
