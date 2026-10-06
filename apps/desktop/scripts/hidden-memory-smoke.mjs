// A hidden desktop instance must keep the runner alive without retaining a renderer.
// HIVE_HIDDEN_PROBE_SECONDS=600 npm run smoke:hidden -w @xdev-hive/desktop -- <result.json>
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import electron from "electron";

const appDir = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(appDir, "out", "hidden-probe-"));
const home = path.join(work, "home");
mkdirSync(home);
const profile = path.join(work, "profile");
const config = path.join(work, "config.json");
writeFileSync(config, JSON.stringify({ mode: "local", projects: [], agents: [] }));
const seconds = Number(process.env.HIVE_HIDDEN_PROBE_SECONDS ?? 600);
if (!Number.isFinite(seconds) || seconds < 10) throw new Error("HIVE_HIDDEN_PROBE_SECONDS must be at least 10");
const observe = process.env.HIVE_HIDDEN_PROBE_OBSERVE === "1";
const out = path.resolve(process.argv[2] ?? path.join(work, "result.json"));
mkdirSync(path.dirname(out), { recursive: true });
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));

const child = spawn(electron, [appDir, "--hidden", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
  cwd: work,
  env: { ...process.env, HOME: home, HIVE_CONFIG: config },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-8000); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exitWithin = (process, ms) => new Promise((resolve) => {
  if (process.exitCode !== null || process.signalCode !== null) return resolve(process.exitCode);
  const timer = setTimeout(() => { process.kill("SIGKILL"); resolve(-1); }, ms);
  process.once("exit", (code) => { clearTimeout(timer); resolve(code); });
});

async function cdp(wsUrl, method, params = {}) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP heap timeout")), 5000);
      socket.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== 1) return;
        clearTimeout(timeout);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

const samples = [];
let failure = null;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`desktop exited during startup: ${child.exitCode}`);
    if (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.ok, () => false)) break;
    if (attempt === 99) throw new Error("remote debugger did not start");
    await pause(100);
  }
  await pause(3000);
  for (let at = 0; ; at = Math.min(at + 60, seconds)) {
    if (at) await pause((at - (samples.at(-1)?.seconds ?? 0)) * 1000);
    if (child.exitCode !== null) throw new Error(`desktop exited early: ${child.exitCode}`);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const pages = targets.filter((target) => target.type === "page");
    const heaps = await Promise.all(pages.map((page) => cdp(page.webSocketDebuggerUrl, "Runtime.getHeapUsage")));
    samples.push({ seconds: at, rendererCount: pages.length, usedHeapBytes: heaps.reduce((sum, result) => sum + result.usedSize, 0) });
    console.log(JSON.stringify(samples.at(-1)));
    if (at >= seconds) break;
  }
  if (!observe && samples.some((sample) => sample.rendererCount !== 0)) throw new Error("hidden desktop retained a renderer");
  if (!observe) {
    // A second launch uses Electron's existing-instance event, the same path as opening the tray window.
    const opener = spawn(electron, [appDir, `--user-data-dir=${profile}`], {
      cwd: work, env: { ...process.env, HOME: home, HIVE_CONFIG: config }, stdio: "ignore",
    });
    const opened = await exitWithin(opener, 10000);
    if (opened !== 0) throw new Error(`second instance did not hand off: ${opened}`);
    let loadedPage = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      loadedPage = targets.find((target) => target.type === "page" && target.url.includes("renderer/index.html"));
      if (loadedPage) break;
      await pause(100);
    }
    if (!loadedPage) throw new Error("opening the hidden desktop did not load its renderer");
    await cdp(loadedPage.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "window.close()" }).catch(() => undefined);
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      if (!targets.some((target) => target.type === "page")) { closed = true; break; }
      await pause(100);
    }
    if (!closed || child.exitCode !== null) throw new Error("closing the window did not return to a live renderer-free tray app");
  }
} catch (err) {
  failure = String(err);
} finally {
  child.kill("SIGTERM");
  await exitWithin(child, 15000);
  writeFileSync(out, JSON.stringify({ seconds, samples, failure, logs }, null, 2));
}
if (failure) throw new Error(`${failure}; details in ${out}`);
console.log(`hidden renderer memory smoke passed: ${out}`);
