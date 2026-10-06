// xDev Hive hub: shared docs, memory and tasks for a team, plus MCP over HTTP.
//   HIVE_PORT=7788 HIVE_HOST=127.0.0.1 HIVE_DB=./data/hub.db
//   HIVE_ALLOWED_HOSTS=hive.xdev.asia   (required behind a reverse proxy / public hostname)
//   HIVE_LAN_HOSTS=10.86.140.52,my-server (names and addresses the hub also answers to on the LAN, see
//     deploy/compose.lan.yaml; they come after HIVE_ALLOWED_HOSTS, so the public hostname stays the hub's own URL)
//   HIVE_MEMORY_APPROVAL=off            (memory from agents is visible without admin approval)
//   HIVE_MEMORY_STALE_DAYS=90           (memory no agent used for this long is left out of agents' searches; 0 = never)
//   HIVE_RUN_LOG_DAYS=30                (a run's log and diff are dropped this long after its last update, the rest of
//     the run — summary, MR, cost — stays for good; 0 = keep logs too)
//   HIVE_PUBLIC_URL=https://hive.xdev.asia (links in webhook messages; default: https:// + the first allowed host)
//   HIVE_BOOTSTRAP_TOKEN=...            (fixed admin token for automated deploys)
//   HIVE_ADMIN_USER=admin              (name of the first admin account, created with a temporary password)
//   HIVE_TRUST_PROXY=1                 (behind a TLS proxy: Secure cookies, client address from X-Forwarded-For)
//   HIVE_BACKUP_DIR=/data/backups       (snapshot on start and every HIVE_BACKUP_HOURS=24, keep HIVE_BACKUP_KEEP=7)
//   HIVE_OIDC_ISSUER=https://gitlab.example.com HIVE_OIDC_CLIENT_ID=… HIVE_OIDC_CLIENT_SECRET=… HIVE_OIDC_NAME=GitLab
//     (sign-in through an OpenID Connect provider; redirect URI: <HIVE_PUBLIC_URL>/api/auth/oidc/callback)
//   HIVE_EMBED_URL=http://ollama:11434/v1 (memory search by meaning too: an OpenAI-compatible /embeddings endpoint;
//     HIVE_EMBED_MODEL=bge-m3, HIVE_EMBED_KEY for an API, HIVE_EMBED_MIN_SCORE=0.5 cosine for a match by meaning)
//   HIVE_SEAWEEDFS_URL=http://seaweedfs:8888 (doc files in a SeaweedFS filer instead of the database; the ones already
//     in it move there; HIVE_SEAWEEDFS_PREFIX=/xdev-hive/doc-files. Backups copy them into <HIVE_BACKUP_DIR>/files)
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { HiveError, openAiEmbedder, type HiveEvent } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor, createHubApp, type HubAppOptions } from "./app.ts";
import { backupDatabase, backupFile, backupFiles, backupSettings, type BackupResult } from "./backup.ts";
import { seaweedFromEnv } from "./seaweed.ts";
import { OidcClient, oidcSettings } from "./oidc.ts";
import { TokenStore } from "./tokens.ts";
import { UserStore } from "./users.ts";
import { ReleaseStore } from "./releases.ts";
import { WebhookDispatcher, WebhookStore } from "./webhooks.ts";
import { AlertStore } from "./alerts.ts";
import { HubInfoSource } from "./hubinfo.ts";

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
const runLogDays = Number(process.env.HIVE_RUN_LOG_DAYS ?? 30);
const embedder = process.env.HIVE_EMBED_URL
  ? openAiEmbedder({ url: process.env.HIVE_EMBED_URL, model: process.env.HIVE_EMBED_MODEL || "bge-m3", key: process.env.HIVE_EMBED_KEY || undefined })
  : null;
const minScore = Number(process.env.HIVE_EMBED_MIN_SCORE ?? 0.5);
const blobs = seaweedFromEnv(process.env);
// Set once the webhook store exists (it lives in the hub's database).
let onEvent: (event: HiveEvent) => void = () => undefined;
// Set once the Hub page's source exists: it snapshots this very hive, so it cannot be built before it.
let hubInfo: HubInfoSource | null = null;
const hive = new SqliteHive(dbPath, {
  memoryRequiresApproval: process.env.HIVE_MEMORY_APPROVAL !== "off",
  memoryStaleDays: Number.isFinite(staleDays) && staleDays >= 0 ? staleDays : 90,
  runLogDays: Number.isFinite(runLogDays) && runLogDays >= 0 ? runLogDays : 30,
  onEvent: (event) => onEvent(event),
  embedder,
  embedMinScore: Number.isFinite(minScore) ? minScore : 0.5,
  blobs,
  // Deleting a project snapshots the whole hub first (roadmap 47), the same snapshot the Hub page's "Backup ngay"
  // makes. With HIVE_BACKUP_DIR unset this throws errors.backupOff, and nothing is deleted.
  backup: async () => {
    if (!hubInfo) throw new HiveError("conflict", "The hub is still starting up.", { key: "errors.backupOff" });
    return hubInfo.backup();
  },
});
hive.seed("hub", { hub: true });
const cleanupRound = () => {
  try { hive.queueMemoryCleanup(); }
  catch (err) { console.error(`[xdev-hive] memory cleanup scheduling failed: ${(err as Error).message}`); }
};
cleanupRound();
setInterval(cleanupRound, 60_000).unref();

