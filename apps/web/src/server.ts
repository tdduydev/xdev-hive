// xDev Hive hub: shared docs, memory and tasks for a team, plus MCP over HTTP.
//   HIVE_PORT=7788 HIVE_HOST=127.0.0.1 HIVE_DB=./data/hub.db
//   HIVE_ALLOWED_HOSTS=hive.xdev.asia   (required behind a reverse proxy / public hostname)
//   HIVE_LAN_HOSTS=10.86.140.52,my-server (names and addresses the hub also answers to on the LAN, see
//     deploy/compose.lan.yaml; they come after HIVE_ALLOWED_HOSTS, so the public hostname stays the hub's own URL)
//   HIVE_MEMORY_APPROVAL=off            (memory from agents is visible without admin approval)
//   HIVE_MEMORY_STALE_DAYS=90           (memory no agent used for this long is left out of agents' searches; 0 = never)
//   HIVE_RUN_LOG_DAYS=30                (a run's log and diff are dropped this long after its last update, the rest of
//     the run — summary, MR, cost — stays for good; 0 = keep logs too)
//   HIVE_ARTIFACT_DAYS=30               (a done task's run artifacts are dropped this long after they were sent; 0 = keep)
//   HIVE_RELEASE_KEEP=3                 (app releases whose builds stay on disk; the rollout target always stays)
//   HIVE_PUBLIC_URL=https://hive.xdev.asia (links in webhook messages; default: https:// + the first allowed host)
//   HIVE_BOOTSTRAP_TOKEN=...            (fixed admin token for automated deploys)
//   HIVE_ADMIN_USER=admin              (name of the first admin account, created with a temporary password)
//   HIVE_SETUP=1                       (no account yet: a setup page and a code in the log instead of that admin,
//     roadmap 75; its choices go to settings.json next to the database and fill the HIVE_* variables left unset)
//   HIVE_TRUST_PROXY=1                 (behind a TLS proxy: Secure cookies, client address from X-Forwarded-For)
//   HIVE_BACKUP_DIR=/data/backups       (snapshot on start and every HIVE_BACKUP_HOURS=24, keep HIVE_BACKUP_KEEP=7 unpinned;
//     the ones made by hand or before a project deletion are pinned out of that count for HIVE_BACKUP_PIN_DAYS=180
//     (0 = until unpinned), and pinning by hand stops at HIVE_BACKUP_PIN_MAX_MB=20480 of pinned snapshots)
//   HIVE_OIDC_ISSUER=https://gitlab.example.com HIVE_OIDC_CLIENT_ID=… HIVE_OIDC_CLIENT_SECRET=… HIVE_OIDC_NAME=GitLab
//     (sign-in through an OpenID Connect provider; redirect URI: <HIVE_PUBLIC_URL>/api/auth/oidc/callback)
//   HIVE_REMOTE_TERMINAL=1              (remote terminal, spec 69: off unless exactly 1; each machine still opts in locally)
//   HIVE_GATE_JOBS=1                    (gate jobs, spec 69h1: off unless exactly 1; each machine still declares its templates locally)
//   HIVE_EMBED_URL=http://ollama:11434/v1 (memory search by meaning too: an OpenAI-compatible /embeddings endpoint;
//     HIVE_EMBED_MODEL=bge-m3, HIVE_EMBED_KEY for an API, HIVE_EMBED_MIN_SCORE=0.5 cosine for a match by meaning)
//   HIVE_SEAWEEDFS_URL=http://seaweedfs:8888 (doc files in a SeaweedFS filer instead of the database; the ones already
//     in it move there; HIVE_SEAWEEDFS_PREFIX=/xdev-hive/doc-files. Backups copy them into <HIVE_BACKUP_DIR>/files)
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { HiveError, openAiEmbedder, terminalHubEnabled, type HiveEvent } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor, createHubApp, terminalUpgrade, type HubAppOptions } from "./app.ts";
import { applySetupFile, readSetupFile, SetupGate } from "./hub-setup.ts";
import { backupDatabase, backupFile, backupFiles, backupSettings, type BackupResult } from "./backup.ts";
import { seaweedFromEnv } from "./seaweed.ts";
import { OidcClient, oidcSettings } from "./oidc.ts";
import { TokenStore } from "./tokens.ts";
import { UserStore } from "./users.ts";
import { DEFAULT_RELEASE_KEEP, ReleaseStore } from "./releases.ts";
import { Automation } from "./automation.ts";
import { WebhookDispatcher, WebhookStore } from "./webhooks.ts";
import { AlertStore } from "./alerts.ts";
import { HubInfoSource } from "./hubinfo.ts";
import { buildInfo } from "./build-info.ts";

