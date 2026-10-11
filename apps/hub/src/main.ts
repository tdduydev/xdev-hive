import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { attachWorkerGateway } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, loadConfig } from "./modules/platform/index.ts";

const config = loadConfig();
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

const server = serve({ fetch: createApp({ config, auth, pool }).fetch, port: config.port }, (info) => {
  console.log(`xDev Hive hub ${config.version} lắng nghe ở :${info.port}`);
});
// serve() tạo server HTTP/1.1 khi không cấu hình http2; WebSocket chỉ nâng cấp được trên HTTP/1.1.
if (pool) attachWorkerGateway(server as Server, { pool });
