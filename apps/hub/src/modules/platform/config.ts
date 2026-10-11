export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface HubConfig {
  port: number;
  version: string;
  /** Địa chỉ người dùng mở trên trình duyệt; Better Auth dựng URL callback từ đây. */
  publicUrl?: string | undefined;
  /** Kết nối bằng role hive_app; mọi truy vấn dữ liệu tổ chức đi qua đây. */
  databaseUrl?: string | undefined;
  /** Email được tạo thêm tổ chức sau khi hub đã có tổ chức đầu tiên (HIVE_ORG_CREATORS, cách nhau bằng dấu phẩy). */
  orgCreators?: string[] | undefined;
  authDatabaseUrl?: string | undefined;
  authSecret?: string | undefined;
  allowEmailSignUp?: boolean | undefined;
  github?: OAuthAppConfig | undefined;
  gitlab?: (OAuthAppConfig & { issuer?: string | undefined }) | undefined;
}

type Env = Record<string, string | undefined>;

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
    orgCreators: (env.HIVE_ORG_CREATORS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    authDatabaseUrl,
    authSecret,
    allowEmailSignUp: env.HIVE_ALLOW_EMAIL_SIGNUP === "1",
    github: oauthApp(env, "HIVE_GITHUB"),
    gitlab: gitlab && { ...gitlab, issuer: env.HIVE_GITLAB_ISSUER },
  };
}
