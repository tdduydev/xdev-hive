// Chat webhooks (Teams Workflows, Slack) for hub events: a proposal waiting for review, memory waiting
// for approval, an install request and how it ended. A webhook URL carries its own secret: it is stored
// here and never sent back to a browser in full, and send errors never quote it.
import type { DatabaseSync } from "node:sqlite";
import {
  HiveError,
  PROJECT_NAME,
  WEBHOOK_EVENTS,
  WEBHOOK_KINDS,
  type HiveEvent,
  type WebhookEvent,
  type WebhookInfo,
  type WebhookInput,
  type WebhookKind,
} from "@xdev-hive/core";
import { isLocale, translate, type MessageKey } from "@xdev-hive/ui/i18n";

type Row = Record<string, unknown>;
type Stored = WebhookInfo & { url: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https only, except a local receiver (tests, a relay on the same host). */
function checkUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HiveError("bad_request", "Webhook URL is not a URL.", { key: "errors.webhookUrl" });
  }
  const local = u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
  if ((u.protocol !== "https:" && !local) || url.length > 2000 || u.username || u.password) {
    throw new HiveError("bad_request", "Webhook URL must be https.", { key: "errors.webhookUrl" });
  }
  return u;
}

export function urlHint(url: string): string {
  const u = new URL(url);
  const tail = `${u.pathname}${u.search}`.slice(-4);
  return `${u.protocol}//${u.host}/…${tail}`;
}

const toInfo = (r: Row): Stored => ({
  id: Number(r.id),
  name: String(r.name),
  kind: String(r.kind) as WebhookKind,
  url: String(r.url),
  urlHint: urlHint(String(r.url)),
  events: JSON.parse(String(r.events)) as WebhookEvent[],
  projects: JSON.parse(String(r.projects)) as string[],
  locale: String(r.locale),
  enabled: Number(r.enabled) === 1,
  createdAt: String(r.created_at),
  lastSentAt: r.last_sent_at == null ? null : String(r.last_sent_at),
  lastError: r.last_error == null ? null : String(r.last_error),
});

const publicInfo = ({ url: _url, ...info }: Stored): WebhookInfo => info;

export class WebhookStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_webhooks(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL,
      projects TEXT NOT NULL DEFAULT '[]', locale TEXT NOT NULL DEFAULT 'vi', enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_sent_at TEXT, last_error TEXT)`);
  }

  list(): WebhookInfo[] {
    return (this.#db.prepare("SELECT * FROM hub_webhooks ORDER BY id").all() as Row[]).map((r) => publicInfo(toInfo(r)));
  }

  /** With the URL: for sending only. */
  all(): Stored[] {
    return (this.#db.prepare("SELECT * FROM hub_webhooks ORDER BY id").all() as Row[]).map(toInfo);
  }

  get(id: number): Stored | null {
    const row = this.#db.prepare("SELECT * FROM hub_webhooks WHERE id = ?").get(id) as Row | undefined;
    return row ? toInfo(row) : null;
  }

  save(input: WebhookInput, now = new Date()): WebhookInfo {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80) throw new HiveError("bad_request", "Webhook name: 1–80 characters.", { key: "errors.webhookName" });
    if (!WEBHOOK_KINDS.includes(input.kind)) throw new HiveError("bad_request", `Unknown webhook kind ${String(input.kind)}.`, { key: "errors.webhookKind" });
    const events = [...new Set(input.events ?? [])];
    if (!events.length || events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
      throw new HiveError("bad_request", "Pick at least one known event.", { key: "errors.webhookEvents" });
    }
    const projects = [...new Set(input.projects ?? [])];
    if (projects.length > 50 || projects.some((p) => !PROJECT_NAME.test(p))) {
      throw new HiveError("bad_request", "Invalid project in the webhook filter.", { key: "errors.webhookProjects" });
    }
    const locale = isLocale(input.locale) ? input.locale : "vi";
    const existing = input.id === undefined ? null : this.get(input.id);
    if (input.id !== undefined && !existing) throw new HiveError("not_found", `No webhook #${input.id}.`, { key: "errors.webhookNotFound", vars: { id: input.id } });
    const url = input.url?.trim() || existing?.url;
    if (!url) throw new HiveError("bad_request", "Webhook URL must be https.", { key: "errors.webhookUrl" });
    checkUrl(url);
    const values = [name, input.kind, url, JSON.stringify(events), JSON.stringify(projects), locale, input.enabled === false ? 0 : 1];
    if (existing) {
      // A new URL starts with a clean slate: the last error belonged to the old one.
      const reset = url !== existing.url;
      this.#db
        .prepare(
          `UPDATE hub_webhooks SET name = ?, kind = ?, url = ?, events = ?, projects = ?, locale = ?, enabled = ?${reset ? ", last_error = NULL, last_sent_at = NULL" : ""} WHERE id = ?`,
        )
        .run(...values, existing.id);
      return publicInfo(this.get(existing.id)!);
    }
    const res = this.#db
      .prepare("INSERT INTO hub_webhooks(name, kind, url, events, projects, locale, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...values, now.toISOString());
    return publicInfo(this.get(Number(res.lastInsertRowid))!);
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare("DELETE FROM hub_webhooks WHERE id = ?").run(id).changes) === 1;
  }

  record(id: number, error: string | null, at: Date): void {
    this.#db.prepare("UPDATE hub_webhooks SET last_sent_at = ?, last_error = ? WHERE id = ?").run(at.toISOString(), error, id);
  }
}

