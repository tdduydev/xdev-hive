// First-run setup (roadmap 75): a hub started by `docker compose up` alone asks for its settings on its own page.
// What the page saves lives in settings.json next to the database and fills the HIVE_* variables the environment
// leaves unset; a variable set in the environment wins and the page shows it as locked, so a hub deployed with
// deploy/.env (hive.xdev.asia) behaves as before.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import express, { type Express } from "express";
import { HiveError, toErrorPayload } from "@xdev-hive/core";
import { checkNewPassword, type UserStore } from "./users.ts";

/** The settings the page may set: only these are ever read from the file. */
export const SETUP_KEYS = [
  "HIVE_ALLOWED_HOSTS",
  "HIVE_LAN_HOSTS",
  "HIVE_PUBLIC_URL",
  "HIVE_TRUST_PROXY",
  "HIVE_SEAWEEDFS_URL",
  "HIVE_EMBED_URL",
  "HIVE_EMBED_MODEL",
  "HIVE_EMBED_KEY",
  "HIVE_OIDC_ISSUER",
  "HIVE_OIDC_CLIENT_ID",
  "HIVE_OIDC_CLIENT_SECRET",
  "HIVE_OIDC_NAME",
  "HIVE_BACKUP_HOURS",
  "HIVE_BACKUP_KEEP",
  "HIVE_MEMORY_APPROVAL",
  "HIVE_REMOTE_TERMINAL",
  "HIVE_GATE_JOBS",
] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];
export type SetupValues = Partial<Record<SetupKey, string>>;

/** Never sent back to a browser, not even as a default. */
const SECRET_KEYS: SetupKey[] = ["HIVE_EMBED_KEY", "HIVE_OIDC_CLIENT_SECRET"];

export interface SetupFile {
  done: boolean;
  values: SetupValues;
}

export function readSetupFile(file: string): SetupFile | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { done?: unknown; values?: Record<string, unknown> };
  const values: SetupValues = {};
  for (const key of SETUP_KEYS) {
    const v = raw.values?.[key];
    if (typeof v === "string") values[key] = v;
  }
  return { done: raw.done === true, values };
}

/** Written beside and renamed over, so a crash never leaves half a file; 0600 because it may hold secrets. */
export function writeSetupFile(file: string, content: SetupFile): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows: no POSIX modes. */ }
  renameSync(tmp, file);
}

/** Compose passes a variable it does not know as "": only a non-empty value counts as set by the environment. */
const setByEnv = (env: NodeJS.ProcessEnv, key: SetupKey) => env[key] !== undefined && env[key] !== "";

/** Fills the unset variables from the file; returns the keys the environment keeps for itself. */
export function applySetupFile(env: NodeJS.ProcessEnv, file: SetupFile | null): SetupKey[] {
  const locked = SETUP_KEYS.filter((k) => setByEnv(env, k));
  for (const [key, value] of Object.entries(file?.values ?? {}) as [SetupKey, string][]) {
    if (!locked.includes(key)) env[key] = value;
  }
  return locked;
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[?[0-9a-f:]+\]?$/i;
const httpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** Each value as the hub reads it, or a bad_request naming the setting; locked keys are dropped. */
export function checkSetupValues(input: unknown, locked: SetupKey[]): SetupValues {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: SetupValues = {};
  const bad = (key: SetupKey): never => {
    throw new HiveError("bad_request", `Giá trị không hợp lệ: ${key}`, { key: "errors.setupValue", vars: { key } });
  };
  for (const key of SETUP_KEYS) {
    if (locked.includes(key) || raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || (raw[key] as string).length > 500) bad(key);
    const v = (raw[key] as string).trim();
    switch (key) {
      case "HIVE_ALLOWED_HOSTS":
      case "HIVE_LAN_HOSTS":
        if (v && !v.split(",").every((h) => HOST.test(h.trim()))) bad(key);
        out[key] = v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).join(",");
        continue;
      case "HIVE_PUBLIC_URL":
      case "HIVE_SEAWEEDFS_URL":
      case "HIVE_EMBED_URL":
        if (v && !httpUrl(v)) bad(key);
        break;
      case "HIVE_OIDC_ISSUER":
        if (v && (!httpUrl(v) || !v.startsWith("https://"))) bad(key);
        break;
      case "HIVE_TRUST_PROXY":
      case "HIVE_REMOTE_TERMINAL":
      case "HIVE_GATE_JOBS":
        if (v !== "" && v !== "1") bad(key);
        break;
      case "HIVE_MEMORY_APPROVAL":
        if (v !== "on" && v !== "off") bad(key);
        break;
      case "HIVE_BACKUP_HOURS":
      case "HIVE_BACKUP_KEEP":
        if (!/^[1-9]\d{0,4}$/.test(v)) bad(key);
        break;
    }
    out[key] = v;
  }
  // SSO is all three or none, and its redirect URI needs an address people reach the hub at.
  const oidc = (["HIVE_OIDC_ISSUER", "HIVE_OIDC_CLIENT_ID", "HIVE_OIDC_CLIENT_SECRET"] as const).map((k) => Boolean(out[k]));
  if (oidc.some(Boolean) && !oidc.every(Boolean)) throw new HiveError("bad_request", "SSO cần đủ issuer, client id và client secret.", { key: "errors.setupOidc" });
  if (oidc.every(Boolean) && !out.HIVE_PUBLIC_URL && !out.HIVE_ALLOWED_HOSTS) {
    throw new HiveError("bad_request", "SSO cần URL công khai hoặc tên miền của hub.", { key: "errors.setupOidcUrl" });
  }
  return out;
}

