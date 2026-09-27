import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError, TOKEN_ROLES, type Role, type TokenInfo } from "@xdev-hive/core";

const NAME = /^[\w.@-]{1,60}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown>;
const toInfo = (r: Row): TokenInfo => ({
  id: String(r.id),
  name: String(r.name),
  role: r.role as Role,
  ownerId: r.owner_id == null ? null : String(r.owner_id),
  createdAt: String(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : String(r.last_used_at),
});

/**
 * API tokens for agents, machines and CI. Only the SHA-256 is stored; the plaintext is shown once at creation.
 * A token of an account (owner) sees only what that account was granted; tokens of no account keep the old
 * role-only rules (they predate accounts, or are the bootstrap token).
 */
export class TokenStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_tokens(
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT)`);
    const columns = new Set((db.prepare("PRAGMA table_info(hub_tokens)").all() as Row[]).map((c) => String(c.name)));
    if (!columns.has("owner_id")) db.exec("ALTER TABLE hub_tokens ADD COLUMN owner_id TEXT");
  }

  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_tokens").get() as Row).n);
  }

  create(name: string, role: Role, ownerId: string | null = null): { token: string; info: TokenInfo } {
    const token = `hive_${randomBytes(32).toString("base64url")}`;
    return { token, info: this.#insert(token, name, role, ownerId) };
  }

  /** Registers a token chosen by the operator (HIVE_BOOTSTRAP_TOKEN). No-op if it already exists. */
  ensure(token: string, name: string, role: Role): void {
    if (token.length < 32) throw new Error("HIVE_BOOTSTRAP_TOKEN must be at least 32 characters");
    if (!this.#db.prepare("SELECT 1 FROM hub_tokens WHERE hash = ?").get(sha256(token))) this.#insert(token, name, role, null);
  }

  verify(token: string): { name: string; role: Role; ownerId: string | null } | null {
    const row = this.#db.prepare("SELECT * FROM hub_tokens WHERE hash = ?").get(sha256(token)) as Row | undefined;
    if (!row) return null;
    const now = new Date();
    const last = row.last_used_at ? Date.parse(String(row.last_used_at)) : 0;
    if (now.getTime() - last > 60_000) {
      this.#db.prepare("UPDATE hub_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), String(row.id));
    }
    return { name: String(row.name), role: row.role as Role, ownerId: row.owner_id == null ? null : String(row.owner_id) };
  }

  /** All tokens, or only those of one account. */
  list(ownerId?: string): TokenInfo[] {
    const rows =
      ownerId === undefined
        ? this.#db.prepare("SELECT * FROM hub_tokens ORDER BY created_at").all()
        : this.#db.prepare("SELECT * FROM hub_tokens WHERE owner_id = ? ORDER BY created_at").all(ownerId);
    return (rows as Row[]).map(toInfo);
  }

  get(id: string): TokenInfo | null {
    const row = this.#db.prepare("SELECT * FROM hub_tokens WHERE id = ?").get(id) as Row | undefined;
    return row ? toInfo(row) : null;
  }

  revoke(id: string): void {
    const row = this.#db.prepare("SELECT role, owner_id FROM hub_tokens WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", "Token not found.");
    // Unowned admin tokens are the way back in when no account can sign in: keep the last one.
    const admins = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_tokens WHERE role = 'admin'").get() as Row).n);
    if (row.role === "admin" && admins <= 1 && row.owner_id == null) throw new HiveError("bad_request", "Cannot revoke the last admin token.");
    this.#db.prepare("DELETE FROM hub_tokens WHERE id = ?").run(id);
  }

  /** Revokes every token of an account (it was disabled). */
  revokeOwned(ownerId: string): number {
    return Number(this.#db.prepare("DELETE FROM hub_tokens WHERE owner_id = ?").run(ownerId).changes);
  }

  #insert(token: string, name: string, role: Role, ownerId: string | null): TokenInfo {
    if (!NAME.test(name)) throw new HiveError("bad_request", "Token name: 1-60 chars of letters, digits, . _ @ -");
    if (!TOKEN_ROLES.includes(role)) throw new HiveError("bad_request", `Role must be one of ${TOKEN_ROLES.join(", ")}`);
    const id = randomBytes(6).toString("hex");
    this.#db
      .prepare("INSERT INTO hub_tokens(id, hash, name, role, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, sha256(token), name, role, ownerId, new Date().toISOString());
    return toInfo(this.#db.prepare("SELECT * FROM hub_tokens WHERE id = ?").get(id) as Row);
  }
}
