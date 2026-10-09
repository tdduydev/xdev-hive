import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DESK_ALIASES, DESK_MENU, DESK_PAGES, DESK_SHORTCUTS, resolveDeskHash, webTarget, WEB_ENTRIES } from "#desktop/renderer/desk-nav.ts";
import { formatBytes, loadPercent, percentOf, uptimeParts } from "#desktop/renderer/machine-format.ts";
import { machineStats, type StatsSource } from "#desktop/main/machine-stats.ts";

describe("the app's menu on a hub (roadmap 76h)", () => {
  it("lists only the machine's pages, with ⌘1–6 in menu order", () => {
    assert.deepEqual(DESK_MENU, ["machine", "agents", "runs", "worktrees", "setup", "settings"]);
    assert.deepEqual(DESK_SHORTCUTS, { machine: "1", agents: "2", runs: "3", worktrees: "4", setup: "5", settings: "6" });
    assert.deepEqual(DESK_PAGES, ["start", ...DESK_MENU]);
  });

  it("keeps the addresses the smoke and old links use, rewriting the ones that moved", () => {
    for (const id of ["agents", "runs", "setup", "start"]) assert.equal(resolveDeskHash(`#/${id}`), id);
    assert.equal(resolveDeskHash("#/runs?run=R-1"), "runs");
    assert.equal(resolveDeskHash("#/"), "machine");
    assert.equal(resolveDeskHash(""), "machine");
    assert.deepEqual(DESK_ALIASES, { today: "machine", projects: "settings", tools: "setup" });
    assert.equal(resolveDeskHash("#/projects"), "settings");
  });

  it("sends every other page to the hub's web, and stays when the hub is unknown", () => {
    for (const id of ["tasks", "docs", "chat", "admin", "memory", "board"]) {
      assert.equal(webTarget("https://hive.example/", `#/${id}?x=1`), `https://hive.example/#/${id}?x=1`, id);
      assert.equal(webTarget(null, `#/${id}`), null, id);
    }
    assert.equal(webTarget("https://hive.example", "#/agents"), null);
    assert.equal(webTarget("https://hive.example", "#/today"), null, "Hôm nay is Máy này now");
    assert.deepEqual(WEB_ENTRIES.map((e) => e.id), ["today", "tasks", "chat", "docs", "admin"]);
  });

  it("bundles no page of the web's administration in the hub-mode app", () => {
    const dir = path.join(import.meta.dirname, "../src/renderer");
    const files = [...readdirSync(dir), ...readdirSync(path.join(dir, "pages")).map((f) => `pages/${f}`)].filter((f) => /\.tsx?$/.test(f));
    const web = /@xdev-hive\/ui\/pages\/(Admin|Sections|Docs|Tasks|Memory|Skills|Features|Today|Overview|Users|Webhooks|Machines|Batches|Board)\b/;
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), "utf8");
      assert.doesNotMatch(source, web, `${file} imports a page of the web`);
      // The temporary local app is only ever loaded on demand.
      assert.doesNotMatch(source, /^import[^\n]*@xdev-hive\/ui\/local/m, `${file} imports LocalApp statically`);
    }
  });
});

describe("Máy này figures", () => {
  it("formats bytes, percent, load and uptime", () => {
    assert.equal(formatBytes(null), "—");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KiB");
    assert.equal(formatBytes(16 * 1024 ** 3), "16.0 GiB");
    assert.equal(percentOf(25, 100), 25);
    assert.equal(percentOf(500, 100), 100);
    assert.equal(percentOf(1, 0), null);
    assert.equal(percentOf(null, 10), null);
    assert.equal(loadPercent(0.426), 43);
    assert.equal(loadPercent(null), null);
    assert.deepEqual(uptimeParts(90_061), { days: 1, hours: 1, minutes: 1 });
  });

  it("reads the machine through the source it is given", async () => {
    const source: StatsSource = {
      cpus: () => [{ model: " Apple M4 " }, { model: "Apple M4" }],
      loadavg: () => [1, 0, 0],
      totalmem: () => 16,
      freemem: () => 4,
      uptime: () => 60,
      hostname: () => "mac",
      statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
    };
    const stats = await machineStats("/data", source);
    assert.equal(stats.cpuCount, 2);
    assert.equal(stats.cpuModel, "Apple M4");
    if (process.platform !== "win32") assert.equal(stats.load, 0.5);
    assert.deepEqual([stats.memTotal, stats.memFree, stats.diskTotal, stats.diskFree], [16, 4, 4096 * 1000, 4096 * 250]);
    const gone = await machineStats("/missing", { ...source, statfs: async () => { throw new Error("ENOENT"); } });
    assert.deepEqual([gone.diskTotal, gone.diskFree], [null, null]);
  });
});
