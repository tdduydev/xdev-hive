import { readFileSync } from "node:fs";
import { type MasterKey, parseMasterKey } from "./secrets.ts";

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface HubConfig {
  port: number;
  version: string;
  /** Địa chỉ người dùng mở trên trình duyệt; Better Auth dựng URL callback từ đây. */
  publicUrl?: string | undefined;
  databaseUrl?: string | undefined;
  /** Kết nối bằng role hive_jobs cho pg-boss. Không đặt thì hub chạy không có hàng đợi (không tạo được dự án). */
  jobsDatabaseUrl?: string | undefined;
  /** Vai trò tiến trình (docs/architecture.md mục 1). Mặc định chạy cả api và jobs trong một tiến trình. */
  roles?: HubRole[] | undefined;
  /** Khoá chủ mã hoá secret (token Git, secret webhook). */
  masterKey?: MasterKey | undefined;
  authDatabaseUrl?: string | undefined;
  authSecret?: string | undefined;
  allowEmailSignUp?: boolean | undefined;
  github?: OAuthAppConfig | undefined;
  gitlab?: (OAuthAppConfig & { issuer?: string | undefined }) | undefined;
}

export type HubRole = "api" | "jobs";
const ROLES: readonly HubRole[] = ["api", "jobs"];

type Env = Record<string, string | undefined>;

function roles(env: Env): HubRole[] {
  const list = (env.HIVE_ROLES ?? "api,jobs")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of list) if (!ROLES.includes(r as HubRole)) throw new Error(`HIVE_ROLES có vai trò lạ: ${r}`);
  return list as HubRole[];
}

/** Khoá chủ đọc từ biến môi trường hoặc file mount (secret của Docker/Kubernetes), không cả hai. */
function masterKey(env: Env): MasterKey | undefined {
  if (env.HIVE_MASTER_KEY && env.HIVE_MASTER_KEY_FILE) {
    throw new Error("Chỉ đặt một trong HIVE_MASTER_KEY và HIVE_MASTER_KEY_FILE.");
  }
  if (env.HIVE_MASTER_KEY_FILE) return parseMasterKey(readFileSync(env.HIVE_MASTER_KEY_FILE, "utf8"));
  return env.HIVE_MASTER_KEY ? parseMasterKey(env.HIVE_MASTER_KEY) : undefined;
}

function oauthApp(env: Env, prefix: string): OAuthAppConfig | undefined {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error(`Cần cả ${prefix}_CLIENT_ID và ${prefix}_CLIENT_SECRET.`);
  return { clientId, clientSecret };
}

export function loadConfig(env: Env = process.env): HubConfig {
  const port = Number(env.HIVE_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`HIVE_PORT không hợp lệ: ${env.HIVE_PORT}`);
  const authDatabaseUrl = env.HIVE_DATABASE_AUTH_URL;
  const authSecret = env.HIVE_AUTH_SECRET;
  // Secret ngắn làm cookie phiên dễ bị giả; bắt buộc khi đã bật đăng nhập.
  if (authDatabaseUrl && (!authSecret || authSecret.length < 32)) {
    throw new Error("HIVE_AUTH_SECRET phải có ít nhất 32 ký tự khi đặt HIVE_DATABASE_AUTH_URL.");
  }
  const gitlab = oauthApp(env, "HIVE_GITLAB");
  return {
    port,
    version: env.HIVE_VERSION ?? "0.0.0-dev",
    publicUrl: env.HIVE_PUBLIC_URL ?? `http://localhost:${port}`,
    databaseUrl: env.HIVE_DATABASE_URL,
    jobsDatabaseUrl: env.HIVE_DATABASE_JOBS_URL,
    roles: roles(env),
    masterKey: masterKey(env),
    authDatabaseUrl,
    authSecret,
    allowEmailSignUp: env.HIVE_ALLOW_EMAIL_SIGNUP === "1",
    github: oauthApp(env, "HIVE_GITHUB"),
    gitlab: gitlab && { ...gitlab, issuer: env.HIVE_GITLAB_ISSUER },
  };
}
