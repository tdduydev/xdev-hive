import { HUB_SCOPE, type Machine, type RunRecord, type Task } from "@xdev-hive/core";

export const CHAT_SHORTCUTS = ["assign", "research", "status", "release", "cancel", "retry"] as const;
export type ChatShortcut = (typeof CHAT_SHORTCUTS)[number];

/** Only the first word is a command; a slash in prose must not open the picker. */
export function matchingShortcuts(text: string): ChatShortcut[] {
  const match = /^\/([a-z]*)$/i.exec(text);
  return match ? CHAT_SHORTCUTS.filter(command => command.startsWith(match[1]!.toLowerCase())) : [];
}

export function isStatusCommand(text: string): boolean {
  const request = text.trim().replace(/^\[[^\n]*\]\(#\/[^\n]*\)(?: · service: [^\n]+)?\n\n/, "");
  return /^\/status(?:\s|$)/i.test(request);
}

/** Chip clicks keep a person's existing description in the editable draft. */
export function shortcutDraft(template: string, text: string): string {
  return /^\/[a-z]*$/i.test(text.trim()) || !text.trim() ? template : `${template}\n${text}`;
}

export function chatStatusCounts(tasks: Task[], machines: Machine[], project: string) {
  const work = tasks.filter(task => project === HUB_SCOPE || task.project === project);
  return {
    done: work.filter(task => task.status === "done").length,
    review: work.filter(task => task.status === "review").length,
    blocked: work.filter(task => task.status === "blocked").length,
    running: machines.filter(machine => machine.online && !machine.duplicate).reduce((count, machine) => count + machine.runs.filter(run => run.status === "running" && (project === HUB_SCOPE || run.project === project)).length, 0),
  };
}


export function shortcutArgument(text: string): { command: ChatShortcut; query: string } | null {
  const match = /^\/(assign|research|cancel|retry)[ \t]+([^\n]*)/i.exec(text);
  if (!match) return null;
  const query = match[2]!.trim();
  return { command: match[1]!.toLowerCase() as ChatShortcut, query: /^\[[^\]]*\]$/.test(query) ? "" : query };
}

export function fillShortcutArgument(text: string, value: string): string {
  return text.replace(/^(\/\w+)[ \t]+[^\n]*/, (_match, command: string) => `${command} ${value}`);
}

/** Include the machine identity: two machines can report the same run ID. */
export function shortcutRuns(runs: RunRecord[], command: ChatShortcut, project: string, query: string) {
  return runs.filter(run => (project === HUB_SCOPE || run.project === project)
    && (command === "cancel" ? run.status === "running" && !run.cancelRequestedAt : ["failed", "rate_limited"].includes(run.status))
    && `${run.machineId}/${run.runId} ${run.taskId} ${run.taskTitle}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
}
