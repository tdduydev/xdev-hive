import { readFileSync } from "node:fs";
import { type MasterKey, parseMasterKey } from "./secrets.ts";

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface HubConfig {
  docStorage?: DocStorageLimits | undefined;
  /** Nhập Word (spec 019, plan.md mục 13). */
  wordImport?: WordImportConfig | undefined;
  port: number;
  version: string;
  /** Giờ dựng image (file BUILD_TIME ở gốc repo do Dockerfile ghi); null khi chạy từ mã nguồn. */
  builtAt?: string | null;
  /** Địa chỉ người dùng mở trên trình duyệt; Better Auth dựng URL callback từ đây. */
  publicUrl?: string | undefined;
  /** Kết nối bằng role hive_app; mọi truy vấn dữ liệu tổ chức đi qua đây. */
  databaseUrl?: string | undefined;
  /** Kết nối bằng role hive_jobs cho pg-boss. Không đặt thì hub chạy không có hàng đợi (không tạo được dự án). */
  jobsDatabaseUrl?: string | undefined;
  machineOfflineNotifySec?: number | undefined;
  /** Vai trò tiến trình (docs/architecture.md mục 1). Mặc định chạy cả api và jobs trong một tiến trình. */
  roles?: HubRole[] | undefined;
  /** Khoá chủ mã hoá secret (token Git, secret webhook). */
  masterKey?: MasterKey | undefined;
  /** Email được tạo thêm tổ chức sau khi hub đã có tổ chức đầu tiên (HIVE_ORG_CREATORS, cách nhau bằng dấu phẩy). */
  orgCreators?: string[] | undefined;
  authDatabaseUrl?: string | undefined;
  authSecret?: string | undefined;
  allowEmailSignUp?: boolean | undefined;
  /** SMTP nội bộ chỉ được phép khi người vận hành chủ động bật cờ. */
  notifyAllowPrivate?: boolean | undefined;
  telegramPollingBotIds?: string[] | undefined;
  /** Mở /mcp cho agent trong run khi HIVE_PUBLIC_URL là http (mạng tin cậy). OAuth của người dùng vẫn chỉ chạy qua https. */
  mcpAllowHttp?: boolean | undefined;
  /** Bật Terminal Leader (HIVE_REMOTE_TERMINAL=1, specs/010): Claude CLI tương tác trên máy dùng chung qua /ws/terminal. */
  remoteTerminal?: boolean | undefined;
  github?: OAuthAppConfig | undefined;
  gitlab?: (OAuthAppConfig & { issuer?: string | undefined }) | undefined;
  /** API tương thích OpenAI embeddings cho tìm memory theo nghĩa. Không đặt thì chỉ tìm theo từ. */
  embeddings?: EmbeddingsConfig | undefined;
  desktopReleases?: string | undefined;
  /** API release trả bản worker mới nhất (mặc định của repo trên GitHub); không đặt thì web không báo máy chạy bản cũ. */
  workerReleases?: string | undefined;
}

export interface EmbeddingsConfig {
  /** Gốc API, ví dụ `https://api.openai.com/v1`; hub gọi `<url>/embeddings`. */
  url: string;
  /** Bỏ trống với server nội bộ không cần khoá (Ollama, vLLM). */
  apiKey?: string | undefined;
  model: string;
  /** Chỉ gửi khi đặt: mô hình text-embedding-3 cắt được số chiều, mô hình khác có thể từ chối tham số này. */
  dimensions?: number | undefined;
}

export type HubRole = "api" | "jobs";
const ROLES: readonly HubRole[] = ["api", "jobs"];

type Env = Record<string, string | undefined>;

export interface DocStorageLimits {
  assetMaxBytes: number;
  importMaxBytes: number;
  orgStorageBytes: number;
}

export function loadDocStorageLimits(env: Env = process.env): DocStorageLimits {
  const bytes = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} phải là số nguyên byte dương an toàn.`);
    return value;
  };
  return {
    assetMaxBytes: bytes("HIVE_DOC_ASSET_MAX_BYTES", 50 * 1024 ** 2),
    importMaxBytes: bytes("HIVE_DOC_IMPORT_MAX_BYTES", 2 * 1024 ** 3),
    orgStorageBytes: bytes("HIVE_DOC_ORG_STORAGE_BYTES", 5 * 1024 ** 3),
  };
}

export interface WordImportConfig {
  pandocPath: string;
  /** LibreOffice cho `.doc`; không chạy được thì chỉ tắt riêng `.doc`. */
  sofficePath: string;
  docTimeoutMs: number;
  maxBytes: number;
  batchFiles: number;
  batchBytes: number;
  timeoutMs: number;
  /** Số ngày giữ tạm file và ảnh của đề xuất chưa duyệt (P2). */
  stagingDays: number;
}

export function loadWordImportConfig(env: Env = process.env): WordImportConfig {
  const positive = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} phải là số nguyên dương an toàn.`);
    return value;
  };
  const config = {
    pandocPath: env.HIVE_PANDOC_PATH?.trim() || "pandoc",
    sofficePath: env.HIVE_SOFFICE_PATH?.trim() || "soffice",
    docTimeoutMs: positive("HIVE_DOC_WORD_DOC_TIMEOUT_MS", 120_000),
    maxBytes: positive("HIVE_DOC_WORD_MAX_BYTES", 50 * 1024 ** 2),
    batchFiles: positive("HIVE_DOC_WORD_BATCH_FILES", 100),
    batchBytes: positive("HIVE_DOC_WORD_BATCH_BYTES", 500 * 1024 ** 2),
    timeoutMs: positive("HIVE_DOC_WORD_TIMEOUT_MS", 120_000),
    stagingDays: positive("HIVE_DOC_WORD_STAGING_DAYS", 30),
  };
  // Lượt chỉ có một file vẫn phải qua được giới hạn của lượt.
  if (config.maxBytes > config.batchBytes)
    throw new Error("HIVE_DOC_WORD_MAX_BYTES không được lớn hơn HIVE_DOC_WORD_BATCH_BYTES.");
  return config;
}