import { deployLog, hubLog } from "#web/deploy-log.ts";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.HIVE_PORT ?? 7788);
const host = process.env.HIVE_HOST ?? "127.0.0.1";
const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(root, "data", "hub.db"));
const production = process.env.NODE_ENV === "production";
// Before anything reads a HIVE_* setting: the setup page's choices fill what the environment leaves unset (roadmap 75).
const setupPath = path.join(path.dirname(dbPath), "settings.json");
const setupFile = readSetupFile(setupPath);
const setupLocked = applySetupFile(process.env, setupFile);
const backup = backupSettings(process.env);

const logBackup = (when: string, take: () => BackupResult | null) => {
  try {
    const r = take();
    if (when === "start") deployLog.backup = r ? "ok" : "skipped";
    if (r) console.log(`[xdev-hive] backup (${when}) ${r.file}${r.removed.length ? `, removed ${r.removed.length} old` : ""}`);
  } catch (err) {
    if (when === "start") deployLog.backup = "error";
    hubLog.error(`[xdev-hive] backup (${when}) failed: ${(err as Error).message}`);
  }
};
// Before opening the hub: the snapshot predates any schema migration this version runs.
if (backup) logBackup("start", () => backupFile(dbPath, { ...backup, reason: "start" }));

const staleDays = Number(process.env.HIVE_MEMORY_STALE_DAYS ?? 90);
const runLogDays = Number(process.env.HIVE_RUN_LOG_DAYS ?? 30);
const artifactDays = Number(process.env.HIVE_ARTIFACT_DAYS ?? 30);
const releaseKeep = Number(process.env.HIVE_RELEASE_KEEP ?? DEFAULT_RELEASE_KEEP);
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
  artifactDays: Number.isFinite(artifactDays) && artifactDays >= 0 ? artifactDays : 30,
  onEvent: (event) => onEvent(event),
  embedder,
  embedMinScore: Number.isFinite(minScore) ? minScore : 0.5,
  blobs,
  gateJobs: process.env.HIVE_GATE_JOBS === "1",
  // Deleting a project snapshots the whole hub first (roadmap 47), the same snapshot the Hub page's "Backup ngay"
  // makes, pinned out of the rotation under the project's name. With HIVE_BACKUP_DIR unset this throws
  // errors.backupOff, and nothing is deleted.
  backup: async ({ project }) => {
    if (!hubInfo) throw new HiveError("conflict", "The hub is still starting up.", { key: "errors.backupOff" });
    return hubInfo.backup(`delete:${project}`);
  },
});
hive.seed("hub", { hub: true });
let artifactsPrunedAt = 0;
const cleanupRound = () => {
  try { hive.queueMemoryCleanup(); }
  catch (err) { hubLog.error(`[xdev-hive] memory cleanup scheduling failed: ${(err as Error).message}`); }
  // Hourly is plenty for a 30-day retention, and keeps the join off every minute.
  if (Date.now() - artifactsPrunedAt < 60 * 60_000) return;
  artifactsPrunedAt = Date.now();
  void hive.pruneArtifacts().catch((err) => hubLog.error(`[xdev-hive] artifact cleanup failed: ${(err as Error).message}`));
};
cleanupRound();
setInterval(cleanupRound, 60_000).unref();
// The model router's nightly learning (54d): checked every minute, done once a night; a hub down at night catches up.
const learnRound = () => {
  try {
    const changed = hive.learnModels();
    if (changed) console.log(`[xdev-hive] model learning: ${changed} cells changed`);
  } catch (err) {
    hubLog.error(`[xdev-hive] model learning failed: ${(err as Error).message}`);
  }
};
learnRound();
setInterval(learnRound, 60_000).unref();

