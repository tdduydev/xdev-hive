import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError, ROLES, type Role, type TokenInfo } from "@xdev-hive/core";

const NAME = /^[\w.@-]{1,60}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown>;
const toInfo = (r: Row): TokenInfo => ({
  id: String(r.id),
  name: String(r.name),
  role: r.role as Role,
  createdAt: String(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : String(r.last_used_at),
});

/** API tokens for people and agents. Only the SHA-256 is stored; the plaintext is shown once at creation. */
export class TokenStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_tokens(
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT)`);
  }

  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_tokens").get() as Row).n);
  }

  create(name: string, role: Role): { token: string; info: TokenInfo } {
    const token = `hive_${randomBytes(32).toString("base64url")}`;
    return { token, info: this.#insert(token, name, role) };
  }

  /** Registers a token chosen by the operator (HIVE_BOOTSTRAP_TOKEN). No-op if it already exists. */
  ensure(token: string, name: string, role: Role): void {
    if (token.length < 32) throw new Error("HIVE_BOOTSTRAP_TOKEN must be at least 32 characters");
    if (!this.#db.prepare("SELECT 1 FROM hub_tokens WHERE hash = ?").get(sha256(token))) this.#insert(token, name, role);
  }

  verify(token: string): { name: string; role: Role } | null {
    const row = this.#db.prepare("SELECT * FROM hub_tokens WHERE hash = ?").get(sha256(token)) as Row | undefined;
    if (!row) return null;
    const now = new Date();
    const last = row.last_used_at ? Date.parse(String(row.last_used_at)) : 0;
    if (now.getTime() - last > 60_000) {
      this.#db.prepare("UPDATE hub_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), String(row.id));
    }
    return { name: String(row.name), role: row.role as Role };
  }

  list(): TokenInfo[] {
    return (this.#db.prepare("SELECT * FROM hub_tokens ORDER BY created_at").all() as Row[]).map(toInfo);
  }

  revoke(id: string): void {
    const row = this.#db.prepare("SELECT role FROM hub_tokens WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", "Token not found.");
    const admins = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_tokens WHERE role = 'admin'").get() as Row).n);
    if (row.role === "admin" && admins <= 1) throw new HiveError("bad_request", "Cannot revoke the last admin token.");
    this.#db.prepare("DELETE FROM hub_tokens WHERE id = ?").run(id);
  }

  #insert(token: string, name: string, role: Role): TokenInfo {
    if (!NAME.test(name)) throw new HiveError("bad_request", "Token name: 1-60 chars of letters, digits, . _ @ -");
    if (!ROLES.includes(role)) throw new HiveError("bad_request", `Role must be one of ${ROLES.join(", ")}`);
    const id = randomBytes(6).toString("hex");
    this.#db
      .prepare("INSERT INTO hub_tokens(id, hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, sha256(token), name, role, new Date().toISOString());
    return toInfo(this.#db.prepare("SELECT * FROM hub_tokens WHERE id = ?").get(id) as Row);
  }
}
