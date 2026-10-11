import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
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

serve({ fetch: createApp({ config, auth }).fetch, port: config.port }, (info) => {
  console.log(`xDev Hive hub ${config.version} lắng nghe ở :${info.port}`);
});
