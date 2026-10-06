import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STEER_FILE = ".xdev-hive/steer.md";
export const STEER_PROMPT = "Read .xdev-hive/steer.md after each step and before your final report for additional instructions from the person directing this run. Apply new messages in order, once each. Do not edit or commit that file.";

export const STEER_RESUME_PROMPT = "Additional instructions arrived while you were working. Read .xdev-hive/steer.md and apply messages you have not handled yet, in order. Keep work already done and do not repeat completed instructions. Then finish the original task and report the result.";

export interface SteeringText { text: string; by: string; at: string }

/** Rename replaces a file symlink instead of following it; the parent must stay inside the worktree. */
export function writeSteer(worktree: string, runId: string, messages: SteeringText[]): void {
  const dir = path.join(worktree, ".xdev-hive");
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("Steering directory must not be a symlink.");
  mkdirSync(dir, { recursive: true });
  const file = path.join(worktree, STEER_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `# Run ${runId}\n\n` + messages.map((m, n) => `## ${n + 1} · ${m.by} · ${m.at}\n\n${m.text}\n`).join("\n"), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function claudeUserMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n";
}
