// Hub accounts: username + password (or an OpenID Connect identity), per-project grants, browser sessions.
// A grant is a role or the permissions picked one by one (roadmap 25); the shared data's grant is the row of project "*".
// Passwords: scrypt with a random salt. Sessions: random token in an HttpOnly cookie, only its SHA-256 is stored.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError, PROJECT_NAME, readGrant, type Access, type Grant, type HubUser } from "@xdev-hive/core";
import type { OidcIdentity } from "./oidc.ts";

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,39}$/;
export const MIN_PASSWORD = 10;
const SESSION_DAYS = 14;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

type Row = Record<string, unknown>;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type UserInfo = HubUser;

/** The project key the shared data's grant is stored under: no project can be called that. */
const SHARED_ROW = "*";

/** A grant as the admin page or a project lead sent it, or a bad_request naming what is wrong. */
function checkGrant(raw: unknown, where: string): Grant {
  const grant = readGrant(raw);
  if (grant === null) throw new HiveError("bad_request", `Quyền không hợp lệ cho ${where}: ${JSON.stringify(raw)}`, { key: "errors.badGrant", vars: { project: where } });
  return grant;
}

/** As stored: a role in level, or "custom" with the permissions as JSON. */
const toRow = (g: Grant): { level: string; permissions: string | null } => (typeof g === "string" ? { level: g, permissions: null } : { level: "custom", permissions: JSON.stringify(g.permissions) });
const fromRow = (r: Row): Grant | null => readGrant(String(r.level) === "custom" ? { permissions: JSON.parse(String(r.permissions ?? "[]")) as unknown } : r.level);

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(actual, expected);
}

/** Compared against when the username is unknown, so a miss costs the same time as a wrong password. */
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

/** Readable temporary password (no 0/O/1/l), shown once to the admin. */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export function checkNewPassword(password: string, username: string): void {
  if (password.length < MIN_PASSWORD) throw new HiveError("bad_request", `Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`, { key: "errors.passwordTooShort", vars: { min: MIN_PASSWORD } });
  if (password.toLowerCase().includes(username.toLowerCase())) throw new HiveError("bad_request", "Mật khẩu không được chứa tên đăng nhập.", { key: "errors.passwordHasUsername" });
}

