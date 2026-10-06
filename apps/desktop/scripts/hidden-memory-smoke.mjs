// HIVE_HIDDEN_PROBE_SECONDS=600 npm run smoke:hidden -w @xdev-hive/desktop -- <result.json>
// No debugger TCP port: the fixture measures the real app with Electron's in-process debugger API.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { SqliteHive } from "@xdev-hive/core/node";

const appDir = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(os.tmpdir(), "hive-hidden-probe-"));
const home = path.join(work, "home");
mkdirSync(home);
const seconds = Number(process.env.HIVE_HIDDEN_PROBE_SECONDS ?? 600);
if (!Number.isFinite(seconds) || seconds < 10) throw new Error("HIVE_HIDDEN_PROBE_SECONDS must be at least 10");
const out = path.resolve(process.argv[2] ?? path.join(appDir, "../../.xdev-hive/artifacts/hidden-memory.json"));
mkdirSync(path.dirname(out), { recursive: true });
const config = path.join(work, "config.json");
const dbPath = path.join(work, "local.db");
writeFileSync(config, JSON.stringify({ mode: "local", dbPath, projects: [], agents: [] }));
// An inbox item is essential: an empty Today page never mounts the Detail that used to loop.
const db = new SqliteHive(dbPath);
const actor = { name: "probe", role: "admin" };
await db.call("tasks.create", { id: "PROBE-1", project: "probe", title: "Renderer memory regression fixture" }, actor);
await db.call("tasks.update", { id: "PROBE-1", status: "review" }, actor);
db.close();

const child = spawn(electron, [path.join(appDir, "scripts/hidden-memory-fixture.mjs"), "--hidden", `--user-data-dir=${path.join(work, "profile")}`], {
  cwd: work,
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".state"), HIVE_CONFIG: config,
    HIVE_SMOKE_HASH: "today", HIVE_MEMORY_PROBE_SECONDS: String(seconds), HIVE_MEMORY_PROBE_RESULT: out, HIVE_MEMORY_PROBE_MAIN: process.env.HIVE_MEMORY_PROBE_MAIN ?? path.join(appDir, "out/main/index.js") },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  logs = (logs + chunk.toString()).slice(-8000);
  process.stdout.write(chunk);
});
const timeout = setTimeout(() => child.kill("SIGKILL"), (seconds + 180) * 1000);
const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ error: String(error) }));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
let report;
try { report = JSON.parse(readFileSync(out, "utf8")); }
catch { report = { seconds, samples: [], failure: "Electron exited before reporting measurements" }; }
report.exit = result;
report.logs = logs;
writeFileSync(out, JSON.stringify(report, null, 2));
rmSync(work, { recursive: true, force: true });
if (report.failure || result.code !== 0) throw new Error(`${report.failure ?? JSON.stringify(result)}; details in ${out}`);
console.log(`hidden renderer memory smoke passed: ${out}`);
