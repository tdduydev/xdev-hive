// The desktop app's menu and addresses on a hub (roadmap 76h, docs/specs/76-access-first.md §5 step 2): this machine's
// work only. Everything else (Task, Tài liệu, Chat, Quản trị…) is the hub's web, one button away. Free of React so a
// test can read it.
import type { MessageKey } from "@xdev-hive/ui";

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
