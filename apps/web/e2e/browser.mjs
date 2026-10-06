// The browser half of `npm run e2e` (see run.mjs). Electron stands in for Chromium, so nothing past `npm ci` is needed.
// Input goes through the DevTools protocol (the mouse at an element's centre, typed text, keys), as a person's
// would: Radix menus and the Tiptap editor react to real events, not to element.click().
// Each step checks what the hub now holds through its RPC, not only what the page shows.
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tableCardsChecks } from "./table-cards.mjs";

const base = process.env.HIVE_E2E_BASE;
const out = process.env.HIVE_E2E_OUT;
const width = Number(process.env.HIVE_E2E_W ?? 1440);
const height = Number(process.env.HIVE_E2E_H ?? 900);
if (!Number.isInteger(width) || width < 320 || !Number.isInteger(height) || height < 480) throw new Error("invalid HIVE_E2E_W/HIVE_E2E_H");
const mobile = width < 768;
const { admin, people, proposals, memory } = JSON.parse(process.env.HIVE_E2E_SEED);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Chromium's own warnings (task policy, sandbox) are not the test's.
app.commandLine.appendSwitch("log-level", "3");
app.dock?.hide();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, input = {}, token = admin) {
  const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ method, input }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** Polls the hub (as the admin) until `fn` gives something truthy. */
