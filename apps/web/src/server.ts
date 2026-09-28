// xDev Hive hub: shared docs, memory and tasks for a team, plus MCP over HTTP.
//   HIVE_PORT=7788 HIVE_HOST=127.0.0.1 HIVE_DB=./data/hub.db
//   HIVE_ALLOWED_HOSTS=hive.example.com   (required behind a reverse proxy / public hostname)
//   HIVE_MEMORY_APPROVAL=off            (memory from agents is visible without admin approval)
//   HIVE_MEMORY_STALE_DAYS=90           (memory no agent used for this long is left out of agents' searches; 0 = never)
//   HIVE_BOOTSTRAP_TOKEN=...            (fixed admin token for automated deploys)
//   HIVE_ADMIN_USER=admin              (name of the first admin account, created with a temporary password)
//   HIVE_TRUST_PROXY=1                 (behind a TLS proxy: Secure cookies, client address from X-Forwarded-For)
//   HIVE_BACKUP_DIR=/data/backups       (snapshot on start and every HIVE_BACKUP_HOURS=24, keep HIVE_BACKUP_KEEP=7)
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor, createHubApp, type HubAppOptions } from "./app.ts";
import { backupDatabase, backupFile, backupSettings, type BackupResult } from "./backup.ts";
import { TokenStore } from "./tokens.ts";
import { UserStore } from "./users.ts";

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

const staleDays = Number(process.env.HIVE_MEMORY_STALE_DAYS ?? 90);
const hive = new SqliteHive(dbPath, {
  memoryRequiresApproval: process.env.HIVE_MEMORY_APPROVAL !== "off",
  memoryStaleDays: Number.isFinite(staleDays) && staleDays >= 0 ? staleDays : 90,
});
hive.seed("hub");
const tokens = new TokenStore(hive.db);
const users = new UserStore(hive.db);
if (process.env.HIVE_BOOTSTRAP_TOKEN) tokens.ensure(process.env.HIVE_BOOTSTRAP_TOKEN, "bootstrap", "admin");
// No account yet (first run, or a hub from before accounts): an admin with a temporary password.
if (users.count() === 0) {
  const username = (process.env.HIVE_ADMIN_USER ?? "admin").trim().toLowerCase();
  const { password } = users.create({ username, displayName: "Admin", admin: true });
  console.log(`\n  First admin account: ${username}\n  Temporary password (shown once; the first sign-in asks for a new one):\n\n  ${password}\n`);
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

httpServer.on("request", createHubApp({ hive, tokens, users, allowedHosts, ui, trustProxy: process.env.HIVE_TRUST_PROXY === "1" }));
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
