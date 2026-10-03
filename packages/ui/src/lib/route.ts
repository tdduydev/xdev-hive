// Where an address goes. Pages move between menus from one roadmap item to the next, so every link written before
// the move still has to land somewhere sensible: this is the one table that says where. Free of React and of the
// page list itself (App.tsx owns that), so a test can read it.

/** The Web Admin's addresses before roadmap 35b (alerts, webhooks and old links still use them): its page here. */
export const ADMIN_ALIASES: Record<string, string> = {
  "": "ops",
  overview: "ops",
  chat: "chat",
  runs: "runs",
  queue: "queue",
  batches: "batches",
  fleet: "fleet",
  quota: "machines",
  costs: "costs",
  alerts: "alerts",
  review: "proposals",
  docs: "docs",
  read: "read",
  specs: "specs",
  context: "context",
  memory: "memory",
  skills: "skills",
  users: "users",
  projects: "systems",
  policy: "policy",
  tools: "tools",
  versions: "versions",
  tokens: "tokens",
  webhooks: "webhooks",
  audit: "audit",
  hub: "hub",
};

/** Pages merged into another one everywhere (roadmap 39f): Task opens on the board, so the board has no address. */
export const ALIASES: Record<string, string> = { board: "tasks" };

/**
 * The desktop app in local mode only (roadmap 39f): there Tool is a part of Dự án & công cụ, and Đợt chạy belongs to
 * the hub, so both addresses go to the page that took them over. On the web each is still a page of its own.
 */
export const LOCAL_ALIASES: Record<string, string> = { tools: "setup", batches: "runs" };

export interface Resolved {
  /** The page to show; null when the address names no page of ours (the caller opens its home). */
  id: string | null;
  /** The address to put in the bar in place of the one read; null leaves it alone. */
  hash: string | null;
}

/**
 * The page an address means. `isPage` says whether an id is a page in this app, `local` whether it is the desktop
 * app on its own machine (no hub), which has fewer pages and therefore more redirects.
 */
export function resolveHash(raw: string, opts: { local: boolean; isPage: (id: string) => boolean }): Resolved {
  const path = raw.replace(/^#\/?/, "");
  const id = path.split("?")[0]!;
  const query = path.includes("?") ? path.slice(path.indexOf("?")) : "";
  // A redirect keeps the query: #/board?task=T-1 opens that task on Task.
  const to = (page: string): Resolved => ({ id: page, hash: `#/${page}${query}` });
  // #/admin, #/admin/<page>?…: the page's own address now. Then the aliases, so an address that moved twice
  // (#/admin/tools → Tool → Dự án & công cụ on this machine) still ends on the page that holds it.
  const named = id === "admin" || id.startsWith("admin/") ? (ADMIN_ALIASES[id.slice("admin/".length)] ?? "ops") : id;
  const alias = (opts.local ? LOCAL_ALIASES[named] : undefined) ?? ALIASES[named];
  if (alias) return to(alias);
  if (named !== id) return to(named);
  return { id: opts.isPage(id) ? id : null, hash: null };
}
