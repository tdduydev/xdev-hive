import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./modules/platform/index.ts";

const config = loadConfig();
serve({ fetch: createApp(config).fetch, port: config.port }, (info) => {
  console.log(`xDev Hive hub ${config.version} lắng nghe ở :${info.port}`);
});
