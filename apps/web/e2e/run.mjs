// End-to-end test of the hub's web interface (goals QA-1): builds the client, starts a throwaway hub on a free port,
// seeds people, docs and work to approve, then drives the pages in Electron (browser.mjs) as those people would.
// Exits non-zero when a step fails; a screenshot of every step (and of each failure) goes to the output dir.
//   npm run e2e -w @xdev-hive/web [-- <output dir>] [--no-build] [--only step,step] [--repeat N]
// --only runs the seed and the chosen steps with the steps they need (browser.mjs, NEEDS); --repeat reruns them N times, each on a fresh hub.
// Linux without a display: run it under xvfb-run.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { seed } from "./seed.mjs";
import { terminalFixture } from "./terminal-fixture.mjs";

const webDir = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const work = mkdtempSync(path.join(os.tmpdir(), "hive-e2e-"));
// Flags with a value (--only a,b / --repeat 3) must not be taken for the output dir.
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const only = flag("--only");
const repeat = flag("--repeat") === undefined ? 1 : Number(flag("--repeat"));
if (!Number.isInteger(repeat) || repeat < 1) { console.error("--repeat needs a whole number >= 1"); process.exit(2); }
if (args.includes("--only") && !only) { console.error("--only needs a step name (a,b,…)"); process.exit(2); }
const valueArgs = new Set([flag("--only"), flag("--repeat")]);
const baseOut = path.resolve(args.find((a) => !a.startsWith("--") && !valueArgs.has(a)) ?? path.join(work, "shots"));

// The production build, as the hub serves it: a stale dist would test yesterday's pages.
if (!args.includes("--no-build") || !existsSync(path.join(webDir, "dist", "client", "index.html"))) {
  console.log("building the web client…");
  // Through the npm running this script (npm_execpath), so it works where npm is not on PATH.
  const npm = process.env.npm_execpath;
  const built = npm ? spawnSync(process.execPath, [npm, "run", "build", "--", "--logLevel", "warn"], { cwd: webDir, stdio: "inherit" }) : spawnSync("npm", ["run", "build", "--", "--logLevel", "warn"], { cwd: webDir, stdio: "inherit", shell: true });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

function readResult(file) {
  try { return JSON.parse(readFileSync(file, "utf8")).results ?? []; } catch { return []; }
}

async function runOnce(out) {
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "hive-e2e-"));
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const admin = `e2e-${randomBytes(16).toString("hex")}`;
  const backups = path.join(work, "backups");
  mkdirSync(backups, { recursive: true });
  const oldBackup = path.join(backups, "hub-e2e.db");
  writeFileSync(oldBackup, "stale backup fixture");
  const stale = new Date(Date.now() - 10 * 3_600_000);
  utimesSync(oldBackup, stale, stale);
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
      HIVE_BACKUP_DIR: backups,
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
  const terminal = !only || only.split(",").some(step => step.startsWith("terminal-")) ? await terminalFixture() : null;
  const resultFile = path.join(out, "result.json");
  rmSync(resultFile, { force: true });
  const browser = spawn(electron, [...(process.env.HIVE_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), path.join(import.meta.dirname, "browser.mjs")], {
    stdio: "inherit",
    env: { ...process.env, HIVE_E2E_BASE: base, HIVE_E2E_OUT: out, HIVE_E2E_BACKUP_DIR: backups, HIVE_E2E_ONLY: only ?? "", HIVE_E2E_SEED: JSON.stringify({ admin, ...seeded, terminal }), ELECTRON_ENABLE_LOGGING: "" },
  });
  // Chromium can hang while tearing down windows on macOS after every check has finished.
  // Only a completed result may shorten teardown; a stuck test still fails at the overall timeout.
  let completedCode;
  let teardownTimer;
  const completion = setInterval(() => {
    if (completedCode !== undefined || !existsSync(resultFile)) return;
    try {
      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      if (![0, 1].includes(result.exitCode) || !Array.isArray(result.results) || !Array.isArray(result.errors)) return;
      completedCode = result.exitCode;
      teardownTimer = setTimeout(() => browser.kill("SIGKILL"), 5000);
    } catch { /* The browser may still be writing its result. */ }
  }, 100);
  // Only a hang guard: the full phone run passed 5 minutes with the 0.145 steps (≈300 s of steps alone).
  const timer = setTimeout(() => browser.kill("SIGKILL"), 15 * 60_000);
  const code = await new Promise((resolve) => browser.once("exit", (c) => resolve(c ?? completedCode ?? 1)));
  clearInterval(completion);
  clearTimeout(teardownTimer);
  clearTimeout(timer);
  stop();
  terminal?.close();
  if (code !== 0) console.error(`\nhub log:\n${hubLog.split("\n").slice(-40).join("\n")}`);
  console.log(`screenshots in ${out}`);
  return { code, results: readResult(resultFile) };

}

// Fresh hub and seed per round: steps leave their rows behind, so a second round on the same hub would test the leftovers.
const failures = new Map();
let exit = 0;
for (let i = 1; i <= repeat; i++) {
  if (repeat > 1) console.log(`\n== round ${i}/${repeat} ==`);
  const { code, results } = await runOnce(repeat > 1 ? path.join(baseOut, `round-${i}`) : baseOut);
  if (code !== 0) exit = code;
  for (const r of results) failures.set(r.name, (failures.get(r.name) ?? 0) + (r.ok ? 0 : 1));
}
if (repeat > 1) {
  console.log(`\nfailures per step over ${repeat} rounds:`);
  for (const [name, n] of failures) console.log(`  ${n ? "✗" : "✓"} ${name}: ${n}/${repeat}`);
}
process.exit(exit);
