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

/**
 * The web from roadmap 49b: the menu goes by job, so pages became tabs of Cài đặt dự án, Máy & agent, Quản trị and
 * Agent đang chạy. Each old address opens its tab (`?tab=`). Web only: the desktop app keeps its menu (35a/44, 39f).
 * Token is no alias: it is still a page, reached from the account menu.
 */
export const WEB_ALIASES: Record<string, string> = {
  ops: "admin?tab=ops",
  users: "admin?tab=users",
  alerts: "admin?tab=alerts",
  audit: "admin?tab=audit",
  webhooks: "admin?tab=webhooks",
  versions: "admin?tab=versions",
  hub: "admin?tab=hub",
  fleet: "machines?tab=fleet",
  queue: "machines?tab=queue",
  costs: "machines?tab=costs",
  policy: "settings?tab=policy",
  context: "settings?tab=context",
  members: "settings?tab=members",
  systems: "settings?tab=systems",
  tools: "settings?tab=tools",
  batches: "runs",
  // Roadmap 49d: Tính năng took the Spec page's place; a feature's link (?project=&dir=&branch=) opens it there.
  specs: "features",
};

export interface Resolved {
  /** The page to show; null when the address names no page of ours (the caller opens its home). */
  id: string | null;
  /** The address to put in the bar in place of the one read; null leaves it alone. */
  hash: string | null;
}

/**
 * The page an address means. `isPage` says whether an id is a page in this app, `local` whether it is the desktop
 * app on its own machine (no hub), which has fewer pages and therefore more redirects, `web` whether it is the hub's
 * web, whose menu (roadmap 49b) folded many pages into tabs.
 */
export function resolveHash(raw: string, opts: { local: boolean; web?: boolean; isPage: (id: string) => boolean }): Resolved {
  const path = raw.replace(/^#\/?/, "");
  if (opts.web && /^settings\?/.test(path) && new URLSearchParams(path.split("?")[1]).get("tab") === "sdlc") {
    const params = new URLSearchParams(path.split("?")[1]); params.delete("tab");
    return { id: "pipeline", hash: `#/pipeline${params.size ? `?${params}` : ""}` };
  }
  const id = path.split("?")[0]!;
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  // A redirect keeps the query: #/board?task=T-1 opens that task on Task, #/batches?group=3 that group on its tab.
  // The target's own tab wins over one the old address carried.
  const to = (target: string): Resolved => {
    const [page, own] = target.split("?") as [string, string | undefined];
    const params = new URLSearchParams(own ?? "");
    new URLSearchParams(query).forEach((v, k) => {
      if (!params.has(k)) params.append(k, v);
    });
    const q = params.toString();
    return { id: page, hash: `#/${page}${q ? `?${q}` : ""}` };
  };
  // On the web #/admin is Quản trị itself (roadmap 49b). Anywhere else, and #/admin/<page>?… everywhere, it is the
  // old Web Admin's address. Then the aliases, so an address that moved twice (#/admin/tools → Tool → Dự án & công cụ
  // on this machine, → Cài đặt dự án on the web) still ends on the page that holds it.
  if (opts.web && id === "admin") return { id: opts.isPage(id) ? id : null, hash: null };
  const named = id === "admin" || id.startsWith("admin/") ? (ADMIN_ALIASES[id.slice("admin/".length)] ?? "ops") : id;
  const alias = (opts.local ? LOCAL_ALIASES[named] : opts.web ? WEB_ALIASES[named] : undefined) ?? ALIASES[named];
  if (opts.web && named === "proposals") {
    const params = new URLSearchParams(query);
    const key = params.get("doc") ?? params.get("docKey") ?? "";
    return to(`${/^(org|project\/[^/]+)\/skills\//.test(key) || params.get("kind") === "skills" ? "skills" : "docs"}?tab=pending`);
  }
  if (alias) return to(alias);
  if (named !== id) return to(named);
  return { id: opts.isPage(id) ? id : null, hash: null };
}