function roles(env: Env): HubRole[] {
  const list = (env.HIVE_ROLES ?? "api,jobs")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of list) if (!ROLES.includes(r as HubRole)) throw new Error(`HIVE_ROLES có vai trò lạ: ${r}`);
  return list as HubRole[];
}

function telegramPollingBotIds(env: Env): string[] {
  const ids = (env.HIVE_TELEGRAM_POLL_BOT_IDS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("HIVE_TELEGRAM_POLL_BOT_IDS phải là danh sách UUID bot, cách nhau bằng dấu phẩy.");
  }
  return [...new Set(ids)];
}

function embeddings(env: Env): EmbeddingsConfig | undefined {
  const url = env.HIVE_EMBEDDINGS_URL;
  if (!url) return undefined;
  if (!/^https?:\/\//.test(url)) throw new Error(`HIVE_EMBEDDINGS_URL phải là địa chỉ http(s): ${url}`);
  const dims = env.HIVE_EMBEDDINGS_DIMENSIONS;
  const dimensions = dims ? Number(dims) : undefined;
  if (dimensions !== undefined && !(Number.isInteger(dimensions) && dimensions > 0 && dimensions <= 16_000)) {
    throw new Error(`HIVE_EMBEDDINGS_DIMENSIONS không hợp lệ: ${dims}`);
  }
  return {
    url: url.replace(/\/+$/, ""),
    apiKey: env.HIVE_EMBEDDINGS_API_KEY || undefined,
    model: env.HIVE_EMBEDDINGS_MODEL || "text-embedding-3-small",
    dimensions,
  };
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
  const offlineNotifySec = Number(env.HIVE_MACHINE_OFFLINE_NOTIFY_SEC ?? 300);
  if (!Number.isInteger(offlineNotifySec) || offlineNotifySec < 1) {
    throw new Error(`HIVE_MACHINE_OFFLINE_NOTIFY_SEC không hợp lệ: ${env.HIVE_MACHINE_OFFLINE_NOTIFY_SEC}`);
  }
  const authSecret = env.HIVE_AUTH_SECRET;
  // Secret ngắn làm cookie phiên dễ bị giả; bắt buộc khi đã bật đăng nhập.
  if (authDatabaseUrl && (!authSecret || authSecret.length < 32)) {
    throw new Error("HIVE_AUTH_SECRET phải có ít nhất 32 ký tự khi đặt HIVE_DATABASE_AUTH_URL.");
  }
  const gitlab = oauthApp(env, "HIVE_GITLAB");
  return {
    port,
    docStorage: loadDocStorageLimits(env),
    wordImport: loadWordImportConfig(env),
    version: env.HIVE_VERSION ?? "0.0.0-dev",
    builtAt: env.HIVE_BUILT_AT ?? buildTime(),
    publicUrl: env.HIVE_PUBLIC_URL ?? `http://localhost:${port}`,
    databaseUrl: env.HIVE_DATABASE_URL,
    jobsDatabaseUrl: env.HIVE_DATABASE_JOBS_URL,
    machineOfflineNotifySec: offlineNotifySec,
    roles: roles(env),
    masterKey: masterKey(env),
    orgCreators: (env.HIVE_ORG_CREATORS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    authDatabaseUrl,
    authSecret,
    allowEmailSignUp: env.HIVE_ALLOW_EMAIL_SIGNUP === "1",
    notifyAllowPrivate: env.HIVE_NOTIFY_ALLOW_PRIVATE === "1",
    telegramPollingBotIds: telegramPollingBotIds(env),
    mcpAllowHttp: env.HIVE_MCP_ALLOW_HTTP === "1",
    remoteTerminal: env.HIVE_REMOTE_TERMINAL === "1",
    github: oauthApp(env, "HIVE_GITHUB"),
    gitlab: gitlab && { ...gitlab, issuer: env.HIVE_GITLAB_ISSUER },
    embeddings: embeddings(env),
    // Như worker: mặc định đọc latest.json của bản phát hành mới nhất trên GitHub; "off" khi hub không ra được Internet.
    desktopReleases:
      env.HIVE_DESKTOP_RELEASES === "off"
        ? undefined
        : env.HIVE_DESKTOP_RELEASES || "https://github.com/tdduydev/xdev-hive/releases/latest/download/latest.json",
    // "off" cho hub trong mạng không ra được GitHub.
    workerReleases:
      env.HIVE_WORKER_RELEASES === "off"
        ? undefined
        : env.HIVE_WORKER_RELEASES || "https://api.github.com/repos/tdduydev/xdev-hive/releases/latest",
  };
}

/** Đọc BUILD_TIME ở gốc repo (Dockerfile ghi lúc dựng image); không có hay sai định dạng thì null. */
function buildTime(): string | null {
  try {
    const text = readFileSync(new URL("../../../../../BUILD_TIME", import.meta.url), "utf8").trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text) ? text : null;
  } catch {
    return null;
  }
}
