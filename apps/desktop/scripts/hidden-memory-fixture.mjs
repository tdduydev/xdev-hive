// Runs only under the isolated smoke launcher; imports the production main process and exercises its window lifecycle.
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

if (!process.env.HIVE_MEMORY_PROBE_MAIN || !process.env.HIVE_MEMORY_PROBE_RESULT) throw new Error("Launch this fixture through smoke:hidden");
const seconds = Number(process.env.HIVE_MEMORY_PROBE_SECONDS);
const report = { seconds, samples: [], failure: null };
let calls = 0;
let crashes = 0;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, (...args) => {
  calls++;
  return listener(...args);
});
const hook = `window.__probeCommits = 0; window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, inject: () => 1, onCommitFiberRoot: () => window.__probeCommits++, onCommitFiberUnmount: () => {}
};`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (promise, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`renderer did not respond within ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
};
const check = (ok, message) => { if (!ok) throw new Error(message); };
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("render-process-gone", (_event, details) => {
    crashes++;
    (report.crashEvents ??= []).push({ reason: details.reason, exitCode: details.exitCode });
  });
});
await import(pathToFileURL(process.env.HIVE_MEMORY_PROBE_MAIN).href);
async function probe() {
// Main's asynchronous readiness work must complete before activate has IPC handlers to call.
await pause(5000);

async function sample(phase, window) {
  const metrics = app.getAppMetrics().filter((m) => m.type === "Tab");
  const row = { phase, atSeconds: Math.round(process.uptime()), rendererCount: metrics.length, webContentsCount: webContents.getAllWebContents().length, workingSetKB: metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0), calls, crashes };
  if (window && !window.isDestroyed()) {
    row.heap = await bounded(window.webContents.debugger.sendCommand("Runtime.getHeapUsage"));
    row.commits = await bounded(window.webContents.executeJavaScript("window.__probeCommits"));
    row.hidden = await bounded(window.webContents.executeJavaScript("document.hidden"));
  }
  report.samples.push(row);
  console.log(JSON.stringify(row));
  check(crashes === 0, "renderer crashed during the probe");
  return row;
}

try {
  // Observe mode opens and hides a loaded page, for comparing a build from before the renderer-free tray fix.
  if (process.env.HIVE_HIDDEN_PROBE_OBSERVE === "1") {
    app.emit("activate");
    await pause(5000);
    const window = BrowserWindow.getAllWindows()[0];
    check(window, "activate did not create a window");
    window.webContents.debugger.attach("1.3");
    window.hide();
    for (let elapsed = 0; ; elapsed = Math.min(elapsed + 60, seconds)) {
      await sample("observe-loaded-hidden", window);
      if (elapsed >= seconds) break;
      await pause(Math.min(60, seconds - elapsed) * 1000);
    }
  } else {
    for (let elapsed = 0; ; elapsed = Math.min(elapsed + 60, seconds)) {
      const row = await sample("cold-hidden");
      // Linux Chromium may keep one spare renderer with no WebContents; it must not retain an app page or grow unbounded.
      check(row.webContentsCount === 0 && BrowserWindow.getAllWindows().length === 0, "hidden startup retained an app page");
      check(row.rendererCount <= 1 && row.workingSetKB < 128 * 1024, "hidden startup retained excess renderer memory");
      check(calls === 0, "hidden startup invoked renderer IPC");
      if (elapsed >= seconds) break;
      await pause(Math.min(60, seconds - elapsed) * 1000);
    }
    app.emit("activate");
    await pause(5000);
    const window = BrowserWindow.getAllWindows()[0];
    check(window, "activate did not create a window");
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Page.enable");
    await window.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: hook });
    window.webContents.reload();
    await pause(5000);
    const hasItem = await bounded(window.webContents.executeJavaScript('Boolean(document.querySelector("[role=option][aria-selected=true]"))'));
    check(hasItem, "Today fixture did not select an inbox item");
    const before = await sample("today-visible-start", window);
    check(Number.isFinite(before.commits), "React commit instrumentation did not load");
    await pause(30_000);
    const after = await sample("today-visible-end", window);
    check(after.commits - before.commits < 100, "Today has a continuous React commit loop");
    check(after.heap.usedSize < 256 * 1024 ** 2 && after.heap.usedSize - before.heap.usedSize < 64 * 1024 ** 2, "Today heap exceeded 256 MiB or grew by 64 MiB in 30 seconds");
    window.minimize();
    await pause(3000);
    // Bare xvfb may have no window manager to implement minimize. Exercise hide in that environment as well.
    if (!await bounded(window.webContents.executeJavaScript("document.hidden"))) {
      report.minimizeUnsupported = true;
      window.hide();
      await pause(3000);
    }
    const hidden = await sample("minimized-start", window);
    check(hidden.hidden, "minimizing/hiding the window did not hide the document");
    await pause(35_000);
    const idle = await sample("minimized-end", window);
    check(idle.calls === hidden.calls, "renderer kept polling while minimized");
    window.restore();
    window.show();
    await pause(3000);
    const shown = await sample("restored", window);
    check(!shown.hidden && shown.calls > idle.calls, "restoring did not resume renderer queries");
    window.close();
    await pause(3000);
    const closed = await sample("closed-to-tray");
    check(closed.webContentsCount === 0 && BrowserWindow.getAllWindows().length === 0, "closing did not release the app page");
    check(closed.rendererCount <= 1 && closed.workingSetKB < 128 * 1024, "closing retained excess renderer memory");
    app.emit("activate");
    await pause(5000);
    const reopened = BrowserWindow.getAllWindows()[0];
    check(reopened && reopened.webContents.getURL().includes("#today"), "reopening did not preserve the page");
    check(await bounded(reopened.webContents.executeJavaScript('Boolean(document.querySelector("[role=option][aria-selected=true]"))')), "reopening did not render Today");
    // Crash the disposable fixture only, and prove the production handler reloads three times then stops.
    let reloads = 0;
    reopened.webContents.on("did-finish-load", () => reloads++);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const recovered = attempt <= 3 ? new Promise((resolve) => reopened.webContents.once("did-finish-load", resolve)) : pause(4000);
      reopened.webContents.forcefullyCrashRenderer();
      await bounded(recovered, 15000);
      check(reloads === Math.min(attempt, 3), `crash recovery budget failed at attempt ${attempt}: ${reloads} reloads`);
    }
    report.recoveryReloads = reloads;
  }
} catch (error) {
  report.failure = String(error);
} finally {
  writeFileSync(process.env.HIVE_MEMORY_PROBE_RESULT, JSON.stringify(report, null, 2));
  app.exit(report.failure ? 1 : 0);
}
}
// Electron emits ready after the entry module finishes evaluating; top-level await would deadlock this probe.
void app.whenReady().then(probe).catch((error) => {
  report.failure = String(error);
  writeFileSync(process.env.HIVE_MEMORY_PROBE_RESULT, JSON.stringify(report, null, 2));
  app.exit(1);
});