/** What the page starts from: the values in force, secrets left out. */
export function setupDefaults(env: NodeJS.ProcessEnv): SetupValues {
  const out: SetupValues = {
    HIVE_SEAWEEDFS_URL: "http://seaweedfs:8888",
    HIVE_EMBED_MODEL: "bge-m3",
    HIVE_BACKUP_HOURS: "24",
    HIVE_BACKUP_KEEP: "7",
    HIVE_MEMORY_APPROVAL: "on",
  };
  for (const key of SETUP_KEYS) {
    if (SECRET_KEYS.includes(key)) continue;
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

/** Readable, long enough not to be guessed in the attempts allowed before it changes. */
export function newSetupCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

const MAX_FAILURES = 10;

export interface SetupGateOptions {
  file: string;
  env: NodeJS.ProcessEnv;
  locked: SetupKey[];
  users: UserStore;
  /** Prints the code where the person who ran compose can read it (the container's log). */
  announce: (code: string) => void;
  /** After the response went out: the hub restarts to read its new settings. */
  onDone: () => void;
}

/**
 * Holds the hub closed until it is set up: only health and /api/setup answer, everything else is 503. The page proves
 * it was opened by whoever can read the hub's log with the code printed there.
 */
export class SetupGate {
  #code: string;
  #failures = 0;
  #pending = true;
  readonly #o: SetupGateOptions;

  constructor(o: SetupGateOptions) {
    this.#o = o;
    this.#code = newSetupCode();
    o.announce(this.#code);
  }

  get pending(): boolean {
    return this.#pending;
  }

  #codeMatches(given: unknown): boolean {
    const a = Buffer.from(String(given ?? "").trim().toUpperCase());
    const b = Buffer.from(this.#code);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Mounted first: answers the setup calls itself and closes everything else while the hub is not set up. */
  mount(app: Express): void {
    app.get("/api/setup", (_req, res) => {
      res.json({ result: this.#pending ? { pending: true, locked: this.#o.locked, defaults: setupDefaults(this.#o.env) } : { pending: false } });
    });
    app.post("/api/setup", express.json({ limit: "64kb" }), (req, res) => {
      try {
        if (!this.#pending) throw new HiveError("conflict", "Hub đã được cài đặt.", { key: "errors.setupDone" });
        const { code, admin, values } = (req.body ?? {}) as { code?: unknown; admin?: { username?: unknown; password?: unknown }; values?: unknown };
        if (!this.#codeMatches(code)) {
          // A new code after a run of misses: guessing has to start over, and the log shows the new one.
          if (++this.#failures >= MAX_FAILURES) {
            this.#failures = 0;
            this.#code = newSetupCode();
            this.#o.announce(this.#code);
          }
          throw new HiveError("forbidden", "Mã cài đặt không đúng.", { key: "errors.setupCode" });
        }
        const username = typeof admin?.username === "string" ? admin.username.trim().toLowerCase() : "";
        const password = typeof admin?.password === "string" ? admin.password : "";
        checkNewPassword(password, username || "admin");
        const checked = checkSetupValues(values, this.#o.locked);
        // The account first: a bad username fails before anything is written.
        this.#o.users.create({ username, displayName: "Admin", admin: true, password, mustChange: false });
        writeSetupFile(this.#o.file, { done: true, values: checked });
        this.#pending = false;
        res.json({ result: { restart: true } });
        res.on("finish", () => this.#o.onDone());
      } catch (err) {
        if (err instanceof HiveError) res.status(err.code === "forbidden" ? 403 : err.code === "conflict" ? 409 : 400).json({ error: toErrorPayload(err) });
        else res.status(500).json({ error: { code: "internal", message: "Internal error" } });
      }
    });
    app.use((req, res, next) => {
      if (!this.#pending || req.path === "/api/health" || !(req.path.startsWith("/api/") || req.path === "/mcp")) return next();
      res.status(503).json({ error: { code: "conflict", message: "Hub chưa được cài đặt: mở trang của hub để cài.", key: "errors.setupPending" } });
    });
  }
}
