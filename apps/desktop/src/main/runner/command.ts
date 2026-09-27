// Builds the command line and prompt for one run.
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile, AgentRole } from "@xdev-hive/core";

export interface PromptContext {
  project: string;
  taskId: string;
  title: string;
  note: string | null;
  role: AgentRole;
  instructions: string;
  worktree: string;
  branch: string;
  baseSha: string;
  attempt: number;
  previous: { profileId: string; reason: string } | null;
}

export function buildPrompt(c: PromptContext): string {
  const lines: string[] = [];
  if (c.role === "review") {
    lines.push(
      `Review the work for task ${c.taskId} of project "${c.project}" (xDev Hive): ${c.title}`,
      "",
      `Working copy: ${c.worktree} (branch ${c.branch}). See the change with: git diff ${c.baseSha}...HEAD`,
      "",
      "Look for bugs, regressions, missing tests and risky changes. Do not rewrite the feature;",
      "fix only small, obvious mistakes. End with a short report: verdict (approve / changes needed), then findings.",
      'Record reusable lessons with memory_write (xdev-hive MCP). Do not change the task status.',
    );
  } else {
    lines.push(
      `You are working on task ${c.taskId} of project "${c.project}" (xDev Hive).`,
      `Task: ${c.title}`,
      "",
      `Working copy: ${c.worktree} (git worktree on branch ${c.branch}, based on ${c.baseSha.slice(0, 10)}). Stay inside it.`,
    );
    if (c.role === "plan") {
      lines.push("", "This is a planning run: write the plan to docs/plans/" + c.taskId + ".md. Do not implement yet.");
    }
    lines.push(
      "",
      "Follow the Agent protocol in AGENTS.md, using the xdev-hive MCP tools with project key " + `"${c.project}":`,
      "1. memory_search for context before changing code.",
      "2. memory_write for decisions, conventions and gotchas worth sharing with other agents.",
      "3. Never edit AGENTS.md, CLAUDE.md or docs/decisions.md; use doc_get + doc_propose.",
      `4. When done, task_update ${c.taskId} to "review" with a note: what changed, what is left, how to verify, risks.`,
      "Do not push. Uncommitted changes are committed to this branch for you when you exit.",
    );
  }
  if (c.note) lines.push("", "Latest note on the task:", c.note);
  if (c.previous) {
    lines.push(
      "",
      `This is attempt ${c.attempt}. The previous agent (${c.previous.profileId}) stopped: ${c.previous.reason}.`,
      `Read \`git log ${c.baseSha.slice(0, 10)}..HEAD\` and the task note, then continue from where it stopped.`,
    );
  }
  if (c.instructions.trim()) lines.push("", "Extra instructions from the admin:", c.instructions.trim());
  return lines.join("\n");
}

export interface BuiltCommand {
  bin: string;
  args: string[];
  /** Sent on stdin when the profile's args have no {prompt}. */
  stdin: string | null;
}

export function buildCommand(
  profile: AgentProfile,
  vars: { prompt: string; worktree: string; task: string; project: string; branch: string },
): BuiltCommand {
  const usesPrompt = profile.args.some((a) => a.includes("{prompt}"));
  const fill = (a: string) =>
    a
      .replaceAll("{prompt}", vars.prompt)
      .replaceAll("{worktree}", vars.worktree)
      .replaceAll("{task}", vars.task)
      .replaceAll("{project}", vars.project)
      .replaceAll("{branch}", vars.branch);
  return { bin: expandHome(profile.bin), args: profile.args.map(fill), stdin: usesPrompt ? null : vars.prompt };
}

export function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

export function expandEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandHome(v)]));
}

/** Finds an executable like `which`. Returns null when missing. */
export function resolveBin(bin: string, pathEnv: string): string | null {
  const isFile = (p: string) => {
    try {
      if (!statSync(p).isFile()) return false;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes("/") || bin.includes("\\")) return isFile(bin) ? bin : null;
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Shown in the run log. The prompt is shortened; env is never logged. */
export function describeCommand(cmd: BuiltCommand): string {
  const quote = (a: string) => (/^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a.length > 120 ? `${a.slice(0, 117)}…` : a));
  return [cmd.bin, ...cmd.args].map(quote).join(" ") + (cmd.stdin ? "  < prompt on stdin" : "");
}
