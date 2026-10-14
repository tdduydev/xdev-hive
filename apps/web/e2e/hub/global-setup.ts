import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DATABASE_URL_ENV, HUB_PORT, OWNER, WEB_URL } from "./env.ts";

// Cùng image với test database của hub (apps/hub/test/db-setup.ts), đổi được sang mirror khi Docker Hub giới hạn.
const POSTGRES_IMAGE = process.env.HIVE_TEST_POSTGRES_IMAGE ?? "pgvector/pgvector:0.8.7-pg18-trixie";
// Chạy hub bằng tiến trình con thay vì import: web không được import code của app khác (pnpm deps chặn).
const HUB_DIR = fileURLToPath(new URL("../../../hub/", import.meta.url));

/** Chạy một lệnh của hub tới khi xong; lỗi thì ném kèm log để biết hỏng ở đâu. */
async function hubCommand(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, args, { cwd: HUB_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`node ${args.join(" ")} thoát với mã ${code}:\n${output}`);
}

async function waitForHub(hub: ChildProcess): Promise<void> {
  const url = `http://127.0.0.1:${HUB_PORT}/api/v1/health`;
  for (let i = 0; i < 150; i++) {
    if (hub.exitCode !== null) throw new Error(`Hub dừng khi đang khởi động (mã ${hub.exitCode}).`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* Hub chưa nghe cổng. */
    }
    await delay(200);
  }
  throw new Error(`Hub không trả lời ${url} sau 30 giây.`);
}

/** Dựng Postgres bằng Testcontainers, bootstrap và migrate như production, rồi chạy hub thật. */
export default async function globalSetup() {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase("hive").start();
  const adminUrl = container.getConnectionUri();
  const pw = { owner: "owner-e2e", app: "app-e2e", auth: "auth-e2e" };
  const as = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  // Bỏ HIVE_* của máy đang chạy (vd. client GitHub trong shell) để hub chỉ dùng cấu hình của test.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
  const env: NodeJS.ProcessEnv = {
    ...base,
    HIVE_DATABASE_ADMIN_URL: adminUrl,
    HIVE_DB_OWNER_PASSWORD: pw.owner,
    HIVE_DB_APP_PASSWORD: pw.app,
    HIVE_DB_AUTH_PASSWORD: pw.auth,
    HIVE_DATABASE_OWNER_URL: as("hive_owner", pw.owner),
    HIVE_DATABASE_URL: as("hive_app", pw.app),
    HIVE_DATABASE_AUTH_URL: as("hive_auth", pw.auth),
    HIVE_PORT: String(HUB_PORT),
    // Trình duyệt mở web qua Vite; Better Auth kiểm Origin và dựng cookie theo địa chỉ này.
    HIVE_PUBLIC_URL: WEB_URL,
    HIVE_AUTH_SECRET: randomBytes(32).toString("base64"),
    HIVE_ALLOW_EMAIL_SIGNUP: "1",
    HIVE_ORG_CREATORS: OWNER.email,
    // Test không ra Internet: API release của GitHub hay trả 403 trên runner CI dùng chung IP.
    HIVE_WORKER_RELEASES: "off",
    HIVE_DESKTOP_RELEASES: "off",
  };
  try {
    await hubCommand(["src/cli.ts", "db:bootstrap"], env);
    await hubCommand(["src/cli.ts", "db:migrate"], env);
  } catch (error) {
    await container.stop();
    throw error;
  }
  const hub = spawn(process.execPath, ["src/main.ts"], { cwd: HUB_DIR, env, stdio: ["ignore", "ignore", "inherit"] });
  try {
    await waitForHub(hub);
  } catch (error) {
    hub.kill();
    await container.stop();
    throw error;
  }
  process.env[DATABASE_URL_ENV] = adminUrl;

  return async () => {
    if (hub.exitCode === null) {
      hub.kill();
      await once(hub, "exit");
    }
    await container.stop();
  };
}
