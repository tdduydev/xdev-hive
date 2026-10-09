// The desktop app's menu and addresses on a hub (roadmap 76h, docs/specs/76-access-first.md §5 step 2): this machine's
// work only. Everything else (Task, Tài liệu, Chat, Quản trị…) is the hub's web, one button away. Free of React so a
// test can read it.
import type { AgentProfileStatus, AgentRun, SetupReport, WorktreeReport } from "@xdev-hive/core";
import type { MessageKey } from "@xdev-hive/ui-kit/i18n";

export type DeskPage = "start" | "machine" | "agents" | "runs" | "worktrees" | "setup" | "settings";

/** The pages that are the machine's, in the order of the menu; "start" is the first-run guide and has no menu entry. */
export const DESK_MENU: DeskPage[] = ["machine", "agents", "runs", "worktrees", "setup", "settings"];
export const DESK_PAGES: DeskPage[] = ["start", ...DESK_MENU];
export const DESK_HOME: DeskPage = "machine";

/** ⌘1–6 follow the menu. */
export const DESK_SHORTCUTS: Partial<Record<DeskPage, string>> = Object.fromEntries(DESK_MENU.map((id, i) => [id, String(i + 1)]));

export const DESK_LABEL: Record<DeskPage, MessageKey> = {
  start: "start.title",
  machine: "desk.nav.machine",
  agents: "desk.nav.agents",
  runs: "desk.nav.runs",
  worktrees: "desk.nav.worktrees",
  setup: "desk.nav.setup",
  settings: "desk.nav.settings",
};
export const DESK_SUB: Record<DeskPage, MessageKey> = {
  start: "start.sub",
  machine: "desk.sub.machine",
  agents: "desk.sub.agents",
  runs: "desk.sub.runs",
  worktrees: "desk.sub.worktrees",
  setup: "desk.sub.setup",
  settings: "desk.sub.settings",
};

/**
 * Addresses written before the split keep working: the machine's Hôm nay and Board are gone (the web has them), so
 * #/today lands on Máy này; Dự án & kết nối became Cài đặt máy and Tool a part of Công cụ & setup.
 */
export const DESK_ALIASES: Record<string, DeskPage> = { today: "machine", projects: "settings", tools: "setup" };

/** The entries that open the hub's web (the page is the web's, here only a button). */
export const WEB_ENTRIES: Array<{ id: string; label: MessageKey; hash: string }> = [
  { id: "today", label: "nav.today", hash: "#/today" },
  { id: "tasks", label: "nav.tasks", hash: "#/tasks" },
  { id: "chat", label: "nav.chat", hash: "#/chat" },
  { id: "docs", label: "nav.docs", hash: "#/docs" },
  { id: "admin", label: "nav.admin", hash: "#/admin" },
];

const pageOf = (hash: string): string => hash.replace(/^#\/?/, "").split(/[?/]/)[0]!;

/** The machine's page an address means; null for an address that names no page of the app. */
export function resolveDeskHash(hash: string): DeskPage | null {
  const id = pageOf(hash);
  if (id === "") return DESK_HOME;
  const alias = DESK_ALIASES[id];
  if (alias) return alias;
  return (DESK_PAGES as string[]).includes(id) ? (id as DeskPage) : null;
}

/** Where the hub's web is for an address that is not the machine's: the same `#/…` on the hub; null when it is ours or the hub is unknown. */
export function webTarget(hubUrl: string | null, hash: string): string | null {
  if (!hubUrl || !hash.startsWith("#/") || resolveDeskHash(hash)) return null;
  return `${hubUrl.replace(/\/+$/, "")}/${hash}`;
}

/**
 * Whether the app opened without naming a place (no address, or the old Hôm nay), so a first run may open the guide.
 * An explicit address (a browser sign-in comes back to one) keeps its destination.
 */
export const opensOnHome = (initialHash: string, currentHash: string): boolean =>
  ["", "#", "#/", "#/today"].includes(initialHash) && resolveDeskHash(currentHash) === DESK_HOME;

export type DeskSearchGroup = "runs" | "worktrees" | "agents" | "tools";
export interface DeskSearchRow {
  group: DeskSearchGroup;
  id: string;
  label: string;
  hint?: string;
  hash: string;
}

/**
 * What ⌘K searches in the app: the things this machine has. The web's palette searches tasks and docs, which the app
 * no longer shows (its Task and Tài liệu open on the web).
 */
export function deskSearchRows(input: {
  runs?: AgentRun[] | null;
  worktrees?: WorktreeReport | null;
  agents?: AgentProfileStatus[] | null;
  setup?: SetupReport | null;
}): DeskSearchRow[] {
  const rows: DeskSearchRow[] = [];
  for (const run of input.runs ?? []) {
    rows.push({ group: "runs", id: `run:${run.id}`, label: `${run.taskId} · ${run.project}`, hint: run.status, hash: `#/runs?run=${encodeURIComponent(run.id)}` });
  }
  for (const w of input.worktrees?.entries ?? []) {
    rows.push({ group: "worktrees", id: `worktree:${w.path}`, label: `${w.taskId || w.branch} · ${w.project}`, hint: w.branch, hash: "#/worktrees" });
  }
  for (const p of input.agents ?? []) {
    rows.push({ group: "agents", id: `agent:${p.id}`, label: p.label, hint: p.kind, hash: "#/agents" });
  }
  const setup = input.setup;
  if (setup) {
    for (const item of setup.machine) rows.push({ group: "tools", id: `tool:${item.id}`, label: item.label, hint: item.detail, hash: "#/setup" });
    for (const p of setup.projects) {
      for (const item of p.items) rows.push({ group: "tools", id: `tool:${p.project}:${item.id}`, label: item.label, hint: p.project, hash: "#/setup" });
    }
  }
  return rows;
}
