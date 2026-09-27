// xDev Hive hub: shared docs, memory and tasks for a team, plus MCP over HTTP.
//   HIVE_PORT=7788 HIVE_HOST=127.0.0.1 HIVE_DB=./data/hub.db
//   HIVE_ALLOWED_HOSTS=hive.example.com   (required behind a reverse proxy / public hostname)
//   HIVE_MEMORY_APPROVAL=off            (memory from agents is visible without admin approval)
//   HIVE_BOOTSTRAP_TOKEN=...            (fixed admin token for automated deploys)
//   HIVE_BACKUP_DIR=/data/backups       (snapshot on start and every HIVE_BACKUP_HOURS=24, keep HIVE_BACKUP_KEEP=7)
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor, createHubApp, type HubAppOptions } from "./app.ts";
import { backupDatabase, backupFile, backupSettings, type BackupResult } from "./backup.ts";
import { TokenStore } from "./tokens.ts";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.HIVE_PORT ?? 7788);
const host = process.env.HIVE_HOST ?? "127.0.0.1";
const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(root, "data", "hub.db"));
const production = process.env.NODE_ENV === "production";
const backup = backupSettings(process.env);

const logBackup = (when: string, take: () => BackupResult | null) => {
  try {
    const r = take();
    if (r) console.log(`[xdev-hive] backup (${when}) ${r.file}${r.removed.length ? `, removed ${r.removed.length} old` : ""}`);
  } catch (err) {
    console.error(`[xdev-hive] backup (${when}) failed: ${(err as Error).message}`);
  }
};
// Before opening the hub: the snapshot predates any schema migration this version runs.
if (backup) logBackup("start", () => backupFile(dbPath, backup));

const hive = new SqliteHive(dbPath, { memoryRequiresApproval: process.env.HIVE_MEMORY_APPROVAL !== "off" });
hive.seed("hub");
const tokens = new TokenStore(hive.db);
if (process.env.HIVE_BOOTSTRAP_TOKEN) tokens.ensure(process.env.HIVE_BOOTSTRAP_TOKEN, "bootstrap", "admin");
if (tokens.count() === 0) {
  const { token } = tokens.create("admin", "admin");
  console.log(`\n  First run: admin token (shown once, store it safely)\n\n  ${token}\n`);
}

const allowedHosts = allowedHostsFor(process.env.HIVE_ALLOWED_HOSTS, host);

if (backup) setInterval(() => logBackup("scheduled", () => backupDatabase(hive.db, backup)), backup.hours * 3_600_000).unref();

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