async function until(what, fn) {
  const stop = Date.now() + 10_000;
  let last = null;
  for (;;) {
    last = await fn().catch((err) => (last = err) && null);
    if (last) return last;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  End: { code: "End", keyCode: 35 },
  s: { code: "KeyS", keyCode: 83 },
};
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** One person's browser: its own storage partition, so two people are signed in side by side. */
class Tab {
  errors = [];

  static async open(name) {
    const win = new BrowserWindow({ show: false, useContentSize: true, width, height, webPreferences: { partition: `e2e-${name}` } });
    const tab = new Tab(win, name);
    win.webContents.on("console-message", (e) => {
      if (e.level === "error" && /Uncaught|TypeError|ReferenceError/.test(e.message)) tab.errors.push(e.message.slice(0, 300));
    });
    win.webContents.on("render-process-gone", (_e, d) => tab.errors.push(`renderer gone: ${d.reason}`));
    win.webContents.debugger.attach("1.3");
    await win.loadURL(`${base}/`);
    return tab;
  }

  constructor(win, name) {
    this.win = win;
    this.name = name;
  }

  cdp(method, params) {
    return this.win.webContents.debugger.sendCommand(method, params);
  }

  /** Runs `fn` in the page with JSON arguments. */
  eval(fn, ...args) {
    return this.win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
  }

  async waitFor(what, fn, ...args) {
    const until = Date.now() + 15_000;
    for (;;) {
      const v = await this.eval(fn, ...args).catch(() => null);
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** Goes to a page of the app (`admin/docs?doc=…`, `proposals`) without reloading it. */
  async go(route) {
    await this.eval((r) => (location.hash = `#/${r}`), route);
    await sleep(400);
  }

  async reload() {
    const done = new Promise((r) => this.win.webContents.once("did-finish-load", r));
    this.win.webContents.reload();
    await done;
    await sleep(300);
  }

  /** The centre of the first visible element matching `selector` (and whose text is or starts with `text`), scrolled into view. */
  async find(selector, text, within) {
    return this.waitFor(
      `${selector}${text ? ` "${text}"` : ""}${within ? ` in ${within}` : ""}`,
      (sel, txt, scope) => {
        const root = scope ? [...document.querySelectorAll(scope)].at(-1) : document;
        if (!root) return null;
        const shown = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        };
        const all = [...root.querySelectorAll(sel)].filter(shown);
        const label = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        const el = txt == null ? all[0] : (all.find((e) => label(e) === txt) ?? all.find((e) => label(e).startsWith(txt)));
        if (!el || el.disabled) return null;
        // Scrolling a transformed React Flow node changes the pane under the pointer.
        if (!sel.startsWith("[data-graph-task")) el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      selector,
      text ?? null,
      within ?? null,
    );
  }

  async click(selector, text, within) {
    if (mobile && selector === "[data-project-picker-trigger]") {
      const hidden = await this.eval(() => {
        const r = document.querySelector("[data-project-picker-trigger]")?.getBoundingClientRect();
        return r && (r.right <= 0 || r.left >= innerWidth);
      });
      if (hidden) await this.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    }
    const { x, y } = await this.find(selector, text, within);
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(150);
  }

  async type(text) {
    await this.cdp("Input.insertText", { text });
    await sleep(80);
  }

  async key(name, ...mods) {
    const k = KEYS[name] ?? { code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0) };
    const modifiers = mods.reduce((m, x) => m | MODIFIERS[x], 0);
    const common = { key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.cdp("Input.dispatchKeyEvent", { type: k.text && !modifiers ? "keyDown" : "rawKeyDown", ...common, ...(k.text && !modifiers ? { text: k.text } : {}) });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    await sleep(80);
  }

  /** A native <select>: sets the value as React expects (through the prototype's setter) and fires change. */
  async select(selector, value) {
    await this.find(selector);
    const ok = await this.eval(
      (sel, v) => {
        const el = document.querySelector(sel);
        if (!el || ![...el.options].some((o) => o.value === v && !o.disabled)) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      selector,
      value,
    );
    if (!ok) throw new Error(`${selector} has no option ${value}`);
    await sleep(150);
  }

  text(selector = "body") {
    return this.eval((sel) => [...document.querySelectorAll(sel)].map((e) => e.innerText).join("\n"), selector);
  }

  async shot(name) {
    const image = await this.win.webContents.capturePage();
    writeFileSync(path.join(out, `${name}.png`), image.toPNG());
  }
}

const results = [];
const overflows = [];
const contentOverflows = [];
let current = null;
let n = 0;
async function step(name, fn) {
  const t0 = Date.now();
  const id = String(++n).padStart(2, "0");
  try {
    await fn();
    await current?.shot(`${id}-${name}`);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
    await current?.shot(`${id}-${name}-FAIL`).catch(() => undefined);
  } finally {
    if (mobile && current) {
      const size = await current.eval(() => {
        const main = document.querySelector("main");
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, mainWidth: main?.clientWidth, mainScrollWidth: main?.scrollWidth, route: location.hash };
      }).catch(() => null);
      if (size && size.scrollWidth > size.width + 1) {
        overflows.push({ step: name, ...size });
        console.log(`    ↔ overflow at ${name}: ${size.scrollWidth}px > ${size.width}px (${size.route})`);
      }
      if (size?.mainWidth && size.mainScrollWidth > size.mainWidth + 1) contentOverflows.push({ step: name, ...size });
    }
  }
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

async function signInWithToken(name, token, route) {
  const tab = await Tab.open(name);
  await tab.eval((t) => localStorage.setItem("xdev-hive.token", t), token);
  await tab.reload();
  await tab.go(route);
  return tab;
}

// Not a top-level await: in an ES module main, Electron is not ready until the module has finished loading.
app.whenReady().then(main);

async function main() {
  console.log("e2e: the hub's web pages");
  const tabs = {};

  await step("login-token", async () => {
    const tab = (current = tabs.admin = await Tab.open("admin"));
    await tab.click("button", "Dùng token truy cập thay cho tài khoản");
    await tab.click("#token");
    await tab.type(admin);
    await tab.click('button[type="submit"]');
    // The web opens on Hôm nay for everyone (roadmap 35b), hub admins included.
    await tab.waitFor("the admin's Hôm nay", () => document.querySelector('nav [aria-current="page"]')?.textContent.includes("Hôm nay"));
    // Roadmap 49b: one web shell, its menu by job; a hub admin's has Cài đặt dự án, Máy & agent and Quản trị after the work.
    const nav = await tab.waitFor("the admin's menu", () => document.querySelector("nav")?.innerText.includes("Máy & agent") && document.querySelector("nav").innerText);
    for (const label of ["Làm việc", "Task", "Cài đặt dự án", "Quản trị"]) expect(nav.includes(label), `no ${label} in the admin's menu:\n${nav}`);
    // The Web Admin's old addresses open the tab that holds the page now.
    await tab.go("admin/queue");
    await tab.waitFor("#/admin/queue on Máy & agent › Hàng đợi", () =>
      location.hash === "#/machines?tab=queue" &&
      document.querySelector('nav [aria-current="page"]')?.textContent.includes("Máy & agent") &&
      document.querySelector('[data-page-tab="queue"]')?.getAttribute("aria-current") === "page",
    );
  });

  await step("scope-search-tasks", async () => {
    const tab = (current = tabs.admin);
    await tab.go("tasks");
    await tab.waitFor("tasks from several projects", () => document.body.innerText.includes("Việc đầu tiên của payment") && document.body.innerText.includes("Việc đầu tiên của demo"));
    await tab.click("[data-project-picker-trigger]");
    await tab.click('input[aria-label="Tìm dự án hoặc hệ thống…"]');
    await tab.type("pay");
    await tab.waitFor("payment in the picker", () => [...document.querySelectorAll('[role="option"]')].some((item) => item.textContent.includes("payment")));
    await tab.key("Enter");
    await tab.waitFor("only payment tasks", () => document.body.innerText.includes("Việc đầu tiên của payment") && !document.body.innerText.includes("Việc đầu tiên của demo") && !document.body.innerText.includes("Việc đầu tiên của ledger"));
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả dự án");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
  });

  if (mobile) await step("mobile-kanban-forms-dialog", async () => {
    const tab = (current = tabs.admin);
    await tab.go("tasks");
    await tab.click('[data-task-view="kanban"]');
    await tab.waitFor("five phone columns", () => document.querySelector('[data-board-fit="mobile"]')?.querySelectorAll('[data-column]').length === 5);
    expect(await tab.eval(() => document.querySelectorAll('[role="tablist"] [role="tab"]').length === 5), "five status tabs");
    await tab.click('[role="tab"]', "Xong");
    await tab.waitFor("Done tab selected", () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes("Xong"));
    await tab.click('[role="tab"]', "Chưa làm");
    await tab.click('[data-column="todo"] [data-task]');
    await tab.waitFor("task status control", () => !!document.querySelector('[data-slot="sheet-content"] select[aria-label^="Trạng thái"]'));
    const sheet = await tab.eval(() => {
      const r = document.querySelector('[data-slot="sheet-content"]').getBoundingClientRect();
      return { width: r.width, left: r.left, viewport: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    expect(sheet.width <= sheet.viewport + 1 && sheet.left >= -1 && sheet.scroll <= sheet.viewport + 1, `task panel overflow: ${JSON.stringify(sheet)}`);
    await tab.key("Escape");
    await tab.click("[data-new-work-open]");
    await tab.waitFor("phone dialog", () => document.querySelector('[data-slot="dialog-content"]')?.getBoundingClientRect().height >= innerHeight - 1);
    const dialog = await tab.eval(() => {
      const r = document.querySelector('[data-slot="dialog-content"]').getBoundingClientRect();
      return { width: r.width, left: r.left, viewport: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    expect(dialog.width <= dialog.viewport + 1 && dialog.left >= -1 && dialog.scroll <= dialog.viewport + 1, `dialog overflow: ${JSON.stringify(dialog)}`);
    await tab.shot(`${String(n).padStart(2, "0")}-mobile-dialog`);
    await tab.key("Escape");
    await sleep(300);
    await tab.shot(`${String(n).padStart(2, "0")}-mobile-kanban-after`);
  });

  await step("graph", async () => {
    await rpc("tasks.create", { id: "PAY-GRAPH", project: "payment", title: "Kiểm tra sơ đồ", dependsOn: ["PAY-1"] });
    const heartbeat = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" }, body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.135.0", projects: ["payment"], acceptsRuns: true, profiles: [{ id: "graph-plan", label: "Graph plan", kind: "codex", enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 2, sessionPercent: 25, weekPercent: 40 }], runs: [] } }) });
    const beat = await heartbeat.json();
    if (beat.error) throw new Error(`graph heartbeat: ${beat.error.message}`);
    const graphMachine = (await rpc("machines.list")).find((m) => m.machine === "lan-mbp");
    const tab = (current = tabs.admin);
    await tab.click("[data-project-picker-trigger]");
    await tab.click('input[aria-label="Tìm dự án hoặc hệ thống…"]');
    await tab.type("payment");
    await tab.key("Enter");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.go("graph");
    await tab.waitFor("task nodes and dependency edge", () => document.querySelector('[data-graph-task="PAY-1"]') && document.querySelector('[data-graph-task="PAY-GRAPH"]') && document.querySelector(".graph-edge-open .react-flow__edge-path"));
    // Waiting for the changed card proves a fresh response reached the graph before checking its edge again.
    await rpc("tasks.update", { id: "PAY-GRAPH", status: "review" });
    await tab.waitFor("graph reflects the updated task", () => document.querySelector('[data-graph-task="PAY-GRAPH"]')?.getAttribute("aria-label")?.includes("Chờ review"));
    await tab.waitFor("dependency edge survives a graph refresh", () => {
      const edge = document.querySelector('.graph-edge-open[data-id="payment:PAY-1->payment:PAY-GRAPH"] .react-flow__edge-path');
      if (!edge) return false;
      const box = edge.getBoundingClientRect();
      const canvas = document.querySelector("[data-graph-canvas]").getBoundingClientRect();
      const style = getComputedStyle(edge);
      return edge.getTotalLength() > 0 && box.width > 0 && box.right > canvas.left && box.left < canvas.right && box.bottom > canvas.top && box.top < canvas.bottom && style.visibility === "visible" && style.stroke !== "none" && Number(style.strokeWidth.replace("px", "")) > 0 && Number(style.opacity) > 0;
    });
    await tab.shot("graph-task-layer");
    expect(!!(await tab.eval(() => document.querySelector('[data-graph-layer="task"]')?.getAttribute("aria-pressed") === "true")), "Task layer is active");
    const locked = await tab.eval(() => [...document.querySelectorAll('[aria-label="Lớp sơ đồ"] button:disabled')].length);
    expect(locked === 2, `SDLC and System layers are shown but locked: ${locked}`);
    const label = await tab.eval(() => document.querySelector('[data-graph-task="PAY-GRAPH"]')?.getAttribute("aria-label") ?? "");
    expect(label.includes("PAY-GRAPH") && label.includes("Kiểm tra sơ đồ"), `node label for screen readers: ${label}`);
    // Spec 51, Mobile: no minimap on a phone, and the zoom controls stay big enough to touch.
    const minimap = await tab.eval(() => !!document.querySelector(".react-flow__minimap"));
    expect(minimap === !mobile, `minimap shown: ${minimap}`);
    const control = await tab.eval(() => document.querySelector(".react-flow__controls button")?.getBoundingClientRect().height ?? 0);
    expect(control >= 44, `zoom control height: ${control}`);
    await tab.click('[data-graph-task="PAY-GRAPH"]');
    const openedHash = await tab.eval(() => location.hash);
    expect(openedHash.startsWith("#/tasks?task=PAY-GRAPH") || openedHash === "#/tasks", `graph click route: ${openedHash}`);
    await tab.waitFor("existing task sheet", () => document.querySelector('[role="dialog"]')?.textContent.includes("Kiểm tra sơ đồ"));
    await tab.key("Escape");
    await tab.go("graph");
    await tab.click('[data-graph-layer="agent"]');
    await tab.waitFor("agent graph profile", (id) => !!document.querySelector(`[data-graph-profile="${id}:graph-plan"]`) && !!document.querySelector('[data-graph-unassigned="PAY-GRAPH"]'), graphMachine.id);
    const profileText = await tab.text(`[data-graph-profile="${graphMachine.id}:graph-plan"]`);
    expect(profileText.includes("25%") && profileText.includes("40%") && profileText.includes("chỗ trống"), `profile status and quota: ${profileText}`);
    if (mobile) {
      await tab.click('[data-graph-unassigned="PAY-GRAPH"]');
      await tab.select("[data-graph-agent-select]", JSON.stringify([graphMachine.id, "graph-plan"]));
      await tab.click("[data-graph-assign]");
    } else {
      const dropped = await tab.eval((id) => {
        const source = document.querySelector('[data-graph-unassigned="PAY-GRAPH"]');
        const destination = document.querySelector(`[data-graph-profile="${id}:graph-plan"]`);
        if (!source || !destination) return false;
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        destination.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
        destination.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
        return true;
      }, graphMachine.id);
      expect(dropped, "desktop graph drag source and target exist");
    }
    await until("graph assigned the task", async () => (await rpc("tasks.list", { project: "payment" })).find((task) => task.id === "PAY-GRAPH")?.agent?.profileId === "graph-plan");
    await tab.waitFor("assigned task on agent graph", () => !!document.querySelector('[data-graph-agent-task="PAY-GRAPH"]'));
    await tab.shot("graph-agent-layer");
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả dự án");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
  });

  // Roadmap 40c: in a system's scope the Docs tree has the system's pages first, then a group per service, and a new page
  // goes to system/<name>/ unless another place is picked.
  await step("docs-system-default", async () => {
    await rpc("docs.save", { key: "system/ban-hang/tong-quan", title: "Tổng quan", content: "# Tổng quan\n\nBa service.\n", baseVersion: 0 });
    const tab = (current = tabs.admin);
    await tab.click("[data-project-picker-trigger]");
    await tab.click('input[aria-label="Tìm dự án hoặc hệ thống…"]');
    await tab.type("ban-hang");
    await tab.click('[role="option"]', "ban-hang");
    // Otherwise the drawer's scrim takes the click on "+ Trang" and no form opens (the "new page's key" timeout).
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.go("docs");
    await tab.waitFor("the system's page before the service groups", () => {
      const rows = [...document.querySelectorAll('[role="tree"] > div')];
      const first = rows.findIndex((r) => r.querySelector('[title="system/ban-hang/tong-quan"]'));
      const groups = ["demo", "ledger", "payment"].map((p) => rows.findIndex((r) => r.dataset.serviceGroup === p));
      return first === 0 && groups.every((g) => g > first);
    });
    await tab.click("button", "+ Trang");
    await tab.type("Quy ước chung");
    const key = await tab.waitFor("the new page's key", () => document.querySelector("[data-new-doc-key]")?.textContent.trim());
    expect(key === "system/ban-hang/quy-uoc-chung", `new page key: ${key}`);
    const places = await tab.eval(() => [...(document.querySelector("select[data-doc-owner]")?.options ?? [])].map((o) => o.value));
    expect(["sys:ban-hang", "demo", "ledger", "payment"].every((o) => places.includes(o)), `places to put it: ${places}`);
    await tab.key("Enter");
    await tab.waitFor("the new page picked in the tree", () => document.querySelector('[role="treeitem"][aria-selected="true"]')?.getAttribute("title") === "system/ban-hang/quy-uoc-chung");
    // On a phone too the new page opens on its editor (only shown ones are clicked), not behind the assistant.
    await tab.click(".ProseMirror");
    await tab.type("Mọi service dùng chung.");
    // On a phone saving sits in the modes menu (roadmap 42b), as in docs-rich-editor.
    if (mobile) await tab.click("summary", "Chế độ");
    await tab.click("button", "Lưu thành v1");
    await until("the page saved in the system", async () => (await rpc("docs.get", { key: "system/ban-hang/quy-uoc-chung" }))?.version === 1);
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả dự án");
    // Picking a scope leaves the phone drawer open; its scrim would take admin-grants-a-role's clicks.
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
  });

  await step("login-password", async () => {
    const tab = (current = tabs.hoa = await Tab.open("hoa"));
    await tab.click("#username");
    await tab.type("hoa");
    await tab.click("#password");
    await tab.type(people.hoa.password);
    await tab.key("Enter");
    await tab.waitFor("Hoa signed in", () => !document.querySelector("#username") && document.body.innerText.includes("@hoa"));
    // A member's menu has no project settings or hub administration (Máy & agent, the team's machines, stays).
    const nav = await tab.eval(() => document.querySelector("nav")?.innerText ?? "");
    for (const label of ["Cài đặt dự án", "Quản trị", "Đội máy", "Hàng đợi", "Nhật ký"]) expect(!nav.includes(label), `${label} in Hoa's menu:\n${nav}`);
  });

  // Roadmap 49b: the menu by job, for a hub admin and for a project member (Hoa reviews payment). Token and the
  // password are in the account menu; old addresses land on their tab.
  await step("nav-by-job", async () => {
    const menus = [
      ["admin", tabs.admin, ["Hôm nay", "Chat", "Sơ đồ", "Tính năng", "Task", "Agent đang chạy", "Tài liệu", "Skill", "Memory", "Cài đặt dự án", "Máy & agent", "Quản trị"]],
      ["member", tabs.hoa, ["Hôm nay", "Sơ đồ", "Tính năng", "Task", "Agent đang chạy", "Tài liệu", "Skill", "Memory", "Máy & agent"]],
    ];
    for (const [who, tab, want] of menus) {
      current = tab;
      await tab.go("today");
      if (mobile) await tab.click(`button[aria-label="Ẩn hoặc hiện thanh bên"]`);
      const items = await tab.waitFor(`${who}'s menu`, () => {
        // The label is the link's first span; a count may follow it.
        const links = [...document.querySelectorAll("nav [data-nav-list] a")].map((a) => a.querySelector("span")?.textContent.trim());
        return links.length > 0 && links;
      });
      expect(JSON.stringify(items) === JSON.stringify(want), `${who}'s menu: ${JSON.stringify(items)}`);
      await tab.shot(`${String(n).padStart(2, "0")}-nav-${who}`);
      // Token sits in the account menu now.
      await tab.click('nav button[aria-label="Tài khoản"]');
      await tab.waitFor("Token in the account menu", () => !!document.querySelector("[data-account-tokens]"));
      await tab.shot(`${String(n).padStart(2, "0")}-nav-${who}-account`);
      await tab.click("[data-account-tokens]");
      await tab.waitFor("the Token page", () => location.hash === "#/tokens" && !document.querySelector('[role="menu"]'));
      if (mobile) await tab.waitFor("the drawer closed after the account menu", () => document.querySelector("nav[aria-label='Điều hướng']")?.getBoundingClientRect().right <= 0);
    }
    // A member following an admin's old link lands on Hôm nay, not on a page they may not open.
    current = tabs.hoa;
    await tabs.hoa.go("users");
    await tabs.hoa.waitFor("Hôm nay for Hoa", () => document.querySelector('nav [aria-current="page"]')?.textContent.includes("Hôm nay"));
  });

  await step("reviewer-approves-a-guide-not-context", async () => {
    const tab = (current = tabs.hoa);
    await tab.go("proposals");
    await tab.waitFor("the guide's proposal", () => document.body.innerText.includes("Thêm bước cài"));
    if (mobile) await tab.click("button", `#${proposals.payGuide}`);
    // The context proposal (AGENTS.md of payment) has no Duyệt for a reviewer: only the guide's can be approved.
    const approvable = await tab.eval(() => [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Duyệt" && !b.disabled).length);
    expect(approvable === 1, `${approvable} proposals Hoa can approve, expected 1 (the guide)`);
    await tab.click("button", "Duyệt");
    await until("the guide's approval", async () => (await rpc("proposals.list", {})).find((p) => p.id === proposals.payGuide)?.status === "approved");
    const all = await rpc("proposals.list", {});
    expect(all.find((p) => p.id === proposals.payAgents)?.status === "pending", "the context proposal should stay pending");
  });

  await step("lead-sees-members", async () => {
    const tab = (current = tabs.lan = await signInWithToken("lan", people.lan.token, "members"));
    const text = await tab.waitFor("the members of payment", () => document.body.innerText.includes("Hoa Trần") && document.body.innerText);
    expect(/Minh Lê/.test(text), "Minh is a member of payment");
  });

  await step("admin-grants-a-role", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/users");
    await tab.waitFor("the users table", () => document.body.innerText.includes("@minh"));
    const { x, y } = await tab.waitFor("Minh's Phân quyền", () => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.textContent.includes("@minh"));
      const b = row && [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === "Phân quyền");
      if (!b) return null;
      b.scrollIntoView({ block: "center", inline: "center" });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await tab.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await tab.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await tab.find('[role="dialog"]');
    expect((await tab.text('[role="dialog"]')).includes("@minh"), "the grants dialog is not Minh's");
    await tab.select('[role="dialog"] select[aria-label="Quyền trên demo"]', "reviewer");
    await tab.waitFor("the reviewer grant selected", () => document.querySelector('[role="dialog"] select[aria-label="Quyền trên demo"]')?.value === "reviewer");
    if (mobile) {
      // The full-screen grant sheet belongs to 42d; keyboard activation keeps this flow covered meanwhile.
      await tab.eval(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Lưu quyền")?.focus());
      await tab.key("Enter");
    } else await tab.click('[role="dialog"] button', "Lưu quyền");
    await tab.waitFor("the dialog to close", () => !document.querySelector('[role="dialog"]'));
    const minh = await until("Minh's reviewer grant", async () => {
      const user = (await rpc("users.list", {})).find((u) => u.username === "minh");
      return user?.grants.demo === "reviewer" && user;
    });
    expect(JSON.stringify(minh.grants.demo) === '"reviewer"', `Minh on demo: ${JSON.stringify(minh.grants.demo)}`);
  });

  await step("docs-rich-editor", async () => {
    const tab = (current = tabs.admin);
    await tab.go(`admin/docs?doc=${encodeURIComponent("project/demo/huong-dan")}`);
    if (mobile) await tab.click("summary", "Chế độ");
    await tab.click('[role="radio"]', "Sửa");
    await tab.click(".ProseMirror p");
    await tab.key("End");
    await tab.key("Enter");
    await tab.type("Xem thêm ");
    await tab.type("/");
    await tab.find('[role="listbox"]');
    await tab.type("link");
    await tab.key("Enter");
    await tab.click('input[aria-label^="Tìm trang để liên kết"]');
    await tab.type("Sơ đồ");
    await tab.click('[role="option"]', "Sơ đồ");
    await tab.key("Enter");
    await tab.type("/table");
    await tab.key("Enter");
    await tab.find(".ProseMirror table");
    await tab.type("Cột A");
    if (mobile) {
      const toolsFit = await tab.eval(() => [...document.querySelectorAll('[role="toolbar"] button')].filter((el) => el.getBoundingClientRect().height > 0).every((el) => { const r = el.getBoundingClientRect(); return r.width >= 40 && r.height >= 40; }));
      expect(toolsFit, "editor toolbar keeps 40px touch targets");
      await tab.shot("mobile-docs-edit");
      await tab.click("summary", "Chế độ");
    }
    await tab.click("button", "Lưu thành v2");
    const doc = await until("version 2", async () => {
      const d = await rpc("docs.get", { key: "project/demo/huong-dan" });
      return d?.version === 2 && d;
    });
    // Saved as Markdown: the link to the page and a table whose first header is what was typed.
    expect(doc.content.includes("[[so-do]]"), `no link to so-do in:\n${doc.content}`);
    expect(/\|\s*Cột A\s*\|/.test(doc.content), `no table in:\n${doc.content}`);
  });

  await step("docs-markdown", async () => {
    const tab = (current = tabs.admin);
    if (mobile) await tab.click("summary", "Chế độ");
    await tab.click('[role="radio"]', "Markdown");
    if (mobile) await tab.eval(() => document.querySelector('textarea[aria-label^="Nội dung"]')?.focus());
    else await tab.click('textarea[aria-label^="Nội dung"]');
    // The caret to the end, then typed as a person would.
    await tab.eval(() => {
      const area = document.querySelector('textarea[aria-label^="Nội dung"]');
      area.setSelectionRange(area.value.length, area.value.length);
    });
    await tab.type("\nViết bằng Markdown.\n");
    await tab.key("s", process.platform === "darwin" ? "Meta" : "Control");
    const doc = await until("version 3", async () => {
      const d = await rpc("docs.get", { key: "project/demo/huong-dan" });
      return d?.version >= 3 && d;
    });
    expect(doc.version === 3 && doc.content.includes("Viết bằng Markdown."), `v${doc.version}:\n${doc.content}`);
  });

  await step("mermaid-draws", async () => {
    const tab = (current = tabs.admin);
    await tab.go(`admin/docs?doc=${encodeURIComponent("project/demo/so-do")}`);
    await tab.click('[role="radio"]', "Xem");
    await tab.waitFor("the diagram", () => document.querySelector('[data-mermaid] [role="img"] svg'));
  });

  await step("mermaid-error", async () => {
    const tab = (current = tabs.admin);
    await tab.go(`admin/docs?doc=${encodeURIComponent("project/demo/so-do-loi")}`);
    await tab.waitFor("the diagram's error", () => document.querySelector('[data-mermaid] [role="alert"]'));
  });

  // Roadmap 38g: a page goes to another space (project → system) with its history, and the key it had still leads to it.
  await step("docs-move-space", async () => {
    const tab = (current = tabs.admin);
    await rpc("docs.save", { key: "project/demo/tai-lieu-cu", title: "Tài liệu cũ", content: "# Tài liệu cũ\n\nChuyển sang hệ thống.\n", baseVersion: 0 });
    await tab.go(`admin/docs?doc=${encodeURIComponent("project/demo/tai-lieu-cu")}`);
    // A page the cached list has not seen opens only after another docs.get and a list reload; until then the
    // previous step's page is still open, and the Space select would move that one instead.
    const picked = (key) => document.querySelector('[role="treeitem"][aria-selected="true"]')?.getAttribute("title") === key;
    await tab.waitFor("the new page open", picked, "project/demo/tai-lieu-cu");
    if (mobile) await tab.click("summary", "Chế độ");
    await tab.click('[role="radio"]', "Markdown");
    await tab.select("[data-doc-space]", "system:ban-hang");
    const moved = await until("the page in the system's space", async () => await rpc("docs.get", { key: "system/ban-hang/tai-lieu-cu" }));
    expect(moved.version === 1, `v${moved.version}: moving a page does not make a version`);
    const old = await rpc("docs.get", { key: "project/demo/tai-lieu-cu" });
    expect(old?.key === "system/ban-hang/tai-lieu-cu", `the old key leads to ${old?.key}`);
    await tab.waitFor("the page open in the system's space", picked, "system/ban-hang/tai-lieu-cu");
  });

  // Roadmap 38g: removing takes the page out of the lists without losing it; it comes back from Đã xoá.
  await step("docs-remove-page", async () => {
    const tab = (current = tabs.admin);
    await tab.click("[data-doc-remove]");
    await tab.click("[data-doc-remove-confirm]");
    await until("the page out of the list", async () => !(await rpc("docs.list", {})).some((d) => d.key === "system/ban-hang/tai-lieu-cu"));
    const gone = await rpc("docs.get", { key: "system/ban-hang/tai-lieu-cu" });
    expect(gone?.removedAt && gone.version === 1, `removed page: ${JSON.stringify(gone)}`);
    expect((await rpc("docs.history", { key: "system/ban-hang/tai-lieu-cu" })).length === 1, "its versions stay");
    await tab.click('[data-doc-restore="system/ban-hang/tai-lieu-cu"]');
    await until("the page back", async () => (await rpc("docs.list", {})).some((d) => d.key === "system/ban-hang/tai-lieu-cu"));
  });

  // Roadmap 38g: a key whose work is over leaves the scope picker (36a) once no machine, page or open task is on it.
  await step("project-retire", async () => {
    const tab = (current = tabs.admin);
    await rpc("tasks.update", { id: "LEDGER-1", status: "done" });
    await tab.go("policy");
    await tab.select("[data-retire-project]", "ledger");
    await tab.click("[data-retire-start]");
    await tab.click("[data-retire-confirm]");
    await until("ledger at rest with nothing left on it", async () => (await rpc("projects.retired", {})).some((r) => r.project === "ledger" && r.hidden));
    await tab.go("tasks");
    await tab.click("[data-project-picker-trigger]");
    await tab.waitFor("ledger gone from the picker", () => [...document.querySelectorAll('[role="option"]')].length > 0 && ![...document.querySelectorAll('[role="option"]')].some((o) => o.textContent.includes("ledger")));
    await tab.key("Escape");
    // At phone width the picker sits in the nav drawer, which Escape leaves open over the next step's page.
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
  });

  await step("bulk-approve-proposals", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/review");
    await tab.click("label, button", "Chọn tất cả");
    await tab.click('[role="toolbar"] button', "Duyệt");
    await until("every proposal approved", async () => (await rpc("proposals.list", {})).every((p) => p.status === "approved"));
  });

  await step("bulk-approve-memory", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/memory");
    await tab.click("button", "Chờ duyệt");
    await tab.click("label, button", "Chọn tất cả");
    await tab.click('[role="toolbar"] button', "Duyệt");
    await until("the memory approved", async () => {
      const list = await rpc("memory.list", { limit: 50 });
      return memory.every((id) => list.find((m) => m.id === id)?.status === "approved");
    });
  });

  // Roadmap 22n: a machine of Lan's with payment's repo hears the request at its heartbeat and reports how it went.
  await step("sync-request", async () => {
    const tab = (current = tabs.admin);
    const beat = async () => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.0.0-e2e", projects: ["payment"] } }),
      });
      return (await r.json()).result;
    };
    await beat();
    await tab.go("admin/context");
    await tab.select('select[aria-label="Dự án"]', "payment");
    await tab.waitFor("Lan's machine on the card", () => document.body.innerText.includes("lan-mbp"));
    await tab.click("button", "Yêu cầu máy đồng bộ");
    const cmd = await until("the request at the machine's heartbeat", async () => (await beat()).syncCommands?.find((c) => c.project === "payment"));
    const report = (status, output) =>
      fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method: "machines.commandResult", input: { id: cmd.id, status, ...(output ? { output } : {}) } }),
      });
    await report("running");
    await report("done", JSON.stringify({ changed: ["AGENTS.md", "CLAUDE.md"], skipped: [], commit: "abc1234", mirrored: 2, note: null }));
    // The card looks again every 5 seconds while a request is open.
    await tab.waitFor("Đã đồng bộ on the card", () => /Đã đồng bộ[\s\S]*2 file đổi/.test(document.body.innerText));
  });

  // Roadmap 18d: the owner of a machine turns one of its subscriptions off on Máy & run; the machine hears it at its
  // heartbeat. Another member sees the machine, not its switches.
  await step("machine-profiles", async () => {
    const profile = (id, enabled, priority) => ({ id, label: id, kind: "claude", enabled, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority });
    const beat = async (profiles) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.95.0", projects: ["payment"], profiles } }),
      });
      return (await r.json()).result;
    };
    const before = [profile("claude-1", true, 10), profile("claude-2", true, 20)];
    await beat(before);
    let tab = (current = tabs.hoa);
    await tab.go("machines");
    await tab.waitFor("Lan's machine for Hoa", () => document.body.innerText.includes("lan-mbp") && document.body.innerText.includes("claude-2"));
    expect(!(await tab.eval(() => !!document.querySelector('[aria-label="Bật gói claude-1"]'))), "Hoa got the switches of Lan's machine");
    tab = current = tabs.lan;
    await tab.go("machines");
    // On the agent map (31b) the switches are under each machine's column.
    await tab.click("summary", "Bật/tắt và ưu tiên gói");
    await tab.click('[aria-label="Bật gói claude-1"]');
    await tab.waitFor("the change waiting on the page", () => document.body.innerText.includes("chờ máy áp dụng"));
    await until("the change at Lan's heartbeat", async () => (await beat(before)).profileChanges?.find((c) => c.profileId === "claude-1" && c.enabled === false && c.requestedBy === "lan"));
    // The machine saved it and reports claude-1 off: nothing left to send, the page shows the switch off.
    const after = await beat([profile("claude-1", false, 10), profile("claude-2", true, 20)]);
    expect(after.profileChanges.length === 0, `still sent: ${JSON.stringify(after.profileChanges)}`);
    await tab.reload();
    await tab.go("machines");
    await tab.click("summary", "Bật/tắt và ưu tiên gói");
    await tab.waitFor("claude-1 off, nothing waiting", () => document.querySelector('[aria-label="Bật gói claude-1"]')?.getAttribute("aria-checked") === "false" && !document.body.innerText.includes("chờ máy áp dụng"));
  });

  // Roadmap 32b: Lan, payment's lead, prompts an agent from the Tasks page with one of her machine's profiles; the hub
  // makes task P-<n> and the request, and the machine gets it at its heartbeat.
  await step("web-prompt", async () => {
    const profile = (id) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10 });
    const beat = async () => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({
          method: "machines.heartbeat",
          input: { machine: "lan-mbp", instance: "e2e00001", version: "0.108.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1"), profile("claude-2")] },
        }),
      });
      return (await r.json()).result;
    };
    await beat();
    const tab = (current = tabs.lan);
    await tab.go("tasks");
    await tab.click("[data-new-work-open]");
    await tab.click('[data-new-work-path="quick"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("#new-work-title");
    await tab.type("Thêm trang lịch sử giao dịch.");
    await tab.click("#new-work-description");
    await tab.type("Có lọc theo ngày.");
    await tab.click("#new-work-done");
    await tab.type("Lọc đúng giao dịch trong khoảng ngày.");
    await tab.select("#new-work-run", "run");
    await tab.waitFor("available agents", () => document.querySelector("#new-work-agent")?.options.length > 1);
    await tab.select("#new-work-agent", "runner.lan-mbp@lan-e2e");
    await tab.select("#new-work-profile", "claude-2");
    await tab.shot(`${String(n).padStart(2, "0")}-new-work-run`);
    await tab.click("[data-new-work-submit]");
    const task = await until("the quick task", async () => (await rpc("tasks.list", { project: "payment" })).find((t) => t.title === "Thêm trang lịch sử giao dịch."));
    const sent = (await beat()).runRequests?.find((r) => r.taskId === task.id);
    expect(sent?.profileId === "claude-2", `assigned request: ${JSON.stringify(sent)}`);
    const req = sent;
    expect(task.note.includes("Có lọc theo ngày.") && task.note.includes("Xong khi\nLọc đúng"), `note: ${task.note}`);
    await tab.waitFor("new task panel", (title) => document.querySelector('[data-slot="sheet-content"]')?.textContent.includes(title), task.title);
    // Leave the hub as the other steps expect it.
    await rpc("tasks.unassign", { id: task.id });
    await rpc("runs.cancelRequest", { id: req.id });
  });

  await step("new-work", async () => {
    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("tasks");
    expect(await tab.eval(() => !document.querySelector("[data-create-task-toggle], [data-prompt-agent]") && !document.body.innerText.includes("task_claim")), "task page uses human wording and one create entry");
    await tab.click("[data-new-work-open]");
    await tab.waitFor("three start paths", () => document.querySelectorAll("[data-new-work-path]").length === 3);
    await tab.shot(`${String(n).padStart(2, "0")}-new-work-choices`);
    await tab.click('[data-new-work-path="ask"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("#new-work-title");
    await tab.type("Nên bắt đầu kiểm tra thanh toán từ đâu?");
    await tab.click("[data-new-work-submit]");
    await tab.waitFor("question carried into Chat", () => location.hash.startsWith("#/chat") && [...document.querySelectorAll("textarea")].some((el) => el.value === "Nên bắt đầu kiểm tra thanh toán từ đâu?"));
    await tab.shot(`${String(n).padStart(2, "0")}-new-work-chat`);
    await tab.waitFor("closed new work dialog", () => !document.querySelector('[data-slot="dialog-overlay"]'));
    await tab.key("n", "Meta");
    await tab.click('[data-new-work-path="ask"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("#new-work-title"); await tab.type("Câu hỏi tiếp theo khi Chat đang mở");
    await tab.click("[data-new-work-submit]");
    await tab.waitFor("replace an existing Chat draft", () => [...document.querySelectorAll("textarea")].some((el) => el.value === "Câu hỏi tiếp theo khi Chat đang mở"));
    await tab.waitFor("closed question dialog", () => !document.querySelector('[data-slot="dialog-overlay"]'));
    await tab.click("[data-new-work-open]");
    await tab.click('[data-new-work-path="feature"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("[data-new-work-submit]");
    // Roadmap 49d: on the web the new feature's form is on Tính năng, above its board.
    await tab.waitFor("full feature form on Tính năng", () => location.hash.startsWith("#/features?") && document.querySelector('[data-feature-new="payment"] textarea') && document.body.innerText.includes("Viết spec"));
    await tab.shot(`${String(n).padStart(2, "0")}-new-work-spec`);
    await tab.click('[data-feature-new="payment"] textarea');
    await tab.type("Bản nháp tính năng trước đó");
    await tab.waitFor("draft typed", () => document.querySelector('[data-feature-new="payment"] textarea')?.value === "Bản nháp tính năng trước đó");
    await tab.click("[data-new-work-open]");
    await tab.click('[data-new-work-path="feature"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("[data-new-work-submit]");
    await tab.waitFor("fresh feature draft while Tính năng stays mounted", () => location.hash.startsWith("#/features?") && document.querySelector('[data-feature-new="payment"] textarea')?.value === "");
    await tab.click("[data-new-work-open]");
    await tab.click('[data-new-work-path="quick"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("#new-work-title"); await tab.type("Việc nhỏ chỉ tạo 49c");
    await tab.click("#new-work-description"); await tab.type("Sửa nhãn trên màn hình.");
    await tab.click("#new-work-done"); await tab.type("Nhãn đúng ở cả hai ngôn ngữ.");
    const form = await tab.eval(() => {
      const dialog = document.querySelector("[data-new-work]");
      return { overflow: dialog.scrollWidth > dialog.clientWidth, smallInputs: [...dialog.querySelectorAll("input, textarea, select")].some((el) => parseFloat(getComputedStyle(el).fontSize) < 16), smallButtons: [...dialog.querySelectorAll("button")].filter((el) => el.getBoundingClientRect().height < 43.9).map((el) => ({ text: el.textContent, height: el.getBoundingClientRect().height })) };
    });
    expect(!form.overflow && (!mobile || (!form.smallInputs && !form.smallButtons.length)), `new work mobile audit: ${JSON.stringify(form)}`);
    await tab.shot(`${String(n).padStart(2, "0")}-new-work-quick`);
    await tab.click("[data-new-work-submit]");
    const task = await until("create-only task", async () => (await rpc("tasks.list", { project: "payment" })).find((t) => t.title === "Việc nhỏ chỉ tạo 49c"));
    expect(task.note === "Sửa nhãn trên màn hình.\n\nXong khi\nNhãn đúng ở cả hai ngôn ngữ.", `quick note: ${task.note}`);
    expect(!(await rpc("runs.requests", { project: "payment" })).some((r) => r.taskId === task.id), "create only does not dispatch");
    expect(!task.agent, "create only leaves agent unassigned");
    await tab.waitFor("quick task opened", (title) => document.querySelector('[data-slot="sheet-content"]')?.textContent.includes(title), task.title);
    const viewer = (current = await signInWithToken("minh", people.minh.token, "tasks"));
    await viewer.go("tasks");
    await viewer.click("[data-new-work-open]");
    expect(await viewer.eval(() => !document.querySelector('[data-new-work-path="quick"], [data-new-work-path="feature"]')), "viewer cannot create tasks or features");
    await viewer.key("Escape");
  });

  // Roadmap 31a: Lan gives two payment tasks to agents at once, one at a time; when the machine reports the first run
  // ended, the hub sends the second.
  await step("batch-run", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = (id) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1 });
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.110.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1"), profile("claude-2")] });
    await beat();
    const tab = (current = tabs.lan);
    // The last step left a task's panel open on Lan's tab, whose overlay would take the first click.
    await tab.reload();
    await tab.go("tasks");
    const second = (await rpc("tasks.list", { project: "payment" })).find((t) => t.title === "Thêm trang lịch sử giao dịch.").id;
    // The "ready next" notice comes in after the table and pushes it down: click once the page has settled.
    await tab.waitFor("the ready-next notice", () => document.body.innerText.includes("Sẵn sàng tiếp theo"));
    // Tasks are picked in the list; the page opens on the board (roadmap 30a).
    await tab.click('[role="radio"]', "Danh sách");
    for (const id of ["PAY-1", second]) {
      await tab.click(`[data-pick-task="${id}"]`);
      await tab.waitFor(`${id} picked`, (x) => document.querySelector(`[data-pick-task="${x}"]`)?.getAttribute("data-state") === "checked", id);
    }
    await tab.click("[data-batch-open]");
    await tab.waitFor("the group's rows", () => document.querySelectorAll("[data-batch-row]").length === 2);
    await tab.click("#batch-parallel");
    await tab.type("1");
    await tab.shot(`${String(n).padStart(2, "0")}-batch-form`);
    await tab.click('button[type="submit"]', "Gửi 2 task");
    const group = await until("the run group", async () => (await rpc("runs.groups", { project: "payment" }))[0]);
    expect(group.maxParallel === 1, `maxParallel: ${group.maxParallel}`);
    // In the table's order: the first goes out now, the other waits for its place.
    const [now, held] = group.items;
    expect(now?.status === "sent" && held?.status === "held", `items: ${group.items.map((i) => `${i.taskId}:${i.status}`).join()}`);
    // The machine takes the first and reports its run over; the next heartbeat brings the second.
    const [first] = (await beat()).runRequests.filter((r) => r.taskId === now.taskId);
    await machineRpc("runs.requestResult", { id: first.id, status: "accepted", runId: "R-batch1" });
    const at = new Date().toISOString();
    await machineRpc("runs.push", {
      machine: "lan-mbp",
      runs: [{ runId: "R-batch1", project: "payment", taskId: now.taskId, taskTitle: now.taskTitle, role: "implement", status: "succeeded", profileId: "claude-1", createdAt: at, finishedAt: at }],
    });
    const next = (await beat()).runRequests.find((r) => r.taskId === held.taskId);
    expect(next, "the second task was not sent after the first run ended");
    await tab.go(`runs?tab=batches&group=${group.id}`);
    await tab.waitFor("the group on Đợt chạy", (id) => document.querySelector(`[data-group] [data-item-task="${id}"]`)?.getAttribute("data-item-state") === "succeeded", now.taskId);
    await tab.shot(`${String(n).padStart(2, "0")}-batch-page`);
    // Leave the hub as the other steps expect it.
    await rpc("runs.cancelGroup", { id: group.id });
  });

  // Roadmap 31e: one prompt for two of Lan's profiles; each runs its own task, and Lan keeps one on Đợt chạy.
  await step("fanout", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = (id) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1 });
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.112.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1"), profile("claude-2")], runs: [] });
    await beat();
    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("tasks");
    // The removed prompt entry no longer starts fan-out; keep the hub fan-out/compare coverage.
    const group = await rpc("runs.fanout", { project: "payment", prompt: "Tối ưu trang thanh toán cho điện thoại.", targets: [{ machineId: "runner.lan-mbp@lan-e2e", profileId: "claude-1" }, { machineId: "runner.lan-mbp@lan-e2e", profileId: "claude-2" }] }, people.lan.token);
    const [a, b] = group.items;
    expect(group.parentTask && a.taskId === `${group.parentTask}-a` && b.taskId === `${group.parentTask}-b`, `items: ${group.items.map((i) => i.taskId).join()}`);
    expect(a.profileId === "claude-1" && b.profileId === "claude-2", `profiles: ${a.profileId}, ${b.profileId}`);
    // The machine runs both and reports them done.
    const sent = (await beat()).runRequests.filter((r) => r.taskId.startsWith(`${group.parentTask}-`));
    expect(sent.length === 2, `sent: ${sent.map((r) => r.taskId).join()}`);
    const at = new Date().toISOString();
    for (const r of sent) {
      await machineRpc("runs.requestResult", { id: r.id, status: "accepted", runId: `R-fan-${r.taskId.slice(-1)}` });
      await machineRpc("runs.push", {
        machine: "lan-mbp",
        runs: [{ runId: `R-fan-${r.taskId.slice(-1)}`, project: "payment", taskId: r.taskId, taskTitle: r.taskTitle, role: "implement", status: "succeeded", profileId: r.profileId, createdAt: at, finishedAt: at }],
      });
    }
    await tab.go(`runs?tab=batches&group=${group.id}`);
    await tab.waitFor("Chọn bản này for b", (id) => document.querySelector(`[data-pick-winner="${id}"]`)?.disabled === false, b.taskId);
    await tab.shot(`${String(n).padStart(2, "0")}-fanout-compare`);
    await tab.click(`[data-pick-winner="${b.taskId}"]`);
    await tab.waitFor("b kept", () => document.body.innerText.includes("Được chọn"));
    const tasks = await rpc("tasks.list", { project: "payment" });
    const status = (id) => tasks.find((t) => t.id === id)?.status;
    expect(status(a.taskId) === "done" && status(group.parentTask) === "done" && status(b.taskId) !== "done", `tasks: ${[a.taskId, b.taskId, group.parentTask].map((id) => `${id}:${status(id)}`).join()}`);
  });

  // Roadmap 34a: the hub admin caps the merge gate at "AI check"; Lan opens payment's spec gate and cannot pick
  // "Automatic" for merge.
  await step("sdlc-gates", async () => {
    const setSelect = (tab, selector, value) =>
      tab.eval(
        (sel, v) => {
          const select = document.querySelector(sel);
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, v);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        },
        selector,
        value,
      );
    let tab = (current = tabs.admin);
    await tab.go("admin/policy");
    await tab.waitFor("the hub's gate row", () => !!document.querySelector('[data-sdlc-row="hub"] [data-sdlc-gate="merge"]'));
    await setSelect(tab, '[data-sdlc-row="hub"] [data-sdlc-gate="merge"]', "ai");
    await tab.click('[data-sdlc-save="hub"]');
    await until("the ceiling on the hub", async () => (await rpc("sdlc.get", {})).ceiling.merge === "ai");
    await tab.shot(`${String(n).padStart(2, "0")}-sdlc-ceiling`);

    tab = current = tabs.lan;
    await tab.reload();
    // Roadmap 49b: a lead's gate rows are on Cài đặt dự án › Chốt & chính sách.
    await tab.go("settings?tab=policy");
    await tab.waitFor("payment's gate row", () => !!document.querySelector('[data-sdlc-row="payment"] [data-sdlc-gate="spec"]'));
    expect(!(await tab.eval(() => !!document.querySelector('[data-sdlc-row="hub"]'))), "a project manager got the hub's row");
    const autoMerge = await tab.eval(() => document.querySelector('[data-sdlc-row="payment"] [data-sdlc-gate="merge"] option[value="auto"]')?.disabled);
    expect(autoMerge === true, `merge "auto" offered over the ceiling: ${autoMerge}`);
    await setSelect(tab, '[data-sdlc-row="payment"] [data-sdlc-gate="spec"]', "auto");
    await setSelect(tab, '[data-sdlc-row="payment"] [data-sdlc-gate="merge"]', "ai");
    await tab.click('[data-sdlc-save="payment"]');
    const got = await until("payment's gates", async () => {
      const p = (await rpc("sdlc.get", {})).projects.payment;
      return p?.gates.spec === "auto" ? p : null;
    });
    expect(got.effective.merge === "ai" && got.effective.plan === "human", `effective: ${JSON.stringify(got.effective)}`);
    // Leave the hub as the other steps expect it.
    await rpc("sdlc.setProject", { project: "payment", settings: null });
    await rpc("sdlc.setCeiling", { ceiling: {} });
  });

  // Roadmap 34b: a Spec Kit flow stops at payment's spec gate (a person's); Lan approves it from the task's panel and
  // the machine gets the plan step.
  await step("sdlc-flow", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = (id, kind) => ({ id, label: id, kind, enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1 });
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.115.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1", "claude"), profile("codex-1", "codex")], runs: [] });
    await beat();
    const lanRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}` }, body: JSON.stringify({ method, input }) });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const started = await lanRpc("specs.runStep", { project: "payment", step: "specify", taskId: "SPEC-E2E", title: "Spec: hoàn tiền", input: "Hoàn tiền một phần cho đơn hàng.", machineId: "runner.lan-mbp@lan-e2e" });
    expect(started.flow.state === "running", `flow: ${started.flow.state}`);
    const [specify] = (await beat()).runRequests.filter((r) => r.taskId === "SPEC-E2E");
    await machineRpc("runs.requestResult", { id: specify.id, status: "accepted", runId: "R-spec1" });
    const at = new Date().toISOString();
    const run = { runId: "R-spec1", project: "payment", taskId: "SPEC-E2E", taskTitle: "Spec: hoàn tiền", role: "implement", profileId: "claude-1", createdAt: at };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "running" }] });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "succeeded", finishedAt: at }] });
    await machineRpc("specs.push", { project: "payment", features: [{ dir: "001-hoan-tien", branch: "ai/SPEC-E2E", commit: "abc1230", files: { spec: "# Hoàn tiền\n", plan: null, tasks: null } }] });

    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("tasks?task=SPEC-E2E");
    await tab.waitFor("the flow waiting at its spec gate", () => document.querySelector('[data-flow="SPEC-E2E"]')?.getAttribute("data-flow-state") === "gate");
    await tab.shot(`${String(n).padStart(2, "0")}-sdlc-flow-gate`);
    await tab.click('[data-flow="SPEC-E2E"] [data-gate-pass]');
    await tab.waitFor("the plan step running", () => document.querySelector('[data-flow="SPEC-E2E"]')?.getAttribute("data-flow-state") === "running");
    const [plan] = (await beat()).runRequests.filter((r) => r.taskId === "SPEC-E2E");
    expect(plan?.instructions.includes('Spec Kit step "plan" for the feature in specs/001-hoan-tien'), `plan request: ${plan?.instructions.slice(0, 120)}`);
    const gates = await rpc("sdlc.gates", { taskId: "SPEC-E2E" });
    expect(gates[0]?.gate === "spec" && gates[0]?.status === "passed" && gates[0]?.decidedBy?.startsWith("lan"), `gate: ${JSON.stringify(gates[0])}`);
    // Leave the hub as the other steps expect it.
    await rpc("runs.cancelRequest", { id: plan.id });
  });

  // Roadmap 18c: a reviewer merges a run's MR from Lượt chạy; the run's machine does it with its own token at its heartbeat.
  await step("merge-from-web", async () => {
    const lanRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      return (await r.json()).result;
    };
    const mrUrl = "https://gitlab.example/team/payment/-/merge_requests/12";
    await lanRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.97.0", projects: ["payment"], acceptsRuns: true });
    await lanRpc("runs.push", {
      machine: "lan-mbp",
      runs: [{ runId: "R-e2emr1", project: "payment", taskId: "PAY-1", taskTitle: "Việc đầu tiên của payment", role: "implement", status: "succeeded", profileId: "claude-1",
        mrUrl, mr: { iid: 12, status: "opened", draft: false, pipeline: "success", pipelineUrl: null, checkedAt: new Date().toISOString() },
        log: "done", createdAt: new Date(Date.now() - 600_000).toISOString(), finishedAt: new Date().toISOString() }],
    });
    // Hoa reviews code in payment; the run is Lan's (her machine's token), so Hoa may merge it.
    const tab = (current = tabs.hoa);
    await tab.go("runs?run=R-e2emr1");
    await tab.waitFor("MR !12 with its CI", () => document.body.innerText.includes("MR !12") && document.body.innerText.includes("CI qua"));
    await tab.click("button", "Merge");
    await tab.waitFor("waiting for Lan's machine", () => document.body.innerText.includes("chờ máy lan-mbp"));
    const order = await until("the merge at Lan's heartbeat", async () =>
      (await lanRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.97.0", projects: ["payment"], acceptsRuns: true })).mergeRuns?.find((m) => m.runId === "R-e2emr1"),
    );
    expect(order.mrUrl === mrUrl && order.requestedBy === "hoa", `merge order: ${JSON.stringify(order)}`);
    await lanRpc("runs.mergeResult", { runId: "R-e2emr1", ok: true });
    await tab.reload();
    await tab.go("runs?run=R-e2emr1");
    await tab.waitFor("merged from Hive, no Merge button", () => document.body.innerText.includes("Đã merge từ Hive") && ![...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Merge"));
  });

  await step("runs-review", async () => {
    const tab = (current = tabs.admin);
    const machineRpc = async (method, input) => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" }, body: JSON.stringify({ method, input }) });
      const result = await response.json();
      if (result.error) throw new Error(`${method}: ${result.error.message}`);
      return result.result;
    };
    const now = new Date().toISOString();
    await machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.135.0", projects: ["payment"], acceptsRuns: true,
      profiles: [{ id: "claude-1", label: "Claude", kind: "claude", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 8 },
        { id: "codex-review", label: "Codex", kind: "codex", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 8 }] });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ runId: "R-e2ereview", project: "payment", taskId: "PAY-1", taskTitle: "Việc đầu tiên của payment", role: "implement", status: "succeeded", profileId: "claude-1", createdAt: now, finishedAt: now,
      summary: "ĐÃ LÀM: Sửa luồng thanh toán\nCHƯA LÀM: Cần bạn xác nhận cách xử lý\nCÁCH KIỂM: npm test\nRỦI RO: CI đang lỗi", log: "[AGENT] Bàn giao", patch: "diff --git a/pay.ts b/pay.ts\n--- a/pay.ts\n+++ b/pay.ts\n@@ -1 +1 @@\n-old\n+new", mrUrl: "https://gitlab.example/team/payment/-/merge_requests/49", mr: { iid: 49, status: "opened", draft: false, pipeline: "failed", pipelineUrl: null, checkedAt: now } }] });
    await tab.go("batches");
    await tab.waitFor("old batch route in runs", () => location.hash === "#/runs");
    if (mobile) await tab.go("runs?run=R-e2ereview");
    await tab.waitFor("run needs a person", () => document.querySelector('[data-run-review]')?.textContent.includes("ĐÃ LÀM") && document.body.innerText.includes("Chờ người"));
    const order = await tab.eval(() => { const body = document.querySelector('[data-run-review]')?.innerText ?? ""; return ["ĐÃ LÀM", "Log", "Thay đổi / MR", "MR !49"].map((s) => body.indexOf(s)); });
    expect(order.every((n) => n >= 0) && order.every((n, i) => i === 0 || n > order[i - 1]), `run review order: ${order}`);
    await tab.shot(`${String(n).padStart(2, "0")}-runs-review-detail`);
    if (mobile) await tab.go("runs");
    await tab.select('select[aria-label="Lọc theo máy"]', "runner.lan-mbp@lan-e2e");
    await tab.select('select[aria-label="Lọc theo task"]', "PAY-1");
    await rpc("tasks.create", { id: "PAY-49E", project: "payment", title: "Giao run gọn" });
    await tab.go("tasks?task=PAY-49E");
    await tab.waitFor("compact run form", () => document.querySelector('select[id="machine-PAY-49E"]') && document.body.innerText.includes("Tuỳ chọn"));
    const compact = await tab.eval(() => ({ machine: document.querySelector('select[id="machine-PAY-49E"]')?.value, closed: ![...document.querySelectorAll("details")].find((d) => d.textContent.includes("Tuỳ chọn"))?.open }));
    expect(compact.machine === "" && compact.closed, `run form defaults: ${JSON.stringify(compact)}`);
    await tab.click('button[type="submit"]', "Chạy");
    const requests = await until("auto-dispatched run", async () => {
      const list = await rpc("runs.requests", { project: "payment" });
      return list.some((r) => r.taskId === "PAY-49E") ? list : null;
    });
    expect(requests.some((r) => r.taskId === "PAY-49E" && r.machineId), `auto-selected machine did not receive the run: ${JSON.stringify(requests.filter((r) => r.taskId === "PAY-49E"))}`);
  });

  // Roadmap 20b: Lan's machine pushes payment's Spec Kit features; Hoa reads one on Spec.
  await step("spec-page", async () => {
    const pushed = await rpc(
      "specs.push",
      {
        project: "payment",
        features: [
          {
            dir: "001-thanh-toan-qr",
            branch: "",
            commit: "abc1234",
            files: {
              spec: "# Feature Specification: Thanh toán QR\n\nNgười dùng quét mã để trả tiền.",
              plan: "# Implementation Plan: Thanh toán QR\n\nDùng VietQR.",
              tasks: "## Phase 1: Setup\n\n- [x] T001 Tạo module qr\n- [ ] T002 [US1] Trang quét mã, src/qr.tsx",
            },
          },
          { dir: "002-hoan-tien", branch: "ai/PAY-SPEC", commit: "def5678", files: { spec: "# Feature Specification: Hoàn tiền", plan: null, tasks: null } },
        ],
      },
      people.lan.token,
    );
    expect(pushed.stored === 2, `specs.push: ${JSON.stringify(pushed)}`);
    const tab = (current = tabs.hoa);
    // Roadmap 49d: on the web the Spec page's link opens the feature on Tính năng.
    await tab.go("specs?project=payment&dir=001-thanh-toan-qr&branch=");
    await tab.waitFor("the feature on Tính năng", () => location.hash.startsWith("#/features?") && document.querySelector("[data-feature-title]")?.getAttribute("data-feature-title") === "Thanh toán QR");
    await tab.click('[role="tab"]', "Spec");
    await tab.waitFor("spec.md", () => document.body.innerText.includes("Người dùng quét mã"));
    await tab.click('[role="tab"]', "Tasks");
    await tab.waitFor("the tasks of tasks.md", () => document.body.innerText.includes("Trang quét mã") && document.body.innerText.includes("1/2"));
    await tab.click("button", "Quay lại danh sách");
    // Neither folder came from a flow: each sits in the column of its stage.
    await tab.waitFor("both features, in the columns of their stages", () => {
      const column = (dir) => document.querySelector(`[data-feature-card="${dir}"]`)?.closest("[data-feature-column]")?.getAttribute("data-feature-column");
      return location.hash === "#/features" && column("001-thanh-toan-qr") === "doing" && column("002-hoan-tien") === "spec" && document.querySelector('[data-feature-card="002-hoan-tien"]').textContent.includes("ai/PAY-SPEC");
    });
  });

  // Roadmap 20c and 20d: Lan (lead of payment) imports tasks.md into board tasks, then has an agent plan the refund
  // feature, which lives on PAY-SPEC's branch: a run of PAY-SPEC with the plan step's instructions.
  await step("spec-import-and-run", async () => {
    await rpc("tasks.create", { id: "PAY-SPEC", project: "payment", title: "Hoàn tiền" });
    await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
      body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.100.0", projects: ["payment"], acceptsRuns: true } }),
    });
    const tab = (current = tabs.lan);
    await tab.go("specs?project=payment&dir=001-thanh-toan-qr&branch=");
    await tab.click('[role="tab"]', "Tasks");
    await tab.click("button", "Nhập thành task");
    await tab.waitFor("the plan of S001-T002", () => document.body.innerText.includes("S001-T002"));
    await tab.click("button", "Nhập 1 task");
    await until("S001-T002 on the board", async () => (await rpc("tasks.list", { project: "payment" })).find((t) => t.id === "S001-T002"));
    await tab.go("specs?project=payment&dir=002-hoan-tien&branch=ai%2FPAY-SPEC");
    await tab.click("button", "Lập kế hoạch");
    await tab.click("textarea");
    await tab.type("Dùng VNPay.");
    await tab.click("button", "Lập kế hoạch");
    const req = await until("the plan run of PAY-SPEC", async () => (await rpc("runs.requests", { project: "payment" })).find((r) => r.taskId === "PAY-SPEC"));
    expect(req.instructions.includes("speckit-plan") && req.instructions.includes("Dùng VNPay.") && req.instructions.includes("specs/002-hoan-tien"), `instructions: ${req.instructions}`);
  });

  // Roadmap 27a: a project's row only tightens the hub's default; the machines get it at their heartbeat.
  await step("agent-policy", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/policy");
    await tab.waitFor("payment's row", () => [...document.querySelectorAll("tr")].some((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ tối đa"]')));
    // The report of 2/10: the card says the policy never widens a profile's own flags.
    await tab.waitFor("the ceiling note", () => document.body.innerText.includes("Chính sách chỉ giới hạn, không cấp thêm quyền"));
    await tab.eval(() => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ tối đa"]'));
      const select = row.querySelector('select[aria-label="Mức tự chủ tối đa"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "read");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const { x, y } = await tab.waitFor("payment's save button", () => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ tối đa"]'));
      const b = row && [...row.querySelectorAll("button")].find((x) => !x.disabled && x.textContent.trim().startsWith("Lưu"));
      if (!b) return null;
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await tab.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await tab.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await until("payment at read", async () => (await rpc("agentPolicy.get", {})).effective?.payment?.autonomy === "read");
    await tab.waitFor("the row saved, with its own part to clear", () => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ tối đa"]'));
      return row && row.innerText.includes("Đã lưu.") && row.innerText.includes("Bỏ phần riêng") && row.innerText.includes("Chỉ đọc");
    });
    // Lan's machine has payment: its heartbeat carries the part.
    const r = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
      body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.0.0-e2e", projects: ["payment"] } }),
    });
    const beat = (await r.json()).result;
    expect(beat.agentPolicy?.projects?.payment?.autonomy === "read", `heartbeat agentPolicy: ${JSON.stringify(beat.agentPolicy)}`);
  });

  // Roadmap 28a: Lan (lead of payment) turns codegraph on for payment on the Tool page; the admin adds an MCP entry to
  // the catalog in the Web Admin, then removes it.
  await step("tools", async () => {
    let tab = (current = tabs.lan);
    await tab.go("tools");
    await tab.select("#tools-project", "payment");
    await tab.select("#tool-codegraph-state", "on");
    await until("codegraph on for payment", async () => (await rpc("tools.list", { project: "payment" })).find((t) => t.id === "codegraph")?.projects[0]?.effective === true);
    await tab.waitFor("the card says it is on", () => !!document.querySelector('[data-tool="codegraph"] [data-tool-effective="on"]'));

    tab = current = tabs.admin;
    await tab.go("admin/tools");
    await tab.click("button[data-tool-add]");
    await tab.click("#tool-form-new-id");
    await tab.type("rtk-mcp");
    await tab.click("#tool-form-new-name");
    await tab.type("RTK");
    await tab.click("#tool-form-new-pkg-name");
    await tab.type("rtk-mcp");
    await tab.click("#tool-form-new-pkg-version");
    await tab.type("latest");
    await tab.waitFor("the pin error under the version", () => document.body.innerText.includes("chưa ghim"));
    await tab.eval(() => {
      const input = document.querySelector("#tool-form-new-pkg-version");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "0.4.1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tab.click("button[data-tool-save]");
    const saved = await until("rtk-mcp in the catalog", async () => (await rpc("tools.list", {})).find((t) => t.id === "rtk-mcp"));
    expect(saved.kind === "mcp" && saved.package?.version === "0.4.1" && saved.mcp?.args.includes("{package}"), `rtk-mcp: ${JSON.stringify(saved)}`);
    await tab.click('[data-tool="rtk-mcp"] button[data-tool-remove]');
    await tab.click('[data-tool="rtk-mcp"] button[data-tool-remove-confirm]');
    await until("rtk-mcp gone", async () => !(await rpc("tools.list", {})).some((t) => t.id === "rtk-mcp"));
    const seeds = await rpc("tools.list", {});
    expect(seeds.some((t) => t.id === "rtk" && t.kind === "hook"), "the migrated RTK hook stays");
    expect(["codegraph", "speckit", "superpowers"].every((id) => seeds.some((t) => t.id === id && t.builtin)), "the seeds stay");
  });

  // Roadmap 27d: the admin stops every agent of the hub; machines hear it, nobody can queue a run until it is lifted.
  await step("stop-all", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/overview");
    // The buttons ask with window.confirm, which a hidden window would wait on forever.
    await tab.eval(() => {
      window.confirm = () => true;
    });
    // Next to the project picker's own button: the hub's says so in its title.
    await tab.click('button[title="cả hub"]', "Dừng mọi agent");
    await until("the hub paused", async () => (await rpc("agents.paused", {})).hub === true);
    const heartbeat = await (
      await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.0.0-e2e", projects: ["payment"] } }),
      })
    ).json();
    expect(heartbeat.result?.paused?.hub === true, `heartbeat paused: ${JSON.stringify(heartbeat.result?.paused)}`);
    const refused = await rpc("runs.dispatch", { machineId: "runner.lan-mbp@lan-e2e", project: "payment", taskId: "PAY-1" }).then(
      () => null,
      (err) => err.message,
    );
    expect(refused?.includes("paused"), `runs.dispatch while paused: ${refused ?? "accepted"}`);
    // The notice is on the Board (spec 27d); here the hub's button turns into the way back.
    await tab.waitFor("Cho agent chạy lại for the hub", () =>
      [...document.querySelectorAll('button[title="cả hub"]')].some((b) => b.textContent.includes("Cho agent chạy lại")),
    );
    await tab.shot(`${String(n).padStart(2, "0")}-stop-all-paused`);
    await tab.click('button[title="cả hub"]', "Cho agent chạy lại");
    await until("the hub running again", async () => (await rpc("agents.paused", {})).hub === false);
  });

  // Roadmap 27c: what an agent wrote, for whom, in which run; filtered by the run on Nhật ký.
  await step("audit-agent", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/audit");
    await tab.click('input[aria-label="Id run"]');
    await tab.type("R-e2e01");
    await tab.key("Enter");
    await tab.waitFor("claude-1's memory, for minh, in R-e2e01", () => {
      // DataTable rows are divs with role="row".
      const rows = [...document.querySelectorAll('[role="row"]')].filter((r) => r.innerText.includes("R-e2e01"));
      return rows.length > 0 && rows.every((r) => r.innerText.includes("claude-1")) && rows.some((r) => r.innerText.includes("minh"));
    });
    const entries = await rpc("admin.audit", { run: "R-e2e01" });
    expect(entries.length > 0 && entries.every((e) => e.agent === "claude-1" && e.onBehalf === "minh"), `audit: ${JSON.stringify(entries).slice(0, 300)}`);
  });

  // Roadmap 27b: a cap of one run on payment (this month); one run's cost fills it, and the hub holds the next.
  await step("budget", async () => {
    const tab = (current = tabs.admin);
    // Roadmap 49b: budgets are set on Quản trị › Ngân sách.
    await tab.go("admin?tab=budgets");
    await tab.click("button", "Thêm trần");
    const pick = (values, value) =>
      tab.eval(
        (vals, v) => {
          const select = [...document.querySelectorAll("select")].find((s) => vals.every((x) => [...s.options].some((o) => o.value === x)));
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, v);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        },
        values,
        value,
      );
    await pick(["project", "user", "hub"], "project");
    await tab.waitFor("the project picker", () => [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.value === "payment")));
    await pick(["payment"], "payment");
    await tab.click('input[inputmode="numeric"]');
    await tab.type("1");
    await tab.click("button", "Lưu");
    await until("the cap on payment", async () => (await rpc("budgets.list", {})).some((b) => b.scope.kind === "project" && b.scope.project === "payment" && b.limit.runs === 1));
    const beat = async (costs = []) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.0.0-e2e", projects: ["payment"], costs } }),
      });
      return (await r.json()).result;
    };
    const cost = { runId: "R-e2e02", project: "payment", taskId: "PAY-1", profileId: "claude-1", account: null, costUsd: 0.42, inputTokens: null, outputTokens: null, finishedAt: new Date().toISOString() };
    await beat([cost]);
    const blocked = (await beat()).budgetBlocked ?? [];
    expect(blocked.some((b) => b.project === "payment"), `budgetBlocked: ${JSON.stringify(blocked)}`);
    const refused = await rpc("runs.dispatch", { machineId: "runner.lan-mbp@lan-e2e", project: "payment", taskId: "PAY-1" }).then(
      () => null,
      (err) => err.message,
    );
    expect(refused !== null && !refused.includes("paused"), `runs.dispatch on a full cap: ${refused ?? "accepted"}`);
    await tab.reload();
    await tab.go("admin?tab=budgets");
    await tab.waitFor("the full cap on the card", () => document.body.innerText.includes("Đã hết trần"));
    await tab.shot(`${String(n).padStart(2, "0")}-budget-full`);
    // Leave the hub as the other steps expect it.
    await rpc("budgets.set", { budgets: [] });
  });

  // Roadmap 28c: tokens apart. A machine reports a run's input fresh, written to and read from the cache; Chi phí shows
  // the share read from the cache.
  await step("token-metrics", async () => {
    await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
      body: JSON.stringify({
        method: "machines.heartbeat",
        input: {
          machine: "lan-mbp",
          instance: "e2e00001",
          version: "0.102.0",
          costs: [{ runId: "R-tok01", project: "demo", taskId: "DEMO-1", profileId: "claude-tok", account: null, costUsd: 0.2, inputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 8000, outputTokens: 300, finishedAt: new Date().toISOString() }],
        },
      }),
    });
    const tab = (current = tabs.admin);
    await tab.go("admin/costs");
    await tab.waitFor("the cache share of claude-tok", () => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.textContent.includes("claude-tok"));
      return document.body.innerText.includes("Đọc cache") && row?.textContent.includes("80%");
    });
  });

  // Roadmap 29c: the lead of payment lets its leader create tasks on its own; the agent policy always waits for a person.
  await step("leader-autonomy", async () => {
    const tab = (current = tabs.lan);
    await tab.go("chat");
    await tab.click("button", "Hướng dẫn leader");
    // The guide's own text names the setting too: wait for its checkboxes, not for the words.
    const policyOff = await tab.waitFor("the autonomy checkboxes", () => {
      const label = [...document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith("Đổi chính sách agent"));
      return label ? { disabled: label.querySelector("button")?.disabled === true } : null;
    });
    expect(policyOff.disabled, "the agent policy is not something the leader may run alone");
    await tab.click("label", "Tạo task");
    await tab.click("button", "Lưu việc tự chạy cho payment");
    await until("payment's leader creating tasks on its own", async () => (await rpc("chat.defaults", { project: "payment" })).autoKinds.includes("task.create"));
  });

  // Roadmap 28e: payment's leader proposes Spec Kit, on and required, for the project; Lan confirms the card in the chat.
  // (Codegraph is on already: the tools step turned it on.)
  await step("leader-tool-proposal", async () => {
    const lanRpc = async (method, input, token = people.lan.token) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const claude = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
    const beat = () => lanRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.104.0", projects: ["payment"], acceptsRuns: true, profiles: [claude] });
    await beat();
    const machineId = (await rpc("machines.list")).find((m) => m.machine === "lan-mbp").id;
    const sent = await rpc("chat.send", { project: "payment", machineId, text: "Bật Spec Kit cho payment" }, people.lan.token);
    // The machine gets the request with the reply's own token, as the leader's MCP would use it.
    const request = await until("the chat request at Lan's heartbeat", async () => (await beat()).chatRequests?.find((r) => r.replyId === sent.reply.id));
    await lanRpc("chat.progress", { replyId: sent.reply.id, text: "Mình đề xuất bật Spec Kit cho payment." });
    const proposed = await lanRpc("chat.propose", { action: { kind: "tool.enable", id: "speckit", enabled: true, required: true }, reason: "Viết spec trước khi làm" }, request.grant);
    expect(proposed.status === "proposed", `payment lets its leader run task.create alone, not this: ${JSON.stringify(proposed)}`);
    await lanRpc("chat.finish", { replyId: sent.reply.id, status: "done", text: "Mình đề xuất bật Spec Kit cho payment." });
    const tab = (current = tabs.lan);
    // The leader guide of the step before stays open otherwise.
    await tab.reload();
    await tab.go(`chat?thread=${sent.thread.id}`);
    await tab.waitFor("the tool card", () => document.body.innerText.includes("Đặt tool Spec Kit cho dự án: bật, bắt buộc") && document.body.innerText.includes("Hiện tại: theo mặc định của tool"));
    await tab.click("button", "Xác nhận");
    await until("Spec Kit on and required for payment", async () => {
      const line = (await rpc("tools.list", { project: "payment" })).find((t) => t.id === "speckit")?.projects[0];
      return line?.effective === true && line.required === true;
    });
    await tab.waitFor("the card done, confirmed by Lan", () => document.body.innerText.includes("Đã làm") && document.body.innerText.includes("lan-e2e xác nhận lúc"));
    if (mobile) {
      await tab.click('button[aria-label="Các cuộc chat"]');
      await tab.click('nav[aria-label="Các cuộc chat"] button', "Bật Spec Kit cho payment");
      await tab.waitFor("thread in address", () => location.hash.includes("thread="));
      await tab.eval(() => history.back());
      await tab.waitFor("browser Back to thread list", () => !!document.querySelector('nav[aria-label="Các cuộc chat"] button'));
      await tab.click('nav[aria-label="Các cuộc chat"] button', "Bật Spec Kit cho payment");
    }
  });

  await step("hub-page", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/hub");
    await tab.waitFor("the hub's cards", () => ["Tệp tài liệu", "Backup"].every((t) => document.body.innerText.includes(t)));
  });

  // Roadmap 19c: a system's docs and memory, shared by its services. Hoa reviews in payment only: she reads the shop
  // system's contract and writes memory there, but may not change the contract (demo is not hers).
  await step("system-docs", async () => {
    await rpc("systems.save", { name: "shop", projects: ["payment", "demo"] });
    await rpc("docs.save", { key: "system/shop/api-contract", title: "API contract", content: "# API contract\n\nPOST /orders trả 201.\n", includeInAgents: true });
    const inPayment = await rpc("docs.list", { project: "payment" }, people.lan.token);
    expect(inPayment.some((d) => d.key === "system/shop/api-contract"), "payment's list has the system's contract");
    const tab = (current = tabs.hoa);
    await tab.go("docs?doc=system/shop/api-contract");
    await tab.waitFor("the contract in the system's space", () => document.body.innerText.includes("POST /orders trả 201.") && document.body.innerText.includes("Hệ thống shop"));
    const memory = await rpc("memory.write", { system: "shop", kind: "decision", content: "Đơn hàng giữ chỗ 15 phút." }, people.hoa.token);
    expect(memory.project === "sys:shop" && memory.status === "pending", `Hoa's system memory: ${JSON.stringify(memory)}`);
    const denied = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${people.hoa.token}` },
      body: JSON.stringify({ method: "docs.save", input: { key: "system/shop/api-contract", title: "API contract", content: "# x\n", baseVersion: 1 } }),
    });
    expect(denied.status === 403, `Hoa saving the contract: HTTP ${denied.status}`);
  });

  // Roadmap 36c: crm is in no system, so the Systems page lists it with its open tasks; the admin finds it with the
  // search and adds it to shop, and it leaves that list.
  await step("systems-outside", async () => {
    await rpc("tasks.create", { id: "CRM-1", project: "crm", title: "Việc đầu tiên của crm" });
    await rpc("tasks.create", { id: "CRM-2", project: "crm", title: "Việc thứ hai của crm" });
    const tab = (current = tabs.admin);
    await tab.reload();
    await tab.go("systems");
    await tab.waitFor("crm outside every system, 2 open tasks", () => document.querySelector('[data-outside-project="crm"]')?.innerText.includes("2 task đang mở"));
    await tab.click("[data-systems-search]");
    await tab.type("crm");
    await tab.waitFor("shop filtered out, crm kept", () => !document.querySelector('[data-system="shop"]') && !!document.querySelector('[data-outside-project="crm"]'));
    await tab.shot(`${String(n).padStart(2, "0")}-systems-search`);
    await tab.click('[data-outside-add="crm"]');
    await tab.click('[role="menuitem"]', "shop");
    await until("crm in shop", async () => (await rpc("systems.list", {})).find((s) => s.name === "shop")?.projects.includes("crm"));
    await tab.waitFor("crm no longer outside", () => !document.querySelector('[data-outside-project="crm"]') && !document.querySelector("[data-systems-outside]"));
    // Leave shop as the other steps expect it.
    await rpc("systems.save", { name: "shop", projects: ["payment", "demo"] });
  });

  // Roadmap 47: a throwaway project is archived (it leaves every list and refuses writes), then deleted for good
  // through the dialog that asks for its name. The hub snapshots itself first, into the run's temporary backup dir.
  await step("project-archive-delete", async () => {
    await rpc("tasks.create", { id: "OLD-1", project: "throwaway", title: "Việc của dự án bỏ đi" });
    await rpc("memory.write", { project: "throwaway", kind: "gotcha", content: "Ghi chú của dự án bỏ đi." });
    await rpc("docs.save", { key: "project/throwaway/arch", title: "Kiến trúc", content: "# Kiến trúc cũ\n" });
    const tab = (current = tabs.admin);
    await tab.reload();
    await tab.go("settings?tab=systems");
    await tab.click("[data-systems-search]");
    await tab.type("throwaway");
    await tab.waitFor("throwaway in the admin's project table", () => !!document.querySelector('[data-project-row="throwaway"]'));
    await tab.click('[data-project-archive="throwaway"]');
    await until("throwaway archived", async () => (await rpc("projects.list", {})).find((p) => p.project === "throwaway")?.state === "archived");
    // Hidden from the lists, and no new writes: the hub says so to the one who tries.
    expect((await rpc("tasks.list", {})).every((t) => t.project !== "throwaway"), "tasks.list still shows the archived project");
    const refused = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
      body: JSON.stringify({ method: "tasks.create", input: { id: "OLD-2", project: "throwaway", title: "x" } }),
    }).then((r) => r.json());
    expect(refused.error?.key === "errors.projectArchived", `writing to an archived project: ${JSON.stringify(refused)}`);
    await tab.shot(`${String(n).padStart(2, "0")}-project-archived`);
    // Xoá hẳn: the dialog only lets the button through once the name is typed in full.
    await tab.click('[data-project-delete="throwaway"]');
    await tab.waitFor("the delete dialog", () => !!document.querySelector("[data-project-delete-name]"));
    await tab.click("[data-project-delete-name]");
    await tab.type("throwaway");
    await tab.shot(`${String(n).padStart(2, "0")}-project-delete-dialog`);
    await tab.click("[data-project-delete-confirm]");
    await until("throwaway deleted", async () => (await rpc("projects.list", {})).find((p) => p.project === "throwaway")?.state === "deleted");
    const left = await rpc("projects.list", {});
    expect(left.find((p) => p.project === "throwaway")?.tasks === 0, "the deleted project still has rows");
    // docs.list of a project also hands back the team's org/* pages (the seed's agent protocol among them), so ask for
    // the project's own space only: scope "project" leaves out org and system docs, which the delete never touches.
    const docs = await rpc("docs.list", { project: "throwaway", scope: "project" });
    expect(docs.length === 0, `the deleted project still has docs: ${JSON.stringify(docs.map((d) => d.key))}`);
    const memory = await rpc("memory.list", { project: "throwaway" });
    expect(memory.length === 0, `the deleted project still has memory: ${JSON.stringify(memory.map((m) => m.content))}`);
    const tasks = await rpc("tasks.list", { project: "throwaway" });
    expect(tasks.length === 0, `the deleted project still has tasks: ${JSON.stringify(tasks.map((t) => t.id))}`);
  });

  // Roadmap 19d: a task of one service waits for another service's (demo waits for payment's), named with its project.
  await step("cross-service-task", async () => {
    const task = await rpc("tasks.create", { id: "DEMO-2", project: "demo", title: "Trang đơn hàng", dependsOn: ["PAY-1"] });
    expect(task.depProjects?.["PAY-1"] === "payment", `DEMO-2: ${JSON.stringify(task)}`);
    const tab = (current = tabs.lan);
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả dự án");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.go("tasks?task=DEMO-2");
    await tab.waitFor("DEMO-2 waiting for payment/PAY-1", () => document.body.innerText.includes("Trang đơn hàng") && document.body.innerText.includes("payment/PAY-1"));
  });

  // Roadmap 41a: a new handover does not erase the one before it — the panel lists them and diffs two neighbours.
  await step("task-note-history", async () => {
    await rpc("tasks.update", { id: "DEMO-1", status: "review", note: "Bàn giao 1:\nĐã dựng trang." });
    await rpc("tasks.update", { id: "DEMO-1", status: "review", note: "Bàn giao 1:\nĐã dựng trang.\nĐã thêm test." });
    const tab = (current = tabs.lan);
    await tab.go("tasks?task=DEMO-1");
    const versions = await tab.waitFor("the two notes in the panel", () => {
      const rows = [...document.querySelectorAll("[data-task-note]")];
      return rows.length === 2 && rows.map((li) => li.getAttribute("data-task-note"));
    });
    expect(JSON.stringify(versions) === JSON.stringify(["2", "1"]), `versions: ${JSON.stringify(versions)}`);
    await tab.click('[data-task-note="2"] button');
    const diff = await tab.waitFor("the diff of the two notes", () => document.querySelector('[data-task-note-diff="2"]')?.innerText);
    expect(diff.includes("Đã thêm test"), `diff: ${diff}`);
  });

  // Roadmap 35c: Hôm nay on the web has what waits for the person: a spec gate and a leader's proposal, decided there.
  await step("today-web", async () => {
    const machineRpc = async (method, input, token = people.lan.token) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = (id, kind) => ({ id, label: id, kind, enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1 });
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.118.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1", "claude"), profile("codex-1", "codex")], runs: [] });
    await beat();
    // A spec step that ran: its flow waits at the spec gate for a person (the default).
    await rpc("specs.runStep", { project: "payment", step: "specify", taskId: "SPEC-TODAY", title: "Spec: đổi trả", input: "Đổi trả hàng.", machineId: "runner.lan-mbp@lan-e2e" }, people.lan.token);
    const [specify] = (await beat()).runRequests.filter((r) => r.taskId === "SPEC-TODAY");
    await machineRpc("runs.requestResult", { id: specify.id, status: "accepted", runId: "R-today1" });
    const at = new Date().toISOString();
    const run = { runId: "R-today1", project: "payment", taskId: "SPEC-TODAY", taskTitle: "Spec: đổi trả", role: "implement", profileId: "claude-1", createdAt: at };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "running" }] });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "succeeded", finishedAt: at }] });
    await machineRpc("specs.push", { project: "payment", features: [{ dir: "002-doi-tra", branch: "ai/SPEC-TODAY", commit: "abc1240", files: { spec: "# Đổi trả\n", plan: null, tasks: null } }] });
    const gate = await until("the spec gate waiting", async () => (await rpc("sdlc.gates", { taskId: "SPEC-TODAY" })).find((g) => g.status === "waiting"));
    // And a leader's proposal nobody confirmed (payment's leader runs only task.create alone).
    const machineId = (await rpc("machines.list")).find((m) => m.machine === "lan-mbp").id;
    const sent = await rpc("chat.send", { project: "payment", machineId, text: "Tắt codegraph cho payment" }, people.lan.token);
    const request = await until("the chat request at Lan's heartbeat", async () => (await beat()).chatRequests?.find((r) => r.replyId === sent.reply.id));
    await machineRpc("chat.progress", { replyId: sent.reply.id, text: "Mình đề xuất tắt codegraph." });
    const proposed = await machineRpc("chat.propose", { action: { kind: "tool.enable", id: "codegraph", enabled: false }, reason: "Không dùng nữa" }, request.grant);
    await machineRpc("chat.finish", { replyId: sent.reply.id, status: "done", text: "Mình đề xuất tắt codegraph." });

    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("today");
    await tab.click(`[data-inbox-key="gate:${gate.id}"]`);
    await tab.shot(`${String(n).padStart(2, "0")}-today-gate`);
    await tab.click("button", "Duyệt, sang bước sau");
    await until("the spec gate passed from Hôm nay", async () => {
      const [gate] = await rpc("sdlc.gates", { taskId: "SPEC-TODAY" });
      return gate?.status === "passed" && gate.decidedBy?.startsWith("lan");
    });
    if (mobile) await tab.click("button", "Quay lại danh sách");
    await tab.click(`[data-inbox-key="leader:${proposed.id}"]`);
    await tab.waitFor("the leader's card", () => document.body.innerText.includes("Không dùng nữa"));
    await tab.click("button", "Xác nhận");
    await until("the proposal confirmed from Hôm nay", async () => !(await rpc("chat.pending", { project: "payment" })).some((a) => a.id === proposed.id));
    // Leave the hub as it was: the plan step's request is not for this test.
    for (const r of (await beat()).runRequests.filter((x) => x.taskId === "SPEC-TODAY")) await rpc("runs.cancelRequest", { id: r.id });
  });

  // Roadmap 49d: Tính năng, a board by step. A flow at its spec gate waits for Lan (lead), and only at a gate for Hoa
  // (reviewer: no run dispatch). Lan ticks a test item on Kiểm thử, passes the gate beside spec.md, then finds it in
  // Lịch sử chốt and the spec step's run in Lượt chạy.
  await step("features-page", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = (id, kind) => ({ id, label: id, kind, enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1 });
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.134.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1", "claude"), profile("codex-1", "codex")], runs: [] });
    await beat();
    await rpc("specs.runStep", { project: "payment", step: "specify", taskId: "SPEC-FEAT", title: "Spec: xuất hoá đơn", input: "Xuất hoá đơn điện tử.", machineId: "runner.lan-mbp@lan-e2e" }, people.lan.token);
    const [specify] = (await beat()).runRequests.filter((r) => r.taskId === "SPEC-FEAT");
    await machineRpc("runs.requestResult", { id: specify.id, status: "accepted", runId: "R-feat1" });
    const at = new Date().toISOString();
    const run = { runId: "R-feat1", project: "payment", taskId: "SPEC-FEAT", taskTitle: "Spec: xuất hoá đơn", role: "implement", profileId: "claude-1", createdAt: at };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "running" }] });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "succeeded", finishedAt: at }] });
    const spec = [
      "# Feature Specification: Xuất hoá đơn",
      "",
      "## User Scenarios & Testing *(mandatory)*",
      "",
      "### User Story 1 - Kế toán xuất hoá đơn (Priority: P1)",
      "",
      "**Acceptance Scenarios**:",
      "",
      "1. **Given** một đơn đã trả, **When** kế toán bấm Xuất, **Then** hoá đơn có mã tra cứu",
      "2. **Given** một đơn chưa trả, **When** kế toán bấm Xuất, **Then** nút bị khoá",
      "",
      "## Success Criteria *(mandatory)*",
      "",
      "### Measurable Outcomes",
      "",
      "- **SC-001**: Hoá đơn xuất xong trong dưới 5 giây",
    ].join("\n");
    await machineRpc("specs.push", { project: "payment", features: [{ dir: "003-hoa-don", branch: "ai/SPEC-FEAT", commit: "abc1250", files: { spec, plan: null, tasks: null } }] });
    const gate = await until("the spec gate waiting", async () => (await rpc("sdlc.gates", { taskId: "SPEC-FEAT" })).find((g) => g.status === "waiting"));

    let tab = (current = tabs.hoa);
    await tab.go("features");
    await tab.reload();
    await tab.waitFor("Hoa's card in Spec", () => document.querySelector('[data-feature-card="SPEC-FEAT"]')?.closest("[data-feature-column]")?.getAttribute("data-feature-column") === "spec");
    const hoa = await tab.eval(() => {
      const card = document.querySelector('[data-feature-card="SPEC-FEAT"]');
      return { mine: card.hasAttribute("data-feature-mine"), text: card.textContent };
    });
    expect(!hoa.mine && hoa.text.includes("Chờ chốt") && !hoa.text.includes("Chờ bạn"), `Hoa's card: ${JSON.stringify(hoa)}`);

    tab = current = tabs.lan;
    await tab.go("features");
    await tab.reload();
    await tab.waitFor("Lan's card waiting for her", () => document.querySelector('[data-feature-card="SPEC-FEAT"][data-feature-mine]')?.textContent.includes("Chờ bạn"));
    const columns = await tab.eval(() => [...document.querySelectorAll("[data-feature-column]")].map((c) => c.getAttribute("data-feature-column")));
    expect(JSON.stringify(columns) === JSON.stringify(["spec", "plan", "tasks", "doing", "review", "done"]), `columns: ${columns}`);
    await tab.click("[data-features-mine]");
    await tab.waitFor("only what waits for Lan", () => {
      const cards = [...document.querySelectorAll("[data-feature-card]")];
      return cards.length > 0 && cards.every((c) => c.hasAttribute("data-feature-mine"));
    });
    await tab.shot(`${String(n).padStart(2, "0")}-features-board`);
    await tab.click('[data-feature-card="SPEC-FEAT"]');
    await tab.waitFor("the feature on Spec, its gate beside spec.md", (id) =>
      location.hash.includes("flow=SPEC-FEAT") &&
      document.querySelector('[data-feature-tab="spec"]')?.getAttribute("data-state") === "active" &&
      document.querySelector(`[data-gate-decision="${id}"]`) &&
      document.body.innerText.includes("Kế toán xuất hoá đơn"),
      gate.id,
    );
    await tab.shot(`${String(n).padStart(2, "0")}-features-gate`);

    // Kiểm thử: SC-001 is Xong khi, the two scenarios the checklist; a mark stays after a reload (this browser's).
    await tab.click('[data-feature-tab="checks"]');
    await tab.waitFor("three items to check", () => document.querySelectorAll("[data-check]").length === 3 && document.querySelector("[data-checks-progress]")?.textContent.includes("0/3"));
    await tab.click('[data-check="SC-001"] [role="checkbox"]');
    await tab.waitFor("one checked", () => document.querySelector("[data-checks-progress]")?.textContent.includes("1/3"));
    await tab.reload();
    await tab.waitFor("the mark kept, on the same tab", () => document.querySelector('[data-check="SC-001"]')?.hasAttribute("data-checked") && document.querySelector("[data-checks-progress]")?.textContent.includes("1/3"));
    await tab.shot(`${String(n).padStart(2, "0")}-features-checks`);

    await tab.click('[data-feature-tab="spec"]');
    await tab.click(`[data-feature-pass="${gate.id}"]`);
    await until("the spec gate passed from Tính năng", async () => {
      const [g] = await rpc("sdlc.gates", { taskId: "SPEC-FEAT" });
      return g?.status === "passed" && g.decidedBy?.startsWith("lan");
    });
    await tab.waitFor("no gate left to decide", () => !document.querySelector("[data-gate-decision]"));
    await tab.click('[data-feature-tab="gates"]');
    await tab.waitFor("the passed gate in Lịch sử chốt", (id) => document.querySelector(`[data-feature-gate="${id}"]`)?.getAttribute("data-gate-status") === "passed", gate.id);
    await tab.click('[data-feature-tab="runs"]');
    await tab.waitFor("the spec step's run in Lượt chạy", () => !!document.querySelector('[data-feature-run="R-feat1"]'));
    // The Spec page's old link lands on the same feature.
    await tab.go("specs?project=payment&dir=003-hoa-don&branch=ai%2FSPEC-FEAT");
    await tab.waitFor("#/specs on Tính năng", () => location.hash.startsWith("#/features?") && document.querySelector("[data-feature-title]")?.getAttribute("data-feature-title") === "Xuất hoá đơn");
    // Leave the hub as it was: the plan step's request is not for this test.
    for (const r of (await beat()).runRequests.filter((x) => x.taskId === "SPEC-FEAT")) await rpc("runs.cancelRequest", { id: r.id });
  });

  // Roadmap 31b: the agent map shows each machine's subscriptions; two picked open one prompt for both, or the Task page.
  await step("agent-map", async () => {
    const beat = async (machine, profiles) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machine}` },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine, instance: "e2e00002", version: "0.120.0", projects: ["payment"], acceptsRuns: true, profiles, runs: [] } }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`heartbeat: ${body.error.message}`);
    };
    const profile = (id, kind, over = {}) => ({ id, label: id, kind, enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1, ...over });
    await beat("lan-mbp", [profile("claude-1", "claude", { sessionPercent: 42, weekPercent: 18 }), profile("codex-1", "codex", { loggedIn: false })]);
    // Roadmap 45: Codex's numbers are those of its last turn, here two hours old.
    const codexUsage = { sessionPercent: 98, weekPercent: 81, sessionResets: "Oct 5 at 4:00pm (Asia/Saigon)", weekResets: "Oct 9 at 7:00am (Asia/Saigon)", usageCheckedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    await beat("lan-mini", [profile("claude-2", "claude"), profile("codex-2", "codex", codexUsage)]);
    const machines = await rpc("machines.list");
    const id = (name) => machines.find((m) => m.machine === name).id;

    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("machines");
    await tab.waitFor("the two machines' cards", () => document.querySelector('[data-map-profile="lan-mbp/claude-1"]') && document.querySelector('[data-map-profile="lan-mini/claude-2"]'));
    const signedOut = await tab.eval(() => document.querySelector('[data-map-profile="lan-mbp/codex-1"]')?.getAttribute("data-map-state"));
    expect(signedOut === "signedOut", `codex-1: ${signedOut}`);
    const pickable = await tab.eval(() => document.querySelector('[data-map-profile="lan-mbp/codex-1"]')?.getAttribute("role"));
    expect(pickable !== "checkbox", "a signed-out subscription cannot be picked");
    const codexLine = await tab.eval(() => document.querySelector('[data-map-profile="lan-mini/codex-2"] [data-usage-resets]')?.textContent ?? "");
    expect(codexLine.includes("phiên làm mới Oct 5 at 4:00pm") && codexLine.includes("tuần làm mới Oct 9") && codexLine.includes("cập nhật lúc"), `codex-2: ${codexLine}`);
    await tab.shot(`${String(n).padStart(2, "0")}-agent-map-codex`);
    await tab.click('[data-map-profile="lan-mbp/claude-1"]');
    await tab.click('[data-map-profile="lan-mini/claude-2"]');
    expect(await tab.eval(() => !document.querySelector("[data-map-prompt]")), "new work has one entry in the top bar");
    await tab.shot(`${String(n).padStart(2, "0")}-agent-map-picked`);
    await tab.click("[data-map-batch]");
    await tab.waitFor("the Task page with the two agents", () => location.hash.startsWith("#/tasks") && document.body.innerText.includes("Đã chọn 2 agent trên Bản đồ agent"));
  });

  // Assignment uses a dedicated fake machine so open requests from earlier scenarios cannot occupy its only slot.
  await step("agent-assign", async () => {
    const machineName = "lan-assign";
    const machineRpc = async (method, input) => {
      const response = await fetch(`${base}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machineName}` },
        body: JSON.stringify({ method, input }),
      });
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = { id: "claude-assign", label: "claude-assign", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 1, sessionPercent: 24, weekPercent: 12 };
    const beat = () => machineRpc("machines.heartbeat", { machine: machineName, instance: "e2e00003", version: "0.132.0", projects: ["payment"], acceptsRuns: true, profiles: [profile], runs: [] });
    await beat();
    const machine = (await rpc("machines.list")).find((m) => m.machine === machineName);
    const first = await rpc("tasks.create", { id: "PAY-ASSIGN-1", project: "payment", title: "Assignment first" });
    const second = await rpc("tasks.create", { id: "PAY-ASSIGN-2", project: "payment", title: "Assignment second" });
    const taskNow = async (id) => (await rpc("tasks.list", { project: "payment" })).find((x) => x.id === id);
    const tab = (current = tabs.lan);
    await tab.reload();
    for (const task of [first, second]) {
      await tab.go(`tasks?task=${task.id}`);
      // The select mounts before machines.list answers, and tab.select throws at once on a missing option.
      await tab.waitFor("assignment form", (id) => document.querySelector(`[data-assign-machine] option[value="${id}"]`), machine.id);
      await tab.select("[data-assign-machine]", machine.id);
      await tab.select("[data-assign-profile]", profile.id);
      await tab.click("[data-assign-save]");
      await until("saved assignment", async () => (await taskNow(task.id))?.agent?.profileId === profile.id);
      await tab.key("Escape");
    }
    const requests = await rpc("runs.requests", { project: "payment", limit: 200 });
    const request = requests.find((r) => r.taskId === first.id && r.status === "pending");
    expect(request && !requests.some((r) => r.taskId === second.id && r.status === "pending"), "only the first assignment starts");
    const queue = await rpc("tasks.agentQueue", { machineId: machine.id, profileId: profile.id });
    expect(queue.find((r) => r.task.id === second.id)?.waiting?.key === "errors.agentBusy", "second task waits for the agent");
    await tab.click('[data-task-view="agent"]');
    const key = JSON.stringify([machine.id, profile.id]);
    await tab.select("[data-agent-filter]", key);
    await tab.waitFor("agent lane order", (a, b) => {
      const ids = [...document.querySelectorAll("[data-agent-task]")].map((el) => el.dataset.agentTask);
      return ids.length === 2 && ids[0] === a && ids[1] === b;
    }, first.id, second.id);
    await tab.select(`[data-agent-task="${second.id}"] [data-agent-card-before]`, first.id);
    await until("before persisted", async () => (await rpc("tasks.agentQueue", { machineId: machine.id, profileId: profile.id }))[0]?.task.id === second.id);
    if (mobile) {
      const safe = await tab.eval(() => [...document.querySelectorAll("[data-agent-task]")].every((el) => !el.draggable) && [...document.querySelectorAll("[data-agent-card-select]")].every((el) => el.getBoundingClientRect().height >= 44));
      expect(safe, "mobile uses 44px selects without dragging");
    }
    await tab.shot(`${String(n).padStart(2, "0")}-agent-assign-lanes`);
    await machineRpc("runs.requestResult", { id: request.id, status: "accepted", runId: "R-assign1" });
    // Heartbeat before push catches the accepted-but-unreported gap covered by 50a.
    expect(!(await beat()).runRequests?.some((r) => r.taskId === second.id), "accepted run retains the slot before push");
    const at = new Date().toISOString();
    await machineRpc("runs.push", { machine: machineName, runs: [{ runId: "R-assign1", project: "payment", taskId: first.id, taskTitle: first.title, role: "implement", status: "succeeded", profileId: profile.id, createdAt: at, finishedAt: at }] });
    const next = await until("second assignment released", async () => (await beat()).runRequests?.find((r) => r.taskId === second.id));
    expect(next, "second task starts after first finishes");
    for (const task of [first, second]) await rpc("tasks.unassign", { id: task.id });
    await rpc("runs.cancelRequest", { id: next.id });
    await tab.select("[data-agent-filter]", "");
    await tab.click('[data-task-view="kanban"]');
  });

  await step("knowledge-pending", async () => {
    const tab = (current = tabs.admin);
    const teamKey = "org/skills/knowledge-check";
    const ownKey = "project/payment/skills/knowledge-check";
    const skill = (description) => `---\nname: knowledge-check\ndescription: ${description}\n---\n\nReview knowledge.`;
    await rpc("docs.save", { key: teamKey, content: skill("When reviewing team knowledge"), baseVersion: 0 });
    await rpc("docs.save", { key: ownKey, content: skill("When reviewing payment knowledge"), baseVersion: 0 });
    const skillProposal = await rpc("proposals.create", { docKey: ownKey, baseVersion: 1, content: skill("When reviewing updated payment knowledge"), reason: "Knowledge skill proposal" }, people.minh.token);
    const doc = await rpc("docs.get", { key: "project/payment/huong-dan" });
    const docProposal = await rpc("proposals.create", { docKey: doc.key, baseVersion: doc.version, content: doc.content + "\nKnowledge update.", reason: "Knowledge document proposal" }, people.minh.token);
    await tab.go("docs?tab=pending");
    await tab.waitFor("document pending tab", () => document.body.innerText.includes("Knowledge document proposal"));
    expect(!await tab.eval(() => document.body.innerText.includes("Knowledge skill proposal")), "docs pending excludes skills");
    if (mobile) await tab.click(`[data-mobile-proposal="${docProposal.id}"]`);
    await tab.click(`[data-proposal-card="${docProposal.id}"] button`, "Duyệt");
    await until("document approved", async () => (await rpc("proposals.list", {})).find((p) => p.id === docProposal.id)?.status === "approved");
    await tab.go(`proposals?doc=${encodeURIComponent(ownKey)}`);
    await tab.waitFor("legacy skill redirect", () => location.hash.startsWith("#/skills?tab=pending") && document.body.innerText.includes("Knowledge skill proposal"));
    expect(!await tab.eval(() => document.body.innerText.includes("Knowledge document proposal")), "skills pending excludes documents");
    if (mobile) await tab.click(`[data-mobile-proposal="${skillProposal.id}"]`);
    await tab.click(`[data-proposal-card="${skillProposal.id}"] button`, "Từ chối");
    await until("skill rejected", async () => (await rpc("proposals.list", {})).find((p) => p.id === skillProposal.id)?.status === "rejected");
    await tab.go("skills");
    await tab.click('[role="option"]', "knowledge-check");
    await tab.waitFor("skill application and modification metadata", () => document.body.innerText.includes("Lúc áp dụng") && document.body.innerText.includes("Lần sửa cuối"));
    await tab.shot(`${String(n).padStart(2, "0")}-knowledge-skill`);

    const a = await rpc("memory.write", { project: "payment", kind: "convention", content: "Knowledge fixture: use package aliases" });
    const b = await rpc("memory.write", { project: "payment", kind: "convention", content: "Knowledge fixture: use aliases for imports" });
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.knowledge-check" }, body: JSON.stringify({ method, input }) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    };
    await machineRpc("machines.heartbeat", { machine: "knowledge-check", instance: "49f49f49", projects: ["payment"], acceptsRuns: true });
    let run = null;
    const deadline = Date.now() + 65_000;
    while (!run && Date.now() < deadline) { run = await machineRpc("memory.cleanupTake", { projects: ["payment"] }); if (!run) await sleep(500); }
    expect(run, "weekly hub scheduler queued a cleanup run");
    const read = await machineRpc("memory.cleanupRead", { id: run.id });
    expect(read.entries.every((m) => m.project === "payment"), "cleanup MCP snapshot contains only project memory");
    await machineRpc("memory.cleanupFinish", { id: run.id, suggestions: [{ kind: "merge", ids: [a.id, b.id], content: "Knowledge fixture: use package aliases for imports", reason: "Knowledge memory merge" }] });
    await tab.go("today");
    await tab.waitFor("cleanup gathered in Today", () => document.body.innerText.includes("Knowledge memory merge"));
    await tab.go("memory?tab=pending");
    await tab.waitFor("memory cleanup proposal", () => document.body.innerText.includes("Knowledge memory merge"));
    await tab.shot(`${String(n).padStart(2, "0")}-knowledge-memory-pending`);
    await tab.click("[data-cleanup-approve]");
    await until("merge approved", async () => (await rpc("memory.cleanupProposals", { project: "payment" })).find((p) => p.reason === "Knowledge memory merge")?.status === "approved");
    const entries = await rpc("memory.list", { project: "payment", limit: 500 });
    expect(entries.find((m) => m.id === a.id)?.supersededBy === entries.find((m) => m.id === b.id)?.supersededBy, "original facts point to one merged fact");
    await tab.go("settings?tab=policy");
    await tab.waitFor("project cleanup setting", () => document.querySelector('[data-cleanup-project="payment"]'));
    await tab.click('[data-cleanup-project="payment"]');
    await until("cleanup disabled", async () => (await rpc("memory.cleanupSettings", { project: "payment" }))[0]?.enabled === false);
    await tab.shot(`${String(n).padStart(2, "0")}-knowledge-cleanup-settings`);
    const layout = await tab.eval(() => ({ width: innerWidth, page: document.documentElement.scrollWidth, main: document.querySelector("main").clientWidth, content: document.querySelector("main").scrollWidth }));
    expect(layout.page <= layout.width + 1 && layout.content <= layout.main + 1, `knowledge layout overflow: ${JSON.stringify(layout)}`);
  });

  if (mobile) {
    current = tabs.admin;
    await tableCardsChecks({ tab: current, rpc, step, expect });
    await rpc("docs.save", { key: "project/payment/skills/mobile-check", title: "Mobile check", content: "---\nname: mobile-check\ndescription: Check phone navigation\n---\n\nCheck the selected pane.", baseVersion: 0 });
    await rpc("memory.write", { project: "payment", kind: "gotcha", content: "Mobile navigation fixture" }, people.minh.token);
    const guide = await rpc("docs.get", { key: "project/payment/huong-dan" });
    await rpc("proposals.create", { docKey: guide.key, baseVersion: guide.version, content: guide.content + "\nPhone check.", reason: "Mobile navigation fixture" }, people.minh.token);
    const cases = [
      ["today", "item", "main [data-inbox-key]", null],
      ["docs", "doc", 'main [role="treeitem"]:not([aria-expanded])', null],
      ["runs", "run", 'main [role="option"]', null],
      ["chat", "thread", 'nav[aria-label="Các cuộc chat"] button', null],
      ["skills", "skill", 'main [role="option"]', null],
      ["memory", "memory", 'main [role="option"]', null],
      ["proposals", "proposal", "main [data-mobile-proposal]", null],
      ["features", "project", "main [data-feature-card]", null],
    ];
    for (const [route, param, selector, text] of cases) {
      await step(`mobile-detail-${route}`, async () => {
        const tab = (current = tabs.lan);
        await tab.go(route);
        await tab.reload();
        await tab.waitFor("visible list", (selector) => [...document.querySelectorAll(selector)].some((el) => el.getBoundingClientRect().width > 0), selector);
        await tab.shot(`mobile-${route}-list`);
        await tab.click(selector, text);
        await tab.waitFor("selection in address", (param) => new URLSearchParams(location.hash.split("?")[1]).has(param), param);
        const selectedHash = await tab.eval(() => location.hash);
        const assertPane = async (detail) => {
          const state = await tab.eval((selector) => {
            const main = document.querySelector("main");
            return { listVisible: [...document.querySelectorAll(selector)].some((el) => el.getBoundingClientRect().width > 0), width: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth, main: main.clientWidth, content: main.scrollWidth };
          }, selector);
          expect(state.listVisible === !detail, `list visibility in ${route}: ${JSON.stringify(state)}`);
          expect(state.width === 390 && state.height === 844, `viewport: ${JSON.stringify(state)}`);
          expect(state.page <= state.width + 1 && state.content <= state.main + 1, `overflow in ${route}: ${JSON.stringify(state)}`);
        };
        await assertPane(true);
        await tab.shot(`mobile-${route}-detail`);
        await tab.reload();
        await tab.waitFor("detail restored after reload", () => [...document.querySelectorAll("main button")].some((el) => el.getBoundingClientRect().width > 0 && (el.textContent.includes("Quay lại danh sách") || el.getAttribute("aria-label") === "Các cuộc chat")));
        await assertPane(true);
        await tab.eval(() => history.back());
        await tab.waitFor("Back restores list", (route) => location.hash === `#/${route}`, route);
        await assertPane(false);
        await tab.eval(() => history.forward());
        await tab.waitFor("Forward restores detail", (hash) => location.hash === hash, selectedHash);
        await assertPane(true);
        if (route === "docs") {
          await tab.waitFor("loaded document actions", () => document.querySelector('main button[aria-label="Lịch sử"]'));
          await tab.click("summary", "Chế độ");
          await tab.click("details[open] button", "Lịch sử");
          await tab.waitFor("history menu closes", () => !document.querySelector("details[open]") && document.querySelector('aside[aria-label="Phiên bản"] button'));
          await tab.click('aside[aria-label="Phiên bản"] button');
          await tab.waitFor("version content replaces history pane", () => !document.querySelector('aside[aria-label="Phiên bản"]') && document.body.innerText.includes("Đóng so sánh"));
          await assertPane(true);
          await tab.click("button", "Danh sách tài liệu");
          await tab.waitFor("document tree drawer", (selector) => [...document.querySelectorAll(selector)].some((el) => el.getBoundingClientRect().width > 0), selector);
          await tab.shot("mobile-docs-tree-drawer");
          await tab.click(selector);
          await tab.waitFor("selecting a page closes tree drawer", (selector) => ![...document.querySelectorAll(selector)].some((el) => el.getBoundingClientRect().width > 0), selector);
          await assertPane(true);
        }
        if (route === "memory") {
          tab.win.setContentSize(767, 844);
          await tab.waitFor("767px keeps list hidden", () => innerWidth === 767 && ![...document.querySelectorAll('main [role="option"]')].some((el) => el.getBoundingClientRect().width > 0));
          tab.win.setContentSize(768, 844);
          await tab.waitFor("768px restores both panes", () => innerWidth === 768 && [...document.querySelectorAll('main [role="option"]')].some((el) => el.getBoundingClientRect().width > 0) && ![...document.querySelectorAll("main button")].some((el) => el.textContent.includes("Quay lại danh sách") && el.getBoundingClientRect().width > 0));
          tab.win.setContentSize(390, 844);
          await tab.waitFor("phone pane restored", () => innerWidth === 390 && ![...document.querySelectorAll('main [role="option"]')].some((el) => el.getBoundingClientRect().width > 0));
        }
      });
    }
  }

  // Roadmap 41c: what a run made is on the run and on its task, and the project manager can take it away.
  await step("artifacts", async () => {
    const asMachine = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" },
        body: JSON.stringify({ method, input }),
      });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const runId = "R-e2eart";
    await asMachine("runs.push", {
      machine: "lan-mbp",
      runs: [{ runId, project: "payment", taskId: "PAY-1", taskTitle: "Việc đầu tiên của payment", role: "implement", status: "succeeded", profileId: "claude-1",
        log: "done", createdAt: new Date(Date.now() - 300_000).toISOString(), finishedAt: new Date().toISOString() }],
    });
    // A 1×1 PNG, so the hub reads its signature as one; and a report with a line that looks like a token.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const base64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const put = (name, data) => asMachine("artifacts.put", { project: "payment", taskId: "PAY-1", runId, profileId: "claude-1", name, data });
    await put("shots/board.png", png);
    const report = await put("do-duoc.md", base64(`# Đo được\nTOKEN=glpat-${"x".repeat(24)}\nXong.\n`));
    const kept = Buffer.from((await rpc("artifacts.get", { id: report.id })).data, "base64").toString("utf8");
    expect(!kept.includes("glpat-") && kept.includes("line hidden"), `the secret-looking line was kept: ${kept}`);

    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go(`runs?run=${runId}`);
    await tab.waitFor("the run's artifacts", () => document.querySelector('[data-artifact="shots/board.png"]') && document.querySelector('[data-artifact="do-duoc.md"]'));
    if (mobile) {
      const targets = await tab.eval(() => [...document.querySelectorAll('[data-artifacts] button')].every((el) => {
        const box = el.getBoundingClientRect();
        return box.width >= 44 && box.height >= 44;
      }));
      expect(targets, "artifact controls have 44px phone targets");
    }
    await tab.click('[data-artifact="shots/board.png"] button');
    await tab.waitFor("the screenshot itself", () => document.querySelector('[data-artifacts] img[alt="shots/board.png"]'));

    // The same files on the task's panel, whichever run made them.
    await tab.go("tasks?task=PAY-1");
    await tab.waitFor("the task's artifacts", () => document.querySelector('[data-artifact="do-duoc.md"]'));
    // Lan manages payment: she may take one away, and the audit log says she did.
    await tab.click(`[aria-label="Xoá do-duoc.md"]`);
    await tab.waitFor("it is gone", () => !document.querySelector('[data-artifact="do-duoc.md"]') && document.querySelector('[data-artifact="shots/board.png"]'));
    // By person, not by actor: Lan's tab signs in with her token "lan-e2e", which acts on her behalf.
    const log = await rpc("admin.audit", { action: "artifacts.remove", user: "lan" });
    expect(log.some((e) => e.detail.includes("do-duoc.md")), `the removal is not in the audit log: ${JSON.stringify(log)}`);
  });

  const errors = Object.values(tabs).flatMap((t) => t.errors.map((e) => `${t.name}: ${e}`));
  if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
  const failed = results.filter((r) => !r.ok);
  if (mobile) {
    writeFileSync(path.join(out, "overflow.json"), JSON.stringify({ page: overflows, content: contentOverflows }, null, 2));
    console.log(`mobile overflow: ${overflows.length} steps${overflows.length ? `; ${overflows.map((o) => o.step).join(", ")}` : ""}`);
    console.log(`content wider than pane: ${contentOverflows.length} steps${contentOverflows.length ? `; ${contentOverflows.map((o) => o.step).join(", ")}` : ""}`);
  }
  console.log(`${results.length - failed.length}/${results.length} steps passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  const exitCode = failed.length || errors.length ? 1 : 0;
  writeFileSync(path.join(out, "result.json"), JSON.stringify({ results, errors, exitCode }, null, 2));
  // Not app.exit: Electron can retain a hidden BrowserWindow after history navigation on macOS and never quit.
  process.exit(exitCode);
}
