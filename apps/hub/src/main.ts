import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { provisionQueue, registerProvisionWorker } from "./modules/catalog/index.ts";
import { attachWorkerGateway } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createOpenAIEmbedder, embedQueue, registerEmbedWorker } from "./modules/knowledge/index.ts";
import { createJobs, createPool, loadConfig } from "./modules/platform/index.ts";
import { defaultProviderFactory } from "./modules/scm/index.ts";

const config = loadConfig();
const roles = config.roles ?? ["api", "jobs"];
const auth =
  config.authDatabaseUrl && config.authSecret
    ? createAuth({
        pool: createPool(config.authDatabaseUrl),
        baseURL: config.publicUrl ?? `http://localhost:${config.port}`,
        secret: config.authSecret,
        trustedOrigins: config.publicUrl ? [config.publicUrl] : [],
        github: config.github,
        gitlab: config.gitlab,
        allowEmailSignUp: config.allowEmailSignUp ?? false,
      })
    : undefined;
if (!auth) console.warn("Chưa cấu hình HIVE_DATABASE_AUTH_URL: hub chạy không có đăng nhập.");
const pool = config.databaseUrl ? createPool(config.databaseUrl) : undefined;
if (!pool) console.warn("Chưa cấu hình HIVE_DATABASE_URL: API tổ chức, máy và cổng worker không dùng được.");

const jobs = config.jobsDatabaseUrl
  ? createJobs({
      connectionString: config.jobsDatabaseUrl,
      queues: [provisionQueue, embedQueue],
      // Giám sát và lịch nền của pg-boss chỉ cần chạy ở tiến trình xử lý job.
      maintenance: roles.includes("jobs"),
    })
  : undefined;
if (!jobs) console.warn("Chưa cấu hình HIVE_DATABASE_JOBS_URL: hub chạy không có hàng đợi, không tạo được dự án.");
await jobs?.start();

if (roles.includes("jobs") && jobs) {
  if (!pool || !config.masterKey) {
    console.warn("Vai trò jobs cần HIVE_DATABASE_URL và HIVE_MASTER_KEY; bỏ qua saga khởi tạo dự án.");
  } else {
    await registerProvisionWorker(jobs, {
      pool,
      masterKey: config.masterKey,
      providerFactory: defaultProviderFactory,
      publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
    });
  }
}

const embedder = config.embeddings ? createOpenAIEmbedder(config.embeddings) : undefined;
if (roles.includes("jobs") && jobs && pool && embedder) await registerEmbedWorker(jobs, { pool, embedder });

if (roles.includes("api")) {
  const server = serve(
    { fetch: createApp({ config, auth, pool, jobs, embedder }).fetch, port: config.port },
    (info) => {
      console.log(`xDev Hive hub ${config.version} lắng nghe ở :${info.port}`);
    },
  );
  // serve() tạo server HTTP/1.1 khi không cấu hình http2; WebSocket chỉ nâng cấp được trên HTTP/1.1.
  if (pool) attachWorkerGateway(server as Server, { pool });
}

// pg-boss nhả job đang giữ khi dừng êm, để tiến trình khác nhận lại ngay thay vì chờ hết hạn.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (jobs?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
