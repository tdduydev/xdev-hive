// xDev Hive hub: shared docs, memory and tasks for a team, plus MCP over HTTP.
//   HIVE_PORT=7788 HIVE_HOST=127.0.0.1 HIVE_DB=./data/hub.db
//   HIVE_ALLOWED_HOSTS=hive.xdev.asia   (required behind a reverse proxy / public hostname)
//   HIVE_MEMORY_APPROVAL=off            (memory from agents is visible without admin approval)
//   HIVE_BOOTSTRAP_TOKEN=...            (fixed admin token for automated deploys)
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp, type HubAppOptions } from "./app.ts";
import { TokenStore } from "./tokens.ts";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.HIVE_PORT ?? 7788);
const host = process.env.HIVE_HOST ?? "127.0.0.1";
const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(root, "data", "hub.db"));
const production = process.env.NODE_ENV === "production";

const hive = new SqliteHive(dbPath, { memoryRequiresApproval: process.env.HIVE_MEMORY_APPROVAL !== "off" });
hive.seed("hub");
const tokens = new TokenStore(hive.db);
if (process.env.HIVE_BOOTSTRAP_TOKEN) tokens.ensure(process.env.HIVE_BOOTSTRAP_TOKEN, "bootstrap", "admin");
if (tokens.count() === 0) {
  const { token } = tokens.create("admin", "admin");
  console.log(`\n  First run: admin token (shown once, store it safely)\n\n  ${token}\n`);
}

const localHosts = ["127.0.0.1", "localhost", "::1"];
const allowedHosts =
  process.env.HIVE_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ??
  (localHosts.includes(host) ? ["localhost", "127.0.0.1", "[::1]"] : undefined);

const httpServer = createServer();
let ui: HubAppOptions["ui"];
let closeVite: (() => Promise<void>) | undefined;
const clientDir = path.join(root, "dist", "client");
if (production) {
  if (!existsSync(clientDir)) throw new Error(`Missing ${clientDir}. Run: npm run build -w @xdev-hive/web`);
  ui = { dir: clientDir };
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    configFile: path.join(root, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: "spa",
  });
  ui = { middleware: vite.middlewares };
  closeVite = () => vite.close();
}

httpServer.on("request", createHubApp({ hive, tokens, allowedHosts, ui }));
httpServer.listen(port, host, () => {
  console.log(`[xdev-hive] hub on http://${host}:${port} (${production ? "production" : "dev"}), db ${dbPath}`);
  if (!allowedHosts) console.warn("[xdev-hive] HIVE_ALLOWED_HOSTS not set: Host header is not validated.");
});

// Close keep-alive and HMR sockets too, otherwise `node --watch` restarts hang.
const shutdown = () => {
  setTimeout(() => process.exit(0), 2000).unref();
  void closeVite?.();
  httpServer.close(() => {
    hive.close();
    process.exit(0);
  });
  httpServer.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
