// End-to-end test of the hub's web interface (goals QA-1): builds the client, starts a throwaway hub on a free port,
// seeds people, docs and work to approve, then drives the pages in Electron (browser.mjs) as those people would.
// Exits non-zero when a step fails; a screenshot of every step (and of each failure) goes to the output dir.
//   npm run e2e -w @xdev-hive/web [-- <output dir>] [--no-build]
// Linux without a display: run it under xvfb-run.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { seed } from "./seed.mjs";

const webDir = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const work = mkdtempSync(path.join(os.tmpdir(), "hive-e2e-"));
const out = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(work, "shots"));
mkdirSync(out, { recursive: true });

// The production build, as the hub serves it: a stale dist would test yesterday's pages.
if (!args.includes("--no-build") || !existsSync(path.join(webDir, "dist", "client", "index.html"))) {
  console.log("building the web client…");
  // Through the npm running this script (npm_execpath), so it works where npm is not on PATH.
  const npm = process.env.npm_execpath;
  const built = npm ? spawnSync(process.execPath, [npm, "run", "build", "--", "--logLevel", "warn"], { cwd: webDir, stdio: "inherit" }) : spawnSync("npm", ["run", "build", "--", "--logLevel", "warn"], { cwd: webDir, stdio: "inherit", shell: true });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const admin = `e2e-${randomBytes(16).toString("hex")}`;
const hub = spawn(process.execPath, ["src/server.ts"], {
  cwd: webDir,
  stdio: ["ignore", "pipe", "pipe"],
  // HIVE_BACKUP_DIR: deleting a project snapshots the hub first (roadmap 47) and refuses without somewhere to put it.
  env: {
    ...process.env,
    NODE_ENV: "production",
    HIVE_PORT: String(port),
    HIVE_DB: path.join(work, "hub.db"),
    HIVE_BOOTSTRAP_TOKEN: admin,
    HIVE_ADMIN_USER: "duy",
    HIVE_COMMIT: "e2e",
    HIVE_BACKUP_DIR: path.join(work, "backups"),
  },
});
let hubLog = "";
hub.stdout.on("data", (d) => (hubLog += d));
hub.stderr.on("data", (d) => (hubLog += d));
const stop = () => hub.exitCode === null && hub.kill();
process.on("exit", stop);

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) {
  console.error(`the hub did not start:\n${hubLog}`);
  process.exit(1);
}

const seeded = await seed(base, admin);
const browser = spawn(electron, [path.join(import.meta.dirname, "browser.mjs")], {
  stdio: "inherit",
  env: { ...process.env, HIVE_E2E_BASE: base, HIVE_E2E_OUT: out, HIVE_E2E_SEED: JSON.stringify({ admin, ...seeded }), ELECTRON_ENABLE_LOGGING: "" },
});
const timer = setTimeout(() => browser.kill("SIGKILL"), 5 * 60_000);
const code = await new Promise((resolve) => browser.once("exit", (c) => resolve(c ?? 1)));
clearTimeout(timer);
stop();
if (code !== 0) console.error(`\nhub log:\n${hubLog.split("\n").slice(-40).join("\n")}`);
console.log(`screenshots in ${out}`);
process.exit(code);
