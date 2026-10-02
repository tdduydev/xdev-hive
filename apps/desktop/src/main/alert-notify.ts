// Thông báo hệ điều hành cho admin hub khi hub mở cảnh báo (roadmap 22m-2). The hub keeps the alerts (apps/web/src/alerts.ts);
// the app of a hub admin asks for them about once a minute, riding on the heartbeat, and shows the new ones.
import type { HubAlert, Me } from "@xdev-hive/core";
import type { MessageKey } from "@xdev-hive/ui/i18n";

/** Alerts opened this long before the app first asked are still new: a restart right after one does not lose it. */
const GRACE_MS = 10 * 60_000;
/** More new alerts at once than this become one notification: a hub coming back after an outage would flood otherwise. */
export const MAX_SINGLE = 3;
const EVERY_MS = 60_000;
/** Who the token is changes rarely (an admin granting or taking away), so it is asked again only this often. */
const ME_EVERY_MS = 10 * 60_000;

export type AlertNotice = { kind: "one"; alert: HubAlert } | { kind: "many"; alerts: HubAlert[] };

export interface AlertWatchOptions {
  me: () => Promise<Me>;
  list: () => Promise<{ open: HubAlert[] }>;
  notify: (notice: AlertNotice) => void;
  now?: () => number;
}

/** Only a hub admin may read alerts.list; a restricted account is not one even with the admin role. */
export const isHubAdmin = (me: Me): boolean => me.mode === "hub" && me.role === "admin" && !me.access;

export class AlertWatch {
  readonly #opts: AlertWatchOptions;
  readonly #now: () => number;
  /** Ids already shown or already there when the app first asked. A reopened alert gets a new id, so it shows again. */
  readonly #seen = new Set<number>();
  #startedAt: number | null = null;
  #checkedAt = -Infinity;
  #admin: { value: boolean; at: number } | null = null;
  #busy = false;

  constructor(opts: AlertWatchOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  /** Called on every heartbeat; asks the hub at most once a minute. Errors wait for the next tick. */
  async tick(): Promise<AlertNotice[]> {
    const now = this.#now();
    if (this.#busy || now - this.#checkedAt < EVERY_MS) return [];
    this.#busy = true;
    this.#checkedAt = now;
    try {
      if (!this.#admin || now - this.#admin.at >= ME_EVERY_MS) this.#admin = { value: isHubAdmin(await this.#opts.me()), at: now };
      if (!this.#admin.value) return [];
      const notices = this.#take((await this.#opts.list()).open, now);
      for (const n of notices) this.#opts.notify(n);
      return notices;
    } catch {
      return [];
    } finally {
      this.#busy = false;
    }
  }

  /** Signed in to another hub or as someone else: start over, as after a restart. */
  reset(): void {
    this.#seen.clear();
    this.#startedAt = null;
    this.#checkedAt = -Infinity;
    this.#admin = null;
  }

  #take(open: HubAlert[], now: number): AlertNotice[] {
    this.#startedAt ??= now;
    const fresh = open.filter((a) => {
      if (this.#seen.has(a.id)) return false;
      this.#seen.add(a.id);
      // An admin already saw it on the web, or it was open long before this app asked: no need to interrupt.
      return !a.ackedBy && Date.parse(a.openedAt) >= this.#startedAt! - GRACE_MS;
    });
    if (fresh.length > MAX_SINGLE) return [{ kind: "many", alerts: fresh }];
    return fresh.map((alert) => ({ kind: "one", alert }));
  }
}

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The notification's words, as the webhook says them (apps/web/src/webhooks.ts), with times in this machine's zone. */
export function noticeText(tr: Tr, n: AlertNotice, time: (iso: string) => string): { title: string; body: string } {
  const vars = (a: HubAlert) => {
    const out: Record<string, string | number> = { ...a.vars };
    for (const k of ["since", "until"]) if (typeof out[k] === "string") out[k] = time(String(out[k]));
    return out;
  };
  const title = (a: HubAlert) => tr(`alerts.title.${a.rule}` as MessageKey, vars(a));
  if (n.kind === "one") {
    const a = n.alert;
    return { title: tr("desktop.hubAlertTitle", { severity: tr(`alerts.severity.${a.severity}` as MessageKey), title: title(a) }), body: tr(`alerts.detail.${a.rule}` as MessageKey, vars(a)) };
  }
  return { title: tr("desktop.hubAlertsTitle", { count: n.alerts.length }), body: tr("desktop.hubAlertsBody", { titles: n.alerts.slice(0, 5).map(title).join("; ") }) };
}

/** alerts.list is the web server's own method (not in core's typed list), so it is asked for over plain RPC. */
export async function fetchAlerts(hub: { url: string; token: string }, fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<{ open: HubAlert[] }> {
  const res = await fetchFn(`${hub.url}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hub.token}`, "x-hive-agent": "desktop" },
    body: JSON.stringify({ method: "alerts.list", input: {} }),
  });
  const body = (await res.json().catch(() => null)) as { result?: { open?: HubAlert[] } } | null;
  if (!res.ok || !Array.isArray(body?.result?.open)) throw new Error(`alerts.list: HTTP ${res.status}`);
  return { open: body.result.open };
}