const tokens = new TokenStore(hive.db);
const users = new UserStore(hive.db);
if (process.env.HIVE_BOOTSTRAP_TOKEN) tokens.ensure(process.env.HIVE_BOOTSTRAP_TOKEN, "bootstrap", "admin");
// No account yet (first run, or a hub from before accounts): an admin with a temporary password.
if (users.count() === 0) {
  const username = (process.env.HIVE_ADMIN_USER ?? "admin").trim().toLowerCase();
  const { password } = users.create({ username, displayName: "Admin", admin: true });
  console.log(`\n  First admin account: ${username}\n  Temporary password (shown once; the first sign-in asks for a new one):\n\n  ${password}\n`);
}

const allowedHosts = allowedHostsFor(process.env.HIVE_ALLOWED_HOSTS, host, process.env.HIVE_LAN_HOSTS);

const publicHost = allowedHosts?.find((h) => !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h));
// || : compose passes an unset variable as "".
const publicUrl = process.env.HIVE_PUBLIC_URL || (publicHost ? `https://${publicHost}` : null);
const webhookStore = new WebhookStore(hive.db);
const dispatcher = new WebhookDispatcher(webhookStore, { publicUrl });
const sso = oidcSettings(process.env, publicUrl);
const oidc = sso ? new OidcClient(sso) : null;
if (sso) console.log(`[xdev-hive] SSO: ${sso.name} (${sso.issuer}), redirect URI ${sso.redirectUri}`);
// Cảnh báo (roadmap 22m): rules checked every minute; an alert that opens goes to the webhooks that want it.
const alerts = new AlertStore(hive, {
  webhooks: webhookStore,
  backup,
  onOpen: (alert) => void dispatcher.notify({ type: "alert.opened", project: alert.project, alert }),
});
onEvent = (event) => {
  alerts.onEvent(event);
  void dispatcher.notify(event);
};
setInterval(() => void alerts.check().catch((err) => console.error(`[xdev-hive] alert check failed: ${(err as Error).message}`)), 60_000).unref();

// The doc files in the store, copied after each snapshot: only the ones the backup does not have yet.
const logFiles = async (when: string) => {
  if (!backup || !blobs) return;
  try {
    const r = await backupFiles(hive, backup.dir);
    if (r.copied || r.removed || r.missing.length) {
      console.log(`[xdev-hive] backup files (${when}): ${r.copied} copied, ${r.removed} removed, ${r.kept} kept${r.missing.length ? `, ${r.missing.length} missing from ${blobs.name}` : ""}`);
    }
  } catch (err) {
    console.error(`[xdev-hive] backup files (${when}) failed: ${(err as Error).message}`);
  }
};
if (backup) {
  setInterval(() => {
    logBackup("scheduled", () => backupDatabase(hive.db, backup));
    void logFiles("scheduled");
  }, backup.hours * 3_600_000).unref();
}

// Doc files still in the database go to the store: right after start, then every minute. The store usually starts with
// the hub: while it does not answer in the first 2 minutes, again every 5 s. The files moved are backed up at once.
if (blobs) {
  let reported: string | null = null;
  const move = async () => {
    let total = 0;
    for (let n = await hive.moveFilesToStore(); n > 0; n = await hive.moveFilesToStore()) total += n;
    const { lastError, inDb } = hive.filesInfo();
    if (lastError !== reported) console.error(lastError ? `[xdev-hive] files (${blobs.name}, ${blobs.where}): ${lastError}` : `[xdev-hive] files (${blobs.name}) working again`);
    reported = lastError;
    if (total) {
      console.log(`[xdev-hive] files: ${total} moved to ${blobs.name}${inDb ? `, ${inDb} still in the database` : ""}`);
      await logFiles("moved");
    }
  };
  const startedAt = Date.now();
  const round = () =>
    void move()
      .catch(() => undefined)
      .finally(() => setTimeout(round, hive.filesInfo().lastError && Date.now() - startedAt < 120_000 ? 5_000 : 60_000).unref());
  round();
}

// Vectors for memory approved since the last round: right after start, then every 20 s. An error is logged when it changes.
if (embedder) {
  let reported: string | null = null;
  const index = async () => {
    let total = 0;
    for (let n = await hive.indexMemory(); n > 0; n = await hive.indexMemory()) total += n;
    const { lastError } = await hive.call("memory.searchInfo", {}, { name: "hub", role: "admin" });
    if (lastError !== reported) console.error(lastError ? `[xdev-hive] embeddings (${embedder.model}): ${lastError}` : `[xdev-hive] embeddings (${embedder.model}) working again`);
    reported = lastError;
    if (total) console.log(`[xdev-hive] embeddings (${embedder.model}): ${total} memory entries indexed`);
  };
  void index().catch(() => undefined);
  setInterval(() => void index().catch(() => undefined), 20_000).unref();
}

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

httpServer.on(
  "request",
  createHubApp({
    hive,
    tokens,
    users,
    allowedHosts,
    ui,
    trustProxy: process.env.HIVE_TRUST_PROXY === "1",
    webhooks: { store: webhookStore, dispatcher },
    alerts,
    hub: (hubInfo = new HubInfoSource({
      hive,
      dbPath,
      users,
      backup,
      embedUrl: process.env.HIVE_EMBED_URL || null,
      sso: sso ? { name: sso.name, issuer: sso.issuer } : null,
      allowedHosts: allowedHosts ?? null,
      publicUrl,
      trustProxy: process.env.HIVE_TRUST_PROXY === "1",
      commit: process.env.HIVE_COMMIT || null,
    })),
    oidc,
    // Desktop builds sit next to the database (the data volume in Docker).
    releases: new ReleaseStore(hive.db, path.join(path.dirname(dbPath), "releases")),
  }),
);
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
