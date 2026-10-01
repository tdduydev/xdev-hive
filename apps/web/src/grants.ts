import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { intersectAccess, type Access, type Actor, type ChatSender, type Role } from "@xdev-hive/core";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A grant lives at most this long; it ends earlier with its reply. */
const GRANT_MINUTES = 30;

/**
 * How much a role may do, for the narrower of two: an agent token never approves (see access.ts), so it sits under
 * a member account even though both rank alike for method roles.
 */
const REACH: Record<Role, number> = { viewer: 0, agent: 1, member: 2, admin: 3 };

/** What both may do: the lower role, and per project the permissions both have (a project only one has is left out). */
export function narrowest(a: ChatSender | Actor, b: ChatSender | Actor): { role: Role; access?: Access } {
  const role = REACH[a.role] <= REACH[b.role] ? a.role : b.role;
  const access = intersectAccess(a.access, b.access);
  return access ? { role, access } : { role };
}

type Row = Record<string, unknown>;

/**
 * Short-lived hub tokens for the leader's MCP calls while it writes one chat reply (roadmap 17a). The leader acts
 * with the rights of the person who wrote the message, never more than the machine's own token; the token stops
 * working when the reply ends or after GRANT_MINUTES. Only the SHA-256 is stored.
 */
export class ChatGrants {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_chat_grants(
      hash TEXT PRIMARY KEY, reply_id INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, access TEXT,
      expires_at TEXT NOT NULL)`);
  }

  /** A new token for the reply; the one handed out before (the heartbeat sends a request until it starts) is dropped. */
  issue(replyId: number, sender: ChatSender, machine: Actor, now = new Date()): string {
    const token = `hivechat_${randomBytes(32).toString("base64url")}`;
    const { role, access } = narrowest(sender, machine);
    const expires = new Date(now.getTime() + GRANT_MINUTES * 60_000).toISOString();
    this.#db.prepare("DELETE FROM hub_chat_grants WHERE reply_id = ? OR expires_at < ?").run(replyId, now.toISOString());
    this.#db
      .prepare("INSERT INTO hub_chat_grants(hash, reply_id, name, role, access, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), replyId, `chat-${sender.name}`.replace(/[^\w.@-]/g, "_").slice(0, 60), role, access ? JSON.stringify(access) : null, expires);
    return token;
  }

  /** The rights of a grant and its reply, or null once it expired or its reply is no longer waiting or being written. */
  verify(token: string, now = new Date()): { name: string; role: Role; access?: Access; replyId: number } | null {
    if (!token.startsWith("hivechat_")) return null;
    const row = this.#db.prepare("SELECT * FROM hub_chat_grants WHERE hash = ?").get(sha256(token)) as Row | undefined;
    if (!row || String(row.expires_at) <= now.toISOString()) return null;
    const reply = this.#db.prepare("SELECT status FROM chat_messages WHERE id = ?").get(Number(row.reply_id)) as Row | undefined;
    if (!reply || (reply.status !== "pending" && reply.status !== "running")) return null;
    return {
      name: String(row.name),
      role: row.role as Role,
      ...(row.access == null ? {} : { access: JSON.parse(String(row.access)) as Access }),
      replyId: Number(row.reply_id),
    };
  }
}