const tokens = new TokenStore(hive.db);
const users = new UserStore(hive.db);
if (process.env.HIVE_BOOTSTRAP_TOKEN) tokens.ensure(process.env.HIVE_BOOTSTRAP_TOKEN, "bootstrap", "admin");
// No account yet on a hub started for setup (the root compose.yaml): the setup page creates the admin, with the code
// printed here. Otherwise (deploy/compose.yaml, a hub from before accounts): an admin with a temporary password.
let setup: SetupGate | undefined;
if (users.count() === 0 && process.env.HIVE_SETUP === "1" && !setupFile?.done) {
  setup = new SetupGate({
    file: setupPath,
    env: process.env,
    locked: setupLocked,
    users,
    announce: (code) => console.log(`\n  Hub not set up yet: open its page in a browser and enter this setup code:\n\n  ${code}\n`),
    // Docker's restart policy brings the hub back with the settings it just wrote.
    onDone: () => {
      console.log("[xdev-hive] setup saved, restarting to apply it");
      setTimeout(() => process.exit(0), 300).unref();
    },
  });
} else if (users.count() === 0) {
  const username = (process.env.HIVE_ADMIN_USER ?? "admin").trim().toLowerCase();
  const { password } = users.create({ username, displayName: "Admin", admin: true });
  console.log(`\n  First admin account: ${username}\n  Temporary password (shown once; the first sign-in asks for a new one):\n\n  ${password}\n`);
}

const allowedHosts = allowedHostsFor(process.env.HIVE_ALLOWED_HOSTS, host, process.env.HIVE_LAN_HOSTS);

const publicHost = allowedHosts?.find((h) => !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h));
// || : compose passes an unset variable as "".
const publicUrl = process.env.HIVE_PUBLIC_URL || (publicHost ? `https://${publicHost}` : null);
const automation = new Automation(hive, (owner) => {
  if (owner.startsWith("user:")) {
    const user = users.get(owner.slice(5));
    return user && !user.disabled ? { name: user.username, role: user.admin ? "admin" : "member", account: user.username, access: users.access(user) } : null;
  }
  if (owner.startsWith("token:")) {
    const token = tokens.get(owner.slice(6));
    if (!token) return null;
    const user = token.ownerId ? users.get(token.ownerId) : null;
    if (token.ownerId && (!user || user.disabled)) return null;
    return { name: token.name, tokenId: token.id, role: token.role === "admin" && user && !user.admin ? "member" : token.role,
      ...(user ? { account: user.username, access: users.access(user) } : {}) };
  }
  return null;
});
const webhookStore = new WebhookStore(hive.db);
const dispatcher = new WebhookDispatcher(webhookStore, { publicUrl });
const sso = oidcSettings(process.env, publicUrl);
const oidc = sso ? new OidcClient(sso) : null;
if (sso) console.log(`[xdev-hive] SSO: ${sso.name} (${sso.issuer}), redirect URI ${sso.redirectUri}`);
// Cảnh báo (roadmap 22m): rules checked every minute; an alert that opens goes to the webhooks that want it.
const alerts = new AlertStore(hive, {
  webhooks: webhookStore,
  deployLog,
  backup,
  onOpen: (alert) => onEvent({ type: "alert.opened", project: alert.project, alert }),
});
onEvent = (event) => {
  alerts.onEvent(event);
  void automation.onEvent(event).catch((err) => hubLog.error(`[xdev-hive] automation event failed: ${(err as Error).message}`));
  void dispatcher.notify(event);
};
setInterval(() => void alerts.check().catch((err) => hubLog.error(`[xdev-hive] alert check failed: ${(err as Error).message}`)), 60_000).unref();