export class UserStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_users(
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_login_at TEXT);
    CREATE TABLE IF NOT EXISTS hub_grants(
      user_id TEXT NOT NULL, project TEXT NOT NULL, level TEXT NOT NULL, PRIMARY KEY(user_id, project));
    CREATE TABLE IF NOT EXISTS hub_sessions(
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_identities(
      issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(issuer, subject));
    CREATE INDEX IF NOT EXISTS hub_identities_user ON hub_identities(user_id);`);
    // Roadmap 25: the permissions of a "custom" grant.
    const columns = (db.prepare("PRAGMA table_info(hub_grants)").all() as Row[]).map((c) => String(c.name));
    if (!columns.includes("permissions")) db.exec("ALTER TABLE hub_grants ADD COLUMN permissions TEXT");
  }

  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_users").get() as Row).n);
  }

  #info(r: Row): UserInfo {
    const rows = this.#db.prepare("SELECT project, level, permissions FROM hub_grants WHERE user_id = ? ORDER BY project").all(String(r.id)) as Row[];
    const grants: Record<string, Grant> = {};
    let shared: Grant | null = null;
    for (const g of rows) {
      const grant = fromRow(g);
      if (grant === null) continue;
      if (String(g.project) === SHARED_ROW) shared = grant;
      else grants[String(g.project)] = grant;
    }
    return {
      id: String(r.id),
      username: String(r.username),
      displayName: String(r.display_name),
      admin: Number(r.admin) === 1,
      disabled: Number(r.disabled) === 1,
      mustChangePassword: Number(r.must_change) === 1,
      createdAt: String(r.created_at),
      lastLoginAt: r.last_login_at == null ? null : String(r.last_login_at),
      grants,
      shared,
      sso: this.#db.prepare("SELECT 1 FROM hub_identities WHERE user_id = ?").get(String(r.id)) !== undefined,
    };
  }

  // ── OpenID Connect identities ─────────────────────────────────────────────

  /** The account an identity signs in to, whatever its state (the caller checks disabled). */
  byIdentity(id: Pick<OidcIdentity, "issuer" | "subject">): UserInfo | null {
    const row = this.#db.prepare("SELECT user_id FROM hub_identities WHERE issuer = ? AND subject = ?").get(id.issuer, id.subject) as Row | undefined;
    return row ? this.get(String(row.user_id)) : null;
  }

  /** Links an identity to an account (replacing the account's earlier one from the same provider). */
  linkIdentity(userId: string, id: OidcIdentity): UserInfo {
    this.#require(userId);
    const owner = this.byIdentity(id);
    if (owner && owner.id !== userId) {
      throw new HiveError("conflict", "Tài khoản này của nhà cung cấp đã gắn với một tài khoản hub khác.", { key: "errors.ssoLinkedElsewhere" });
    }
    this.#db.prepare("DELETE FROM hub_identities WHERE user_id = ? AND issuer = ?").run(userId, id.issuer);
    this.#db
      .prepare("INSERT INTO hub_identities(issuer, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id.issuer, id.subject, userId, id.email, new Date().toISOString());
    return this.get(userId)!;
  }

  /**
   * A new account for someone signing in through the provider the first time: not admin, no project,
   * and a password nobody knows (an admin can reset it when the person needs one, e.g. for the desktop app).
   */
  createFromIdentity(id: OidcIdentity): UserInfo {
    const base =
      (id.username ?? id.email?.split("@")[0] ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .slice(0, 36) || "user";
    const padded = base.length < 2 ? `${base}-user` : base;
    let username = padded;
    for (let n = 2; this.#db.prepare("SELECT 1 FROM hub_users WHERE username = ?").get(username); n++) username = `${padded}-${n}`;
    const userId = randomBytes(6).toString("hex");
    this.#db
      .prepare("INSERT INTO hub_users(id, username, display_name, password_hash, admin, must_change, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)")
      .run(userId, username, (id.name ?? username).slice(0, 80), hashPassword(randomBytes(24).toString("base64")), new Date().toISOString());
    return this.linkIdentity(userId, id);
  }

  /** Records a sign-in that did not go through verify() (SSO). */
  touchLogin(userId: string): void {
    this.#db.prepare("UPDATE hub_users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
  }

  get(id: string): UserInfo | null {
    const row = this.#db.prepare("SELECT * FROM hub_users WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#info(row) : null;
  }

  list(): UserInfo[] {
    return (this.#db.prepare("SELECT * FROM hub_users ORDER BY username").all() as Row[]).map((r) => this.#info(r));
  }

  /** Per-project access of a user; undefined for admins (unrestricted). */
  access(user: UserInfo): Access | undefined {
    return user.admin ? undefined : { projects: user.grants, ...(user.shared ? { shared: user.shared } : {}) };
  }

  /** New account with a temporary password the user must change at first sign-in. */
  create(input: { username: string; displayName?: string; admin?: boolean; password?: string }): { user: UserInfo; password: string } {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME.test(username)) throw new HiveError("bad_request", "Tên đăng nhập: 2-40 ký tự chữ thường, số, . _ -", { key: "errors.badUsername" });
    if (this.#db.prepare("SELECT 1 FROM hub_users WHERE username = ?").get(username)) throw new HiveError("conflict", `Đã có tài khoản ${username}.`, { key: "errors.usernameTaken", vars: { username } });
    const password = input.password ?? temporaryPassword();
    const id = randomBytes(6).toString("hex");
    this.#db
      .prepare("INSERT INTO hub_users(id, username, display_name, password_hash, admin, must_change, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(id, username, (input.displayName ?? "").trim().slice(0, 80) || username, hashPassword(password), input.admin ? 1 : 0, new Date().toISOString());
    return { user: this.get(id)!, password };
  }

  update(id: string, patch: { displayName?: string; admin?: boolean; disabled?: boolean }): UserInfo {
    const user = this.#require(id);
    const admin = patch.admin ?? user.admin;
    const disabled = patch.disabled ?? user.disabled;
    if (user.admin && (!admin || disabled) && this.#activeAdmins() <= 1) throw new HiveError("bad_request", "Phải còn ít nhất một admin đang hoạt động.", { key: "errors.lastAdmin" });
    this.#db
      .prepare("UPDATE hub_users SET display_name = ?, admin = ?, disabled = ? WHERE id = ?")
      .run((patch.displayName ?? user.displayName).trim().slice(0, 80) || user.username, admin ? 1 : 0, disabled ? 1 : 0, id);
    if (disabled) this.endSessions(id);
    return this.get(id)!;
  }

  /** Every grant of an account at once (the admin page); shared undefined keeps the shared data's grant as it is. */
  setGrants(id: string, grants: Record<string, unknown>, shared?: unknown): UserInfo {
    this.#require(id);
    const checked = Object.entries(grants).map(([project, raw]) => {
      if (!PROJECT_NAME.test(project)) throw new HiveError("bad_request", `Dự án không hợp lệ: ${project}`, { key: "errors.badProject", vars: { project } });
      return [project, checkGrant(raw, project)] as const;
    });
    const sharedGrant = shared === undefined || shared === null ? shared : checkGrant(shared, "Chung");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`DELETE FROM hub_grants WHERE user_id = ?${sharedGrant === undefined ? " AND project <> '*'" : ""}`).run(id);
      const insert = this.#db.prepare("INSERT INTO hub_grants(user_id, project, level, permissions) VALUES (?, ?, ?, ?)");
      for (const [project, grant] of checked) {
        const row = toRow(grant);
        insert.run(id, project, row.level, row.permissions);
      }
      if (sharedGrant) {
        const row = toRow(sharedGrant);
        insert.run(id, SHARED_ROW, row.level, row.permissions);
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return this.get(id)!;
  }

  /** One grant (a project lead's Thành viên page): project null is the shared data; grant null takes the account out. */
  setGrant(id: string, project: string | null, raw: unknown): UserInfo {
    this.#require(id);
    if (project !== null && !PROJECT_NAME.test(project)) throw new HiveError("bad_request", `Dự án không hợp lệ: ${project}`, { key: "errors.badProject", vars: { project } });
    const key = project ?? SHARED_ROW;
    if (raw === null) {
      this.#db.prepare("DELETE FROM hub_grants WHERE user_id = ? AND project = ?").run(id, key);
    } else {
      const row = toRow(checkGrant(raw, project ?? "Chung"));
      this.#db
        .prepare("INSERT INTO hub_grants(user_id, project, level, permissions) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, project) DO UPDATE SET level = excluded.level, permissions = excluded.permissions")
        .run(id, key, row.level, row.permissions);
    }
    return this.get(id)!;
  }

  /** New temporary password; signs the user out everywhere. */
  resetPassword(id: string): string {
    this.#require(id);
    const password = temporaryPassword();
    this.#db.prepare("UPDATE hub_users SET password_hash = ?, must_change = 1 WHERE id = ?").run(hashPassword(password), id);
    this.endSessions(id);
    return password;
  }

  /** The account if username and password match and it is enabled; null otherwise (same cost either way). */
  verify(username: string, password: string): UserInfo | null {
    const row = this.#db.prepare("SELECT * FROM hub_users WHERE username = ?").get(username.trim().toLowerCase()) as Row | undefined;
    const ok = checkPassword(password, row ? String(row.password_hash) : DUMMY_HASH);
    if (!row || !ok || Number(row.disabled) === 1) return null;
    this.#db.prepare("UPDATE hub_users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), String(row.id));
    return this.#info(row);
  }

  changePassword(id: string, current: string, next: string): UserInfo {
    const row = this.#db.prepare("SELECT * FROM hub_users WHERE id = ?").get(id) as Row | undefined;
    if (!row || !checkPassword(current, String(row.password_hash))) throw new HiveError("forbidden", "Mật khẩu hiện tại không đúng.", { key: "errors.wrongPassword" });
    checkNewPassword(next, String(row.username));
    if (current === next) throw new HiveError("bad_request", "Mật khẩu mới phải khác mật khẩu cũ.", { key: "errors.samePassword" });
    this.#db.prepare("UPDATE hub_users SET password_hash = ?, must_change = 0 WHERE id = ?").run(hashPassword(next), id);
    return this.get(id)!;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  startSession(userId: string): { token: string; maxAge: number } {
    const token = `hs_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    this.#db.prepare("DELETE FROM hub_sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    this.#db
      .prepare("INSERT INTO hub_sessions(hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), userId, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86_400_000).toISOString());
    return { token, maxAge: SESSION_DAYS * 86_400 };
  }

  /** The enabled account behind a session cookie, or null (unknown, expired, or the account was disabled). */
  sessionUser(token: string): UserInfo | null {
    const row = this.#db.prepare("SELECT user_id, expires_at FROM hub_sessions WHERE hash = ?").get(sha256(token)) as Row | undefined;
    if (!row || String(row.expires_at) < new Date().toISOString()) return null;
    const user = this.get(String(row.user_id));
    return user && !user.disabled ? user : null;
  }

  /** Whether the browser session with this stored hash (Actor.humanSession) is still signed in to an enabled account. */
  sessionAlive(hash: string): boolean {
    const row = this.#db.prepare("SELECT user_id, expires_at FROM hub_sessions WHERE hash = ?").get(hash) as Row | undefined;
    if (!row || String(row.expires_at) < new Date().toISOString()) return false;
    const user = this.get(String(row.user_id));
    return !!user && !user.disabled;
  }

  endSession(token: string): void {
    this.#db.prepare("DELETE FROM hub_sessions WHERE hash = ?").run(sha256(token));
  }

  endSessions(userId: string): void {
    this.#db.prepare("DELETE FROM hub_sessions WHERE user_id = ?").run(userId);
  }

  #require(id: string): UserInfo {
    const user = this.get(id);
    if (!user) throw new HiveError("not_found", "Không có tài khoản này.", { key: "errors.userNotFound" });
    return user;
  }

  #activeAdmins(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM hub_users WHERE admin = 1 AND disabled = 0").get() as Row).n);
  }
}

/** Failed sign-ins per username and per address: 5 misses lock the pair for 15 minutes. */
export class LoginThrottle {
  readonly #fails = new Map<string, { count: number; until: number }>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(max = 5, windowMs = 15 * 60_000) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** Milliseconds until the pair may try again (0 = allowed). */
  blockedFor(key: string, now = Date.now()): number {
    const f = this.#fails.get(key);
    return f && f.count >= this.#max && f.until > now ? f.until - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const f = this.#fails.get(key);
    const fresh = !f || f.until <= now;
    this.#fails.set(key, { count: fresh ? 1 : f.count + 1, until: now + this.#windowMs });
  }

  reset(key: string): void {
    this.#fails.delete(key);
  }
}