/** The message for an event, and the hub page it links to. */
export function eventMessage(event: HiveEvent, locale: string): { text: string; page: string } {
  const lang = isLocale(locale) ? locale : "vi";
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => translate(key, vars, lang);
  const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const where = (project: string | null) => project ?? tr("webhook.shared");
  switch (event.type) {
    case "proposal.created":
      return {
        text: tr("webhook.proposal", { doc: event.proposal.docKey, project: where(event.project), author: event.proposal.author, reason: clip(event.proposal.reason) }),
        page: "#/proposals",
      };
    case "memory.pending":
      return {
        text: tr("webhook.memoryPending", { project: where(event.project), author: event.memory.author, content: clip(event.memory.content) }),
        page: "#/memory",
      };
    case "command.requested":
      return { text: tr("webhook.commandRequested", { by: event.command.requestedBy, label: event.command.label, machine: event.command.machineId }), page: "#/admin" };
    case "command.finished":
      return {
        text: tr("webhook.commandFinished", {
          label: event.command.label,
          machine: event.command.machineId,
          status: tr(`commandStatus.${event.command.status}`),
        }),
        page: "#/admin",
      };
  }
}

/** The JSON each service takes: Slack's text message, a Teams Workflows Adaptive Card. */
export function webhookPayload(kind: WebhookKind, text: string, link: { title: string; url: string } | null): unknown {
  if (kind === "slack") return { text: link ? `${text}\n<${link.url}|${link.title}>` : text };
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text, wrap: true }],
          ...(link ? { actions: [{ type: "Action.OpenUrl", title: link.title, url: link.url }] } : {}),
        },
      },
    ],
  };
}

export interface DispatcherOptions {
  /** e.g. https://hive.example.com; null: messages carry no link. */
  publicUrl: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export class WebhookDispatcher {
  readonly #store: WebhookStore;
  readonly #opts: Required<DispatcherOptions>;

  constructor(store: WebhookStore, opts: DispatcherOptions) {
    this.#store = store;
    this.#opts = { fetch: globalThis.fetch, now: () => new Date(), timeoutMs: 10_000, ...opts };
  }

  /** Sends the event to every enabled webhook that wants it. Never throws; results land on each webhook. */
  async notify(event: HiveEvent): Promise<void> {
    const targets = this.#store
      .all()
      .filter((w) => w.enabled && w.events.includes(event.type) && (w.projects.length === 0 || (event.project !== null && w.projects.includes(event.project))));
    await Promise.all(
      targets.map((w) => {
        const { text, page } = eventMessage(event, w.locale);
        return this.#send(w, text, page);
      }),
    );
  }

  async test(id: number): Promise<{ ok: boolean; error: string | null }> {
    const w = this.#store.get(id);
    if (!w) throw new HiveError("not_found", `No webhook #${id}.`, { key: "errors.webhookNotFound", vars: { id } });
    const lang = isLocale(w.locale) ? w.locale : "vi";
    const error = await this.#send(w, translate("webhook.test", { name: w.name }, lang), "");
    return { ok: error === null, error };
  }

  async #send(w: Stored, text: string, page: string): Promise<string | null> {
    const lang = isLocale(w.locale) ? w.locale : "vi";
    const link = this.#opts.publicUrl ? { title: translate("webhook.open", undefined, lang), url: `${this.#opts.publicUrl.replace(/\/+$/, "")}/${page}` } : null;
    let error: string | null = null;
    try {
      const res = await this.#opts.fetch(w.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookPayload(w.kind, text, link)),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      // The message of a failed fetch can quote the URL: keep only its kind.
      error = (err as Error).name === "TimeoutError" ? "timeout" : "network error";
    }
    this.#store.record(w.id, error, this.#opts.now());
    return error;
  }
}