// The doc files in the store, copied after each snapshot: only the ones the backup does not have yet.
const logFiles = async (when: string) => {
  if (!backup || !blobs) return;
  try {
    const r = await backupFiles(hive, backup.dir);
    if (r.copied || r.removed || r.missing.length) {
      console.log(`[xdev-hive] backup files (${when}): ${r.copied} copied, ${r.removed} removed, ${r.kept} kept${r.missing.length ? `, ${r.missing.length} missing from ${blobs.name}` : ""}`);
    }
  } catch (err) {
    hubLog.error(`[xdev-hive] backup files (${when}) failed: ${(err as Error).message}`);
  }
};
if (backup) {
  setInterval(() => {
    logBackup("scheduled", () => backupDatabase(hive.db, { ...backup, reason: "scheduled" }));
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
    if (lastError !== reported) (lastError ? hubLog.error : hubLog.log)(lastError ? `[xdev-hive] files (${blobs.name}, ${blobs.where}): ${lastError}` : `[xdev-hive] files (${blobs.name}) working again`);
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
    if (lastError !== reported) (lastError ? hubLog.error : hubLog.log)(lastError ? `[xdev-hive] embeddings (${embedder.model}): ${lastError}` : `[xdev-hive] embeddings (${embedder.model}) working again`);
    reported = lastError;
    if (total) console.log(`[xdev-hive] embeddings (${embedder.model}): ${total} memory entries indexed`);
  };
  void index().catch(() => undefined);
  setInterval(() => void index().catch(() => undefined), 20_000).unref();
}

// Desktop builds sit next to the database (the data volume in Docker).
const releases = new ReleaseStore(hive.db, path.join(path.dirname(dbPath), "releases"), undefined, Number.isFinite(releaseKeep) && releaseKeep >= 1 ? releaseKeep : DEFAULT_RELEASE_KEEP);
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

const build = buildInfo(process.env);
const hubApp = createHubApp({
  hive,
  tokens,
  users,
  allowedHosts,
  ui,
  trustProxy: process.env.HIVE_TRUST_PROXY === "1",
  automation,
  webhooks: { store: webhookStore, dispatcher },
  alerts,
  hub: (hubInfo = new HubInfoSource({
    hive,
    releases,
    deployLog,
    dbPath,
    users,
    backup,
    embedUrl: process.env.HIVE_EMBED_URL || null,
    sso: sso ? { name: sso.name, issuer: sso.issuer } : null,
    allowedHosts: allowedHosts ?? null,
    publicUrl,
    trustProxy: process.env.HIVE_TRUST_PROXY === "1",
    commit: build.commit,
    buildVersion: build.buildVersion,
    buildDate: build.buildDate,
  })),
  build,
  oidc,
  autoReleaseProject: process.env.HIVE_AUTO_RELEASE_PROJECT,
  releases,
  remoteTerminal: terminalHubEnabled(process.env),
  // Machine sockets need the pinned identity (SEC-machine-identity); without it the relay refuses every machine.
  terminalIdentity: {
    isMachineActor: (machineId, actor) => hive.isMachineActor(machineId, actor),
    pinnedOwner: (machineId) => hive.machinePinnedOwner(machineId),
  },
  setup,
});
httpServer.on("request", hubApp);
const upgradeTerminal = terminalUpgrade(hubApp);
// In dev, Vite's HMR listens for its own upgrades on this server; in production nobody else would answer one.
httpServer.on("upgrade", (req, socket, head) => {
  if (!upgradeTerminal(req, socket, head) && production) socket.destroy();
});
httpServer.listen(port, host, () => {
  console.log(`[xdev-hive] hub on http://${host}:${port} (${production ? "production" : "dev"}), db ${dbPath}`);
  if (!allowedHosts) hubLog.warn("[xdev-hive] HIVE_ALLOWED_HOSTS not set: Host header is not validated.");
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
