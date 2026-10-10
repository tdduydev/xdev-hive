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

  verify(token: string): { id: string; name: string; role: Role; ownerId: string | null; run?: { project: string; task: string; run: string; machine: string; readOnly: boolean }; mcp?: { project: string | null; system: string | null } } | null {
    const scoped = this.#db.prepare(`SELECT r.*, p.name, p.owner_id FROM run_credentials r
      JOIN hub_tokens p ON p.id = r.parent_id
      JOIN machines m ON m.id = 'runner.' || r.machine || '@' || p.name AND m.token_id = p.id
      WHERE r.hash = ? AND r.expires_at > ?`).get(sha256(token), new Date().toISOString()) as Row | undefined;
    if (scoped) return {
      id: String(scoped.parent_id), name: String(scoped.name), role: scoped.read_only ? "viewer" : "agent",
      ownerId: scoped.owner_id == null ? null : String(scoped.owner_id),
      run: { project: String(scoped.project), task: String(scoped.task), run: String(scoped.run), machine: String(scoped.machine), readOnly: Boolean(scoped.read_only) },
    };
    const mcp = this.#db.prepare(`SELECT m.*, p.name, p.owner_id, p.role FROM mcp_credentials m
      JOIN hub_tokens p ON p.id = m.parent_id WHERE m.hash = ? AND m.expires_at > ?`).get(sha256(token), new Date().toISOString()) as Row | undefined;
    if (mcp) return {
      id: String(mcp.parent_id), name: String(mcp.name), role: mcp.read_only || mcp.role === "viewer" ? "viewer" : "agent",
      ownerId: mcp.owner_id == null ? null : String(mcp.owner_id),
      mcp: { project: mcp.project == null ? null : String(mcp.project), system: mcp.system == null ? null : String(mcp.system) },
    };
    const row = this.#db.prepare("SELECT * FROM hub_tokens WHERE hash = ?").get(sha256(token)) as Row | undefined;
    if (!row) return null;
    const now = new Date();
    const last = row.last_used_at ? Date.parse(String(row.last_used_at)) : 0;
    if (now.getTime() - last > 60_000) {
      this.#db.prepare("UPDATE hub_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), String(row.id));
    }
    return { id: String(row.id), name: String(row.name), role: row.role as Role, ownerId: row.owner_id == null ? null : String(row.owner_id) };
  }

  /**
   * Interactive MCP sessions also exchange the machine token, rather than use it for agent RPCs. `system`: a CLI opened
   * on a whole system (GROUP-cli) reaches that system's projects; project and system never come together.
   */
  issueMcp(parentToken: string, project: string | null, readOnly: boolean, system: string | null = null): string {
    const parent = this.#db.prepare("SELECT id, role FROM hub_tokens WHERE hash = ?").get(sha256(parentToken)) as Row | undefined;
    if (!parent) throw new HiveError("forbidden", "A machine credential is required.");
    const token = `hivemcp_${randomBytes(32).toString("base64url")}`;
    this.#db.prepare("DELETE FROM mcp_credentials WHERE expires_at <= ?").run(new Date().toISOString());
    this.#db.prepare("INSERT INTO mcp_credentials(hash, parent_id, project, system, expires_at, read_only) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), String(parent.id), project, system, new Date(Date.now() + 60 * 60_000).toISOString(), readOnly || parent.role === "viewer" ? 1 : 0);
    return token;
  }

  /** A new credential replaces an older one for this run; no plaintext is stored. */
  issueRun(parentToken: string, input: { machine: string; project: string; task: string; run: string; minutes: number; readOnly: boolean }): string {
    const parent = this.#db.prepare("SELECT id, name, role FROM hub_tokens WHERE hash = ?").get(sha256(parentToken)) as Row | undefined;
    if (!parent) throw new HiveError("forbidden", "Only a machine credential can issue run credentials.");
    const token = `hiverun_${randomBytes(32).toString("base64url")}`;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (parent.role === "viewer" || !this.#db.prepare("SELECT 1 FROM machines WHERE id = ? AND token_id = ?")
        .get(`runner.${input.machine}@${String(parent.name)}`, String(parent.id)))
        throw new HiveError("forbidden", "Only the paired machine token may issue run credentials.");
      this.#db.prepare("DELETE FROM run_credentials WHERE expires_at <= ?").run(new Date().toISOString());
      this.#db.prepare("DELETE FROM run_credentials WHERE parent_id = ? AND machine = ? AND run = ?").run(String(parent.id), input.machine, input.run);
      this.#db.prepare(`INSERT INTO run_credentials(hash, parent_id, machine, project, task, run, expires_at, read_only)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), String(parent.id), input.machine, input.project, input.task,
          input.run, new Date(Date.now() + input.minutes * 60_000).toISOString(), input.readOnly ? 1 : 0);
      this.#db.exec("COMMIT");
    } catch (err) { this.#db.exec("ROLLBACK"); throw err; }
    return token;
  }

  revokeRun(parentToken: string, machine: string, run: string): void {
    const parent = this.#db.prepare("SELECT id FROM hub_tokens WHERE hash = ?").get(sha256(parentToken)) as Row | undefined;
    if (!parent) throw new HiveError("forbidden", "Only a machine credential can revoke run credentials.");
    this.#db.prepare("DELETE FROM run_credentials WHERE parent_id = ? AND machine = ? AND run = ?").run(String(parent.id), machine, run);
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
    if (!row) throw new HiveError("not_found", "Token not found.", { key: "errors.tokenNotFound" });
    // Unowned admin tokens are the way back in when no account can sign in: keep the last one.
    const admins = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_tokens WHERE role = 'admin'").get() as Row).n);
    if (row.role === "admin" && admins <= 1 && row.owner_id == null) throw new HiveError("bad_request", "Cannot revoke the last admin token.", { key: "errors.lastAdminToken" });
    this.#db.prepare("DELETE FROM hub_tokens WHERE id = ?").run(id);
  }

  /** Revokes every token of an account (it was disabled). */
  revokeOwned(ownerId: string): number {
    return Number(this.#db.prepare("DELETE FROM hub_tokens WHERE owner_id = ?").run(ownerId).changes);
  }

  #insert(token: string, name: string, role: Role, ownerId: string | null): TokenInfo {
    if (!NAME.test(name)) throw new HiveError("bad_request", "Token name: 1-60 chars of letters, digits, . _ @ -", { key: "errors.badTokenName" });
    if (!TOKEN_ROLES.includes(role)) throw new HiveError("bad_request", `Role must be one of ${TOKEN_ROLES.join(", ")}`);
    const id = randomBytes(6).toString("hex");
    this.#db
      .prepare("INSERT INTO hub_tokens(id, hash, name, role, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, sha256(token), name, role, ownerId, new Date().toISOString());
    return toInfo(this.#db.prepare("SELECT * FROM hub_tokens WHERE id = ?").get(id) as Row);
  }
}
