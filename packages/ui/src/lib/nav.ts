// The web's menu by job (roadmap 49b, docs/specs/49-ux-roles.md "Menu mới"): which entries and which tabs a person
// sees, from the same permissions the hub checks. Free of React so a test can read it; App.tsx and the tabbed pages
// draw what it returns. The desktop app has menus of its own (35a/44, 39f) and never reads this.
import { may, type Me, type Permission } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";
import type { MessageKey } from "#ui/i18n/translate.ts";
import { contextProjects } from "./permission-controls.ts";

export type WebPage =
  | "today"
  | "chat"
  | "graph"
  | "features"
  | "tasks"
  | "runs"
  | "docs"
  | "skills"
  | "memory"
  | "proposals"
  | "settings"
  | "pipeline"
  | "machines"
  | "admin";

/**
 * The menu in the order of the work: what waits for you, then the work from a feature to its runs, then what agents
 * read, then the project's settings, the machines and the hub's administration, each out of the main path.
 * Knowledge proposals live on their content pages (49f).
 */
export const WEB_MENU: Array<{ label: MessageKey | null; ids: WebPage[] }> = [
  { label: null, ids: ["today", "chat"] },
  { label: "nav.groupDoing", ids: ["graph", "features", "tasks", "runs"] },
  { label: "nav.groupKnowledge", ids: ["docs", "skills", "memory"] },
  { label: "nav.groupProject", ids: ["pipeline", "settings"] },
  { label: "nav.groupMachines", ids: ["machines"] },
  { label: "nav.groupHubAdmin", ids: ["admin"] },
];

/** ⌘1–5 on the web: Hôm nay, Chat, Task, Agent đang chạy, Tài liệu, the pages of a working day. */
export const WEB_SHORTCUTS: Partial<Record<WebPage, string>> = { today: "1", chat: "2", tasks: "3", runs: "4", docs: "5" };

/** What this hub's client can do: an older hub lacks some of these, and their tabs stay hidden then. */
export interface WebCaps {
  users: boolean;
  members: boolean;
  alerts: boolean;
  webhooks: boolean;
  releases: boolean;
  hub: boolean;
}

export const webCaps = (client: HiveClient): WebCaps => ({
  users: !!client.users,
  members: !!client.members,
  alerts: !!client.alerts,
  webhooks: !!client.webhooks,
  releases: !!client.releases,
  hub: !!client.hub,
});

export const isHubAdmin =(me: Me): boolean => me.mode === "hub" && me.role === "admin" && !me.access;

/** Whether the person may `need` somewhere: in the shared data or in one of the projects they see. */
const anywhere = (me: Me, projects: string[], need: Permission): boolean => may(me, null, need) || projects.some((p) => may(me, p, need));

export type SettingsTab = "policy" | "agent" | "tools" | "context" | "leader" | "members" | "systems";
/**
 * Cài đặt dự án gathers the cards a project's settings had in six places (spec 49, "Tech lead"), as they are. Chốt &
 * chính sách is the hub admin's whole policy page, a lead's own rows; Context agent follows contextEdit (49a).
 */
export function settingsTabs(me: Me, projects: string[], caps: Pick<WebCaps, "members">): SettingsTab[] {
  const admin = isHubAdmin(me);
  const settings = admin || projects.some((p) => may(me, p, "projectSettings"));
  const members = admin || anywhere(me, projects, "membersManage");
  if (!settings && !members) return [];
  const tabs: SettingsTab[] = [];
  if (settings) tabs.push("policy", "agent", "tools");
  if (admin || contextProjects(me, projects).length) tabs.push("context");
  if (settings) tabs.push("leader");
  if (members && caps.members) tabs.push("members");
  tabs.push("systems");
  return tabs;
}

export type MachineTab = "map" | "quota" | "fleet" | "queue" | "costs";
/** Máy & agent: the agent map for everyone who sees a project; the fleet, queue and costs read every machine, so admin. */
export const machineTabs = (me: Me): MachineTab[] => (isHubAdmin(me) ? ["map", "quota", "fleet", "queue", "costs"] : ["map", "quota"]);

export type AdminTab = "ops" | "users" | "policy" | "tools" | "budgets" | "alerts" | "audit" | "webhooks" | "versions" | "hub";
/** Quản trị: one entry, a tab per job of the hub admin. */
export function adminTabs(caps: WebCaps): AdminTab[] {
  const tabs: AdminTab[] = ["ops"];
  if (caps.users) tabs.push("users");
  tabs.push("policy", "tools", "budgets");
  if (caps.alerts) tabs.push("alerts");
  tabs.push("audit");
  if (caps.webhooks) tabs.push("webhooks");
  if (caps.releases) tabs.push("versions");
  if (caps.hub) tabs.push("hub");
  return tabs;
}

/** The tab an address asks for, or the first one the person has. */
export const pickTab = <T extends string>(tabs: readonly T[], wanted: string | null): T | undefined =>
  tabs.find((tab) => tab === wanted) ?? tabs[0];

/** The entries of the web menu this person sees (the hub's web: `me.mode` is "hub"). */
export function webPages(me: Me, projects: string[], caps: WebCaps): Set<WebPage> {
  const admin = isHubAdmin(me);
  const ids = new Set<WebPage>(["today", "features", "tasks", "docs", "skills", "memory"]);
  const viewer = me.role === "admin" || projects.some((p) => may(me, p, "view"));
  if (viewer) ids.add("graph");
  if (me.mode === "hub") {
    ids.add("runs");
    ids.add("machines");
    if (admin || anywhere(me, projects, "chatUse")) ids.add("chat");
  }
  if (viewer) ids.add("pipeline");
  if (settingsTabs(me, projects, caps).length) ids.add("settings");
  if (admin) ids.add("admin");
  return ids;
}
