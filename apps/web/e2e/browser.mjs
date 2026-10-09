// The browser half of `npm run e2e` (see run.mjs). Electron stands in for Chromium, so nothing past `npm ci` is needed.
// Input goes through the DevTools protocol (the mouse at an element's centre, typed text, keys), as a person's
// would: Radix menus and the Tiptap editor react to real events, not to element.click().
// Each step checks what the hub now holds through its RPC, not only what the page shows.
import { app, BrowserWindow } from "electron";
import axe from "axe-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runInNewContext } from "node:vm";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tableCardsChecks } from "./table-cards.mjs";
import { mobileAudit } from "./mobile-audit.mjs";
import { accessibilityAudit, keyboardMenu, keyboardOverlays, keyboardTable, runContrast, dataTableAccessibility, memoryAccessibility } from "./accessibility.mjs";

const base = process.env.HIVE_E2E_BASE;
const out = process.env.HIVE_E2E_OUT;
const width = Number(process.env.HIVE_E2E_W ?? 1440);
const height = Number(process.env.HIVE_E2E_H ?? 900);
if (!Number.isInteger(width) || width < 320 || !Number.isInteger(height) || height < 480) throw new Error("invalid HIVE_E2E_W/HIVE_E2E_H");
const mobile = width < 768;
const { admin, people, proposals, memory, terminal } = JSON.parse(process.env.HIVE_E2E_SEED);

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
  " ": { code: "Space", keyCode: 32, text: " " },
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
const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

/** One person's browser: its own storage partition, so two people are signed in side by side. */
class Tab {
  errors = [];

  static async open(name) {
    // Under Xvfb, a mapped window is needed for compositor frames (editor focus and sheet transitions).
    const win = new BrowserWindow({ show: process.platform === "linux", useContentSize: true, width, height, webPreferences: { partition: `e2e-${name}`, backgroundThrottling: false } });
    const tab = new Tab(win, name);
    win.webContents.on("console-message", (e) => {
      if (e.level === "error" && /Uncaught|TypeError|ReferenceError/.test(e.message)) tab.errors.push(e.message.slice(0, 300));
    });
    win.webContents.on("render-process-gone", (_e, d) => tab.errors.push(`renderer gone: ${d.reason}`));
    win.webContents.debugger.attach("1.3");
    await win.loadURL(`${base}/`);
    // Hidden Linux windows can retain an old compositor frame, making input tests hit stale layouts.
    win.showInactive();
    return tab;
  }

  constructor(win, name) {
    this.win = win;
    this.name = name;
  }

  activate() {
    // A later person's window can cover this one in Xvfb and stop its compositor again.
    if (process.platform === "linux") {
      this.win.moveTop();
      this.win.focus();
      this.win.webContents.focus();
    }
  }

  cdp(method, params) {
    this.activate();
    return this.win.webContents.debugger.sendCommand(method, params);
  }

  /** Runs `fn` in the page with JSON arguments. */
  eval(fn, ...args) {
    this.activate();
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

  /** The first visible element matching `selector` (and whose text is or starts with `text`), scrolled into view. Returns its centre, or null; `settle` also waits one frame pair and reports what is wrong when it moves or something else sits on its centre. */
  locate() {
    return async (sel, txt, scope, settle) => {
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
      // Scrolling a node of the Graph page's canvas changes the pane under the pointer; the Pipeline canvas is a wide scroller whose gates must be scrolled into view like a user would.
      if (!el.closest("[data-graph-canvas]")) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const centre = () => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      };
      const first = centre();
      // React Flow keeps its nodes in a transformed, animated layer: those are clicked as before.
      if (!settle || el.closest(".react-flow")) return first;
      // The timeout is for a window whose frames are throttled.
      await new Promise((done) => {
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 150);
      });
      const at = centre();
      if (at.x !== first.x || at.y !== first.y) return { why: `${sel} is still moving` };
      const hit = document.elementFromPoint(at.x, at.y);
      if (hit && (el === hit || el.contains(hit))) return at;
      const name = hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${[...hit.classList].slice(0, 3).map((c) => `.${c}`).join("")}${hit.dataset.slot ? `[data-slot=${hit.dataset.slot}]` : ""}` : "nothing";
      return { why: `${sel} is covered by ${name} at ${at.x},${at.y}` };
    };
  }

  /** The centre of the element, as `locate` finds it. */
  async find(selector, text, within, settle = false) {
    const what = `${selector}${text ? ` "${text}"` : ""}${within ? ` in ${within}` : ""}`;
    const fn = this.locate();
    const until = Date.now() + 15_000;
    let why = `no visible ${what}`;
    for (;;) {
      const v = await this.eval(fn, selector, text ?? null, within ?? null, settle).catch(() => null);
      if (v?.why) why = v.why;
      else if (v) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}: ${why}`);
      await sleep(100);
    }
  }

  /** Clicks like a person: waits for the element to stay put and for nothing (a scrim, a sheet that is opening or closing) to sit on it. */
  async click(selector, text, within) {
    if (mobile && selector === "[data-project-picker-trigger]") {
      const hidden = await this.eval(() => {
        const r = document.querySelector("[data-project-picker-trigger]")?.getBoundingClientRect();
        return !r || r.right <= 0 || r.left >= innerWidth;
      });
      if (hidden) await this.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    }
    // Moving the pointer onto it can itself shift the page (a hover card, a lazy list above it), so the point is measured again over the element and pressed only when it held.
    let { x, y } = await this.find(selector, text, within, true);
    for (let tries = 0; ; tries++) {
      await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      const again = await this.find(selector, text, within, true);
      if (again.x === x && again.y === y) break;
      if (tries >= 20) throw new Error(`${selector} keeps moving under the pointer (${x},${y} then ${again.x},${again.y})`);
      ({ x, y } = again);
    }
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
    // Native key codes differ across platforms; Chromium derives them from the portable code/key fields.
    const common = { key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers };
    // CDP bypasses macOS's native Cmd+A binding; without the edit command Backspace removes only the last letter.
    const commands = name.toLowerCase() === "a" && mods.includes(PRIMARY_MODIFIER) ? ["selectAll"] : undefined;
    await this.cdp("Input.dispatchKeyEvent", { type: k.text && !modifiers ? "keyDown" : "rawKeyDown", ...common, ...(k.text && !modifiers ? { text: k.text } : {}), ...(commands ? { commands } : {}) });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    await sleep(80);
  }

  shortcut(name) {
    return this.key(name, PRIMARY_MODIFIER);
  }

  /** A native <select>: sets the value as React expects (through the prototype's setter) and fires change. */
  async select(selector, value) {
    // New-chat configuration is progressive disclosure; open it with a real click before choosing.
    const folded = await this.eval((sel) => !!document.querySelector(sel)?.closest("[data-chat-setup]:not([open])"), selector);
    if (folded) await this.click("[data-chat-setup] summary");
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
    this.activate();
    const image = await this.win.webContents.capturePage();
    writeFileSync(path.join(out, `${name}.png`), image.toPNG());
  }
}

// --only: a step names the steps it needs (their tabs and rows); one not listed needs every step before it. Every step is listed:
// `npm run e2e:needs -w @xdev-hive/web` runs each one alone (check-needs.mjs). Mobile-only steps appear in the list too.
// A step's tabs live in `tabs`, so list the step that opens a tab for every step that uses it.
// HIVE_E2E_NEEDS (JSON) replaces the table: check-needs.mjs probes a smaller set with it before the table is changed.
const NEEDS = process.env.HIVE_E2E_NEEDS ? JSON.parse(process.env.HIVE_E2E_NEEDS) : {
  "terminal-entry": [],
  "terminal-io": ["terminal-entry"],
  "leader-plan": ["lead-sees-members"],
  "auto-dispatch": ["login-token"],
  "merge-queue": ["login-token"],
  "auto-release": ["login-token"],
  "login-token": [],
  "project-onboarding": ["login-token"],
  "artifacts-page": ["login-token"],
  "acceptance-evidence": ["login-token"],
  "history-page": ["login-token"],
  "chat-everywhere": ["login-token"],
  "chat-design": ["login-token"],
  "a11y-pages": ["login-token"],
  "a11y-list-tree": ["login-token"],
  "a11y-components": ["login-token"],
  "cosmic-primitives": ["login-token"],
  "a11y-menu": ["login-token"],
  "workspace-home": ["login-token"],
  "responsive-shell": ["login-token"],
  "responsive-shell-pages": ["responsive-shell"],
  "a11y-overlays": ["login-token"],
  "a11y-table": ["login-token"],
  "a11y-run-status": ["login-token"],
  "run-redispatch": [],
  "inbox-source-complete": [],
  "close-unmerged-task": ["inbox-source-complete"],
  "scope-search-tasks": ["login-token"],
  "blocker-center": ["login-token"],
  "mobile-kanban-forms-dialog": ["login-token"],
  "graph": ["login-token"],
  "docs-system-default": ["login-token"],
  "login-password": [],
  "nav-by-job": ["login-token", "login-password"],
  "reviewer-approves-a-guide-not-context": ["login-password"],
  "lead-sees-members": [],
  "admin-grants-a-role": ["login-token"],
  "docs-rich-editor": ["login-token"],
  "docs-markdown": ["login-token", "docs-rich-editor"], // the editor docs-rich-editor left open on project/demo/huong-dan (version 2)
  "mermaid-draws": ["login-token"],
  "mermaid-error": ["login-token"],
  "docs-move-space": ["login-token"],
  "docs-remove-page": ["login-token", "docs-move-space"], // the page docs-move-space moved into the system's space, left open
  "project-retire": ["login-token"],
  "bulk-approve-proposals": ["login-token"],
  "bulk-approve-memory": ["login-token"],
  "sync-request": ["login-token"],
  "machine-profiles": ["login-password", "lead-sees-members"],
  "quota-outlook": ["lead-sees-members"],
  "web-prompt": ["lead-sees-members"],
  "new-work": ["lead-sees-members"],
  "batch-run": ["lead-sees-members", "web-prompt"], // the task web-prompt created
  "fanout": ["lead-sees-members"],
  "map-reduce": ["lead-sees-members"],
  "roles": ["lead-sees-members"],
  "sdlc-gates": ["login-token", "lead-sees-members"],
  "sdlc-flow": ["lead-sees-members", "sdlc-gates", "pipeline", "plan-approval", "models-in-pipeline"], // its nested steps run inside it and set up the plan approval its gate pass waits on
  "pipeline": ["sdlc-flow"], // nested in sdlc-flow
  "plan-approval": ["sdlc-flow"], // nested in sdlc-flow
  "models-in-pipeline": ["sdlc-flow"], // nested in sdlc-flow
  "merge-from-web": ["login-password"],
  "diff-review-hunks": ["login-token", "merge-from-web"], // merge-from-web leaves the page and run state it builds on
  "runs-review": ["login-token"],
  "spec-page": ["login-password"],
  "spec-import-and-run": ["lead-sees-members", "spec-page"], // spec-page's imported feature
  "agent-policy": ["lead-sees-members"],
  "tools": ["login-token", "lead-sees-members"],
  "machine-runner-settings": ["login-token", "login-password", "lead-sees-members"],
  "worktree-admin": ["login-token", "login-password", "lead-sees-members"],
  "tool-approve-web": ["login-token", "login-password", "lead-sees-members"],
  "stop-all": ["login-token"],
  "audit-agent": ["login-token"],
  "budget": ["login-token"],
  "token-metrics": ["login-token"],
  "leader-autonomy": ["lead-sees-members"],
  "leader-tool-proposal": ["lead-sees-members"],
  "hub-page": ["login-token"],
  "backup-late-today": [],
  "hub-leader-chat": ["login-token", "lead-sees-members"],
  "system-docs": ["login-password"],
  "systems-outside": ["login-token", "system-docs"], // system-docs saves the system shop
  "project-archive-delete": ["login-token"],
  "scope-system-first": ["login-token"],
  "overview-by-system": ["login-token"],
  "cross-service-task": ["lead-sees-members"],
  "graph-sdlc-system": ["lead-sees-members", "cross-service-task"], // cross-service-task's cross-service edge
  "task-note-history": ["lead-sees-members"],
  "today-web": ["lead-sees-members"],
  "features-page": ["login-password", "lead-sees-members"],
  "agent-map": ["lead-sees-members"],
  "agent-assign": ["lead-sees-members"],
  "skill-usage": ["login-token"],
  "knowledge-pending": ["login-token", "lead-sees-members"],
  "memory-variants": ["login-token"],
  "knowledge-compare": ["login-token", "artifacts-page"],
  "artifacts": ["lead-sees-members"],
  "run-steer": ["login-password", "lead-sees-members"],
  "codex-leader-chat": ["login-token"],
  "leader-research": ["lead-sees-members"],
  "chat-shortcuts": ["lead-sees-members"],
};
const order = [...readFileSync(import.meta.filename, "utf8").matchAll(/^\s*(?:if \(mobile\) )?await step\("([^"]+)"/gm)].map((m) => m[1]);
const only = (process.env.HIVE_E2E_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const unknown = only.filter((s) => !order.includes(s));
if (unknown.length) {
  console.error(`unknown step: ${unknown.join(", ")}\nsteps: ${order.join(", ")}`);
  process.exit(2);
}
const wanted = new Set();
const want = (name) => {
  if (wanted.has(name)) return;
  wanted.add(name);
  for (const dep of NEEDS[name] ?? order.slice(0, order.indexOf(name))) want(dep);
};
only.forEach(want);
const results = [];
const overflows = [];
const contentOverflows = [];
let current = null;
let n = 0;
async function step(name, fn) {
  if (only.length && !wanted.has(name)) return;
  const t0 = Date.now();
  const id = String(++n).padStart(2, "0");
  try {
    await fn();
    await current?.shot(`${id}-${name}`);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message, ms: Date.now() - t0 });
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
    await tab.waitFor("the admin's Hôm nay", () => document.querySelector('[data-shell-title]')?.textContent.includes("Hôm nay"));
    if (mobile) await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    // Roadmap 49b: one web shell, its menu by job; a hub admin's has Cài đặt service, Máy & agent and Quản trị after the work.
    const nav = await tab.waitFor("the admin's menu", () => document.querySelector("#hive-navigation")?.innerText.includes("Máy & agent") && document.querySelector("#hive-navigation").innerText);
    for (const label of ["Làm việc", "Task", "Cài đặt service", "Quản trị"]) expect(nav.includes(label), `no ${label} in the admin's menu:\n${nav}`);
    // The Web Admin's old addresses open the tab that holds the page now.
    await tab.go("admin/queue");
    await tab.waitFor("#/admin/queue on Máy & agent › Hàng đợi", () =>
      location.hash === "#/machines?tab=queue" &&
      document.querySelector('#hive-navigation [aria-current="page"]')?.textContent.includes("Máy & agent") &&
      document.querySelector('[data-page-tab="queue"]')?.getAttribute("aria-current") === "page",
    );
    if (mobile) await tab.click('button[aria-label="Đóng menu"]');
  });

  await step("workspace-home", async () => {
    const tab = current = tabs.admin;
    await tab.go("today");
    await tab.waitFor("workspace overview", () => document.querySelector(".workspace-metrics") && document.querySelectorAll(".workspace-metric").length === 4);
    await tab.waitFor("real task totals", () => [...document.querySelectorAll(".workspace-metric strong")].every(el => el.textContent !== "—"));
    const totals = await tab.eval(() => [...document.querySelectorAll(".workspace-metric strong")].map(el => Number(el.textContent)));
    const tasks = await rpc("tasks.list", {});
    expect(totals[2] === tasks.filter(task => task.status === "blocked").length, "blocked count differs from hub");
    expect(totals[3] === tasks.filter(task => task.status === "done").length, "done count differs from hub");
    await tab.shot("workspace-home-new");
    await tab.click('.workspace-metric[href*="section=inbox"]');
    await tab.waitFor("existing inbox actions", () => !!document.querySelector(".workspace-inbox") && !!document.querySelector('[role="listbox"]'));
    await tab.click(".workspace-back");
    await tab.waitFor("overview back", () => !!document.querySelector(".workspace-home"));
    await tab.go("pipeline");
    await tab.waitFor("acceptance overview", () => document.querySelector(".workspace-section-tabs") && document.body.innerText.includes("Kết quả cần nghiệm thu"));
    await tab.click('.workspace-section-tabs a[href*="workspaceTab=process"]');
    await tab.waitFor("pipeline configuration", () => !!document.querySelector("[data-pipeline-project]"));
  });

  await step("responsive-shell", async () => {
    const tab = (current = tabs.admin);
    await tab.go("today?section=inbox");
    if (mobile) {
      const layout = await tab.eval(() => {
        const nav = document.querySelector(".hive-mobile-nav");
        const main = document.querySelector("#hive-main");
        return { count: nav?.children.length, bottom: main?.getBoundingClientRect().bottom, top: nav?.getBoundingClientRect().top };
      });
      expect(layout.count >= 2 && layout.count <= 5 && layout.bottom <= layout.top + 1, `quick navigation overlaps content: ${JSON.stringify(layout)}`);
      await tab.click('.hive-mobile-nav button');
      const drawer = await tab.waitFor("navigation drawer", () => {
        const el = document.querySelector('.hive-navigation-drawer');
        return el && { width: el.getBoundingClientRect().width, viewport: innerWidth };
      });
      expect(drawer.width <= drawer.viewport - 47, `drawer leaves no dismissal area: ${JSON.stringify(drawer)}`);
      await tab.key("Escape");
      await tab.waitFor("focus returns to menu", () => document.activeElement?.matches('.hive-mobile-nav button'));
      await tab.click('.hive-mobile-nav a[href="#/tasks"]');
      await tab.waitFor("tasks selected", () => location.hash === "#/tasks" && document.querySelector('.hive-mobile-nav a[href="#/tasks"]')?.getAttribute("aria-current") === "page");
    } else {
      await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
      const width = await tab.waitFor("collapsed navigation rail", () => {
        const nav = document.querySelector('.hive-sidebar-rail');
        return nav?.getBoundingClientRect().width;
      });
      expect(width === 64, `unexpected navigation rail width ${width}`);
      await tab.click('#hive-navigation a[href="#/tasks"]');
      await tab.waitFor("rail navigates", () => location.hash === "#/tasks");
      await tab.reload();
      await tab.waitFor("rail preference survives reload", () => !!document.querySelector('.hive-sidebar-rail'));
      await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    }
    await tab.eval(() => document.querySelector('.hive-skip-link').focus());
    await tab.key("Enter");
    expect(await tab.eval(() => document.activeElement?.id === "hive-main" && location.hash === "#/tasks"), "skip link must focus content without changing the route");
    await tab.go("today?section=inbox");
  });

  await step("responsive-shell-pages", async () => {
    const tab = (current = tabs.admin);
    for (const theme of ["light", "dark"]) {
      await tab.eval(value => { document.documentElement.dataset.theme = value; }, theme);
      if (mobile) {
        await mobileAudit({ tab, out, expect, reportName: `shell-pages-${theme}.json`, step: async (name, check) => {
          await check();
          await tab.shot(`shell-${theme}-${name}`);
        } });
      } else {
        for (const route of ["today", "tasks", "runs", "docs", "skills", "memory", "machines", "pipeline", "settings", "admin"]) {
          await tab.go(route);
          await tab.waitFor("page content loaded", () => !!document.querySelector("#hive-main") && !document.querySelector('main [aria-busy="true"]'));
          expect(await tab.eval(() => {
            const main = document.querySelector("#hive-main");
            return main.getBoundingClientRect().width > 0 && document.documentElement.scrollWidth <= innerWidth;
          }), `shell overflow on ${route}/${theme}`);
          await tab.shot(`shell-${theme}-${route}`);
        }
      }
    }
    await tab.go("today?section=inbox");
  });

  await step("project-onboarding", async () => {
    const tab = (current = tabs.admin);
    await tab.go("tasks");
    await tab.click("[data-new-work-open]");
    await tab.click("[data-onboarding-open]");
    await tab.waitFor("project guide", () => !!document.querySelector("[data-project-onboarding]"));
    await tab.click("#onboarding-project");
    await tab.shortcut("a");
    await tab.type("onboarding-e2e");
    await tab.click("#onboarding-task-id");
    await tab.type("ONBOARDING-E2E-1");
    await tab.click("#onboarding-task-title");
    await tab.type("Kiểm tra dự án mới");
    await tab.waitFor("effective policy", () => !!document.querySelector("[data-onboarding-policy]"));
    await tab.reload();
    await tab.waitFor("resume unsaved task draft", () => document.querySelector("#onboarding-task-id")?.value === "ONBOARDING-E2E-1" && document.querySelector("#onboarding-task-title")?.value === "Kiểm tra dự án mới");
    await tab.shot(`${String(n).padStart(2, "0")}-project-onboarding-draft`);
    await tab.click("[data-onboarding-create]");
    await tab.waitFor("first task saved", () => document.querySelector("[data-onboarding-open-task]")?.textContent.includes("ONBOARDING-E2E-1"));
    expect((await rpc("tasks.list", { project: "onboarding-e2e" })).length === 1, "exactly one task in a new project");
    expect(!(await rpc("runs.requests", { project: "onboarding-e2e" })).length, "saving a task does not dispatch it");
    await tab.reload();
    await tab.waitFor("resume project and task", () => document.querySelector("#onboarding-project")?.value === "onboarding-e2e" && !!document.querySelector("[data-onboarding-open-task]"));
    expect(await tab.eval(() => !document.querySelector("[data-onboarding-create]")), "resume offers the saved task instead of creating it again");
    await tab.click("[data-onboarding-open-task]");
    await tab.waitFor("task panel", () => document.querySelector('[data-slot="sheet-content"]')?.textContent.includes("Kiểm tra dự án mới"));
    await tab.go("start");
    await tab.click("#onboarding-project");
    await tab.shortcut("a");
    await tab.type("onboarding-empty");
    await tab.click("#onboarding-task-id");
    await tab.waitFor("new project has no previous project's task", () => !!document.querySelector("[data-onboarding-create]") && !document.querySelector("[data-onboarding-open-task]"));
    // Other steps begin with the seeded shared scope.
    await tab.eval(() => { localStorage.removeItem("xdev-hive.scope"); for (const key of Object.keys(sessionStorage)) if (key.startsWith("xdev-hive.onboarding:")) sessionStorage.removeItem(key); });
    await tab.reload();
    await tab.go("today");
  });

  if (mobile && tabs.admin) await mobileAudit({ tab: tabs.admin, out, step, expect });

  // The full WCAG audit also reports existing issues needing design work; opt in with --only a11y-pages.
  if (only.length) {
    await step("a11y-pages", async () => {
      const tab = (current = tabs.admin);
      await accessibilityAudit({ tab, out, expect });
    });
  }
  await step("a11y-list-tree", async () => {
    const tab = (current = tabs.admin);
    await rpc("docs.save", { key: "org/skills/a11y-list", content: "---\nname: a11y-list\ndescription: Semantics fixture\n---\nSteps", baseVersion: 0 });
    await rpc("docs.save", { key: "org/a11y-folder", title: "A11y folder", content: "", folder: true, baseVersion: 0 });
    await rpc("docs.save", { key: "org/a11y-child", parent: "org/a11y-folder", title: "A11y child", content: "Child", baseVersion: 0 });
    await tab.go("runs");
    await tab.waitFor("empty runs loaded", () => document.body.innerText.includes("Chưa máy nào báo run") || document.body.innerText.includes("Chưa có run") || document.body.innerText.includes("Không có run"));
    expect(await tab.eval(() => !document.querySelector('main [role="listbox"]')), "empty Runs is not a listbox missing options");
    await accessibilityAudit({ tab, out, expect, routes: ["runs"], filename: "accessibility-runs-empty.json" });
    const at = new Date().toISOString();
    await rpc("runs.push", { machine: "fixture", runs: [{ runId: "R-list-tree", project: "payment", taskId: "PAY-1", taskTitle: "A11y run row", role: "implement", profileId: null, model: "fixture-model", status: "succeeded", createdAt: at, finishedAt: at }] });
    await tab.go("skills");
    await tab.waitFor("skill row", () => !!document.querySelector('main [data-pane-item]'));
    await tab.eval(() => document.querySelector('main [data-pane-item]').focus());
    await tab.key("Enter");
    await tab.waitFor("skill selected", () => !!document.querySelector('main [data-pane-item][aria-pressed="true"]'));
    if (mobile) await tab.click("button", "Quay lại");
    await tab.click("label", "Skill không ai dùng");
    expect(await tab.eval(() => !document.querySelector('main [role="listbox"] input')), "Skills filter remains outside composite list semantics");
    await accessibilityAudit({ tab, out, expect, routes: ["skills"], filename: "accessibility-skills-filter.json" });
    await tab.click('input[aria-label="Tìm skill"]');
    await tab.type("a11y-no-matching-skill");
    await tab.waitFor("empty filtered skills", () => document.body.innerText.includes("Không có skill nào khớp."));
    await accessibilityAudit({ tab, out, expect, routes: ["skills"], filename: "accessibility-skills-empty.json" });
    await tab.go("docs");
    await tab.waitFor("nested docs list", () => !!document.querySelector('[data-doc-list] ul ul'));
    if (mobile) expect(await tab.eval(() => [...document.querySelectorAll('[data-doc-list] button')].filter(el => el.getBoundingClientRect().width && getComputedStyle(el).visibility !== "hidden").every(el => {
      const r = el.getBoundingClientRect();
      return r.width >= 44 && r.height >= 44;
    })), "Docs row and disclosure actions have 44px touch targets");
    const toggle = '[data-doc-list] div:has(> [data-doc-item][title="org/a11y-folder"]) > button[aria-expanded="true"]';
    await tab.eval(selector => document.querySelector(selector).focus(), toggle);
    await tab.key("Enter");
    expect(await tab.eval(() => document.activeElement?.getAttribute("aria-expanded") === "false"), "keyboard collapses folder");
    await tab.key(" ");
    expect(await tab.eval(() => document.activeElement?.getAttribute("aria-expanded") === "true"), "keyboard expands folder");
    await tab.shot("a11y-docs");
    await tab.eval(() => document.querySelector('[data-doc-item][title="org/a11y-folder"]').focus());
    await tab.key("Tab");
    expect(await tab.eval(() => document.activeElement?.getAttribute("aria-label") === "Thêm trang trong A11y folder"), "Tab reaches row add action");
    await tab.key("Enter");
    await tab.waitFor("add child form", () => !!document.querySelector('[data-new-doc-key]'));
    await tab.click("button", "Huỷ");
    await tab.go("memory");
    await tab.click("button", "Chờ duyệt");
    await tab.waitFor("bulk checkbox", () => !!document.querySelector('main li [role="checkbox"]'));
    expect(await tab.eval(() => !document.querySelector('main button [role="checkbox"]')), "bulk checkbox is a sibling of the card button");
    await tab.eval(() => document.querySelector('main li [role="checkbox"]').focus());
    await tab.key(" ");
    expect(await tab.eval(() => document.activeElement?.getAttribute("aria-checked") === "true"), "Space selects bulk checkbox");
    expect(await tab.eval(() => !document.querySelector('[role="dialog"]')), "bulk selection does not open the memory detail");
    await accessibilityAudit({ tab, out, expect, routes: ["runs", "docs", "skills"] });
  });
  await step("a11y-menu", async () => {
    const tab = (current = tabs.admin);
    await keyboardMenu({ tab, mobile, expect, out });
  });
  await step("a11y-overlays", async () => {
    const tab = (current = tabs.admin);
    await keyboardOverlays({ tab, expect });
  });
  await step("a11y-table", async () => {
    const tab = (current = tabs.admin);
    await keyboardTable({ tab, expect });
  });
  if (only.length) {
    await step("a11y-components", async () => {
      const tab = (current = tabs.admin);
      await dataTableAccessibility({ tab, mobile, expect });
      await memoryAccessibility({ tab, mobile, expect, out });
      await tab.eval(() => sessionStorage.setItem("hive-e2e-fixtures", "1"));
      await tab.go("ops?e2e=dashboard-components");
      await tab.waitFor("shared dashboard components", () => document.querySelectorAll("main [data-summary]").length === 3 && document.querySelectorAll("main [data-attention]").length === 2);
      const shared = await tab.eval(() => ({
        links: [...document.querySelectorAll("main [data-summary]")].map((el) => ({ id: el.dataset.summary, href: el.getAttribute("href") })),
        actions: [...document.querySelectorAll("main [data-attention]")].map((row) => ({ id: row.dataset.attention, action: row.querySelector("button")?.textContent.trim(), disabled: row.querySelector("button")?.disabled })),
      }));
      expect(shared.links.every((link) => link.href?.startsWith("#/") && link.href.includes("?status=")), `summary items must link to filters: ${JSON.stringify(shared.links)}`);
      const actions = Object.fromEntries(shared.actions.map((action) => [action.id, action]));
      expect(actions.quota?.action === "Xem chi tiết" && !actions.quota?.disabled, "attention action should be available on its row");
      expect(actions.backup?.action === "Vô hiệu hóa" && actions.backup?.disabled, "disabled attention action should stay disabled on its row");
      await accessibilityAudit({ tab, out, expect, routes: ["memory", "machines?tab=fleet", "ops?e2e=dashboard-components"], filename: "components-accessibility.json" });
    });
  }
  await step("cosmic-primitives", async () => {
    const tab = (current = tabs.admin);
    await tab.eval(() => { sessionStorage.setItem("hive-e2e-fixtures", "1"); document.documentElement.dataset.theme = "dark"; });
    await tab.go("ops?e2e=dashboard-components");
    await tab.waitFor("cosmic themes", () => document.querySelectorAll("[data-cosmic-fixture]").length === 2);
    const styles = await tab.eval(() => [...document.querySelectorAll("[data-cosmic-fixture]")].map(el => ({ theme: el.dataset.theme, font: getComputedStyle(el).fontFamily, surface: getComputedStyle(el.querySelector('[data-slot="card"]')).backgroundColor })));
    expect(styles.every(style => style.font.includes("Inter")), "Inter must be self-hosted and applied");
    expect(styles[0].surface === "rgb(29, 28, 32)" && styles[1].surface === "rgb(255, 255, 255)", `nested themes: ${JSON.stringify(styles)}`);
    if (mobile) {
      const sizing = await tab.eval(() => [...document.querySelectorAll('[data-cosmic-fixture]')].map(el => ({
        inputFont: parseFloat(getComputedStyle(el.querySelector('[data-slot="input"]')).fontSize),
        smallButtons: [...el.querySelectorAll('[data-slot="button"][data-size="sm"]')].map(button => button.getBoundingClientRect().height),
        switches: [...el.querySelectorAll('input[role="switch"]')].map(input => ({ height: input.getBoundingClientRect().height, target: input.closest('label').getBoundingClientRect().height })),
        overflow: el.scrollWidth > el.clientWidth,
      })));
      expect(sizing.every(theme => theme.inputFont >= 16 && theme.smallButtons.every(height => height >= 44) && theme.switches.every(input => input.height === 26 && input.target >= 44) && !theme.overflow), `mobile cosmic sizing: ${JSON.stringify(sizing)}`);
    }
    // Render the source bundle independently so the comparison cannot inherit component implementation mistakes.
    const context = { window: {}, React: { ...React, useEffect() {} } };
    runInNewContext(readFileSync(path.resolve(import.meta.dirname, "../../../docs/design/hive-2026-10/_ds/lumibase-design-system-cffa39a8-d3bd-4d37-982f-2d2208c49e76/_ds_bundle.js"), "utf8"), context);
    const ds = context.window.LumibaseDesignSystem_cffa39;
    const h = React.createElement;
    const reference = renderToStaticMarkup(h(React.Fragment, null,
      ...["sm", "md", "lg"].map(size => h("div", { className: "cosmic-fixture-wrap", key: size }, ...["glass", "solid", "blue", "ghost"].map((variant, i) => h(ds.Button, { size, variant, key: variant }, ["Kính", "Tím", "Xanh", "Trong suốt"][i])))),
      h("div", { className: "cosmic-fixture-wrap" }, h(ds.Tag, null, "Nhãn & trạng thái"), h(ds.Tag, { active: true }, "Nhãn & trạng thái"), h(ds.Badge, { tone: "green" }, "Nhãn & trạng thái")),
      h(ds.Input, { placeholder: "Nhập tên công việc", "aria-label": "Tên công việc" }),
      h("div", { className: "cosmic-fixture-wrap", style: { minHeight: 44 } }, h(ds.Toggle, { "aria-label": "Tắt" }), h(ds.Toggle, { checked: true, "aria-label": "Bật" }))));
    await tab.eval((html) => {
      const el = document.querySelector("[data-compare-reference]");
      el.style.cssText = "--color-text:var(--text-primary);--color-text-secondary:var(--text-secondary);--color-violet:var(--action-primary-bg);--color-blue:var(--action-blue-bg);--color-green:var(--accent-green);--color-glass:var(--glass-bg);--color-surface-3:var(--surface-3);--color-surface-4:var(--surface-4);--color-surface-sunken:var(--surface-sunken);--radius-full:999px;--radius-xs:8px;--radius-sm:12px;--text-micro:600 11px/16px var(--font-sans);--text-body-sm:500 14px/22px var(--font-sans);--shadow-sm:var(--switch-thumb-shadow);--duration:240ms;--ease-out:var(--ease-standard)";
      el.insertAdjacentHTML("beforeend", html);
    }, reference);
    if (!mobile) {
      const measurements = await tab.eval(() => {
        const shared = [...document.querySelectorAll('[data-compare-shared] [data-slot="button"]')];
        const original = [...document.querySelectorAll('[data-compare-reference] button:not([role])')];
        return shared.map((el, i) => {
          const a = getComputedStyle(el), b = getComputedStyle(original[i]);
          return { size: el.dataset.size, variant: el.dataset.variant, mismatch: ["height", "paddingLeft", "paddingRight", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "gap", "borderRadius", "backgroundColor", "boxShadow", "color", "textShadow"].filter(key => a[key] !== b[key]) };
        });
      });
      expect(measurements.every(m => !m.mismatch.length), `source bundle comparison: ${JSON.stringify(measurements)}`);
      const controls = await tab.eval(() => {
        const shared = document.querySelector('[data-compare-shared]');
        const reference = document.querySelector('[data-compare-reference]');
        const pairs = [
          [shared.querySelector('.cosmic-tag'), reference.children[4].children[0]],
          [shared.querySelector('.cosmic-tag[data-active="true"]'), reference.children[4].children[1]],
          [shared.querySelector('[data-slot="badge"]'), reference.children[4].children[2]],
          [shared.querySelector('[data-slot="input"]'), reference.children[5]],
          [shared.querySelector('input[role="switch"]'), reference.querySelector('button[role="switch"]')],
          [shared.querySelector('input[role="switch"]:checked'), reference.querySelector('button[aria-checked="true"]')],
        ];
        return pairs.map(([a, b], i) => ({ control: i, mismatch: ["height", "paddingLeft", "paddingRight", "borderRadius", "backgroundColor", "boxShadow"].filter(key => getComputedStyle(a)[key].replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px, ?/g, "") !== getComputedStyle(b)[key].replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px, ?/g, "")) }));
      });
      expect(controls.every(c => !c.mismatch.length), `source controls comparison: ${JSON.stringify(controls)}`);
      writeFileSync(path.join(out, "cosmic-measurements.json"), JSON.stringify({ buttons: measurements, controls }, null, 2));
      await tab.eval(() => document.querySelector('[data-cosmic-compare]').scrollIntoView({ block: "start" }));
      await tab.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await sleep(150);
      await tab.shot("cosmic-design-compare");
    }
    const overrides = await tab.eval(() => {
      const button = document.querySelector('[data-utility-override]');
      const style = getComputedStyle(button);
      const result = { height: style.height, padding: style.paddingLeft, radius: style.borderRadius };
      return result;
    });
    expect(overrides.height === (mobile ? "44px" : "24px") && overrides.padding === "4px" && overrides.radius === "8px", `caller utilities with mobile touch minimum: ${JSON.stringify(overrides)}`);
    await tab.click('[data-cosmic-fixture="dark"] .cosmic-segments button', "Đang chạy");
    expect(await tab.eval(() => document.querySelector('[data-cosmic-fixture="dark"] .cosmic-segments button[aria-pressed="true"]').textContent === "Đang chạy"), "filter selection must update");
    await tab.click('[data-cosmic-fixture="dark"] input[role="switch"]');
    expect(await tab.eval(() => !document.querySelector('[data-cosmic-fixture="dark"] input[role="switch"]').checked), "switch must toggle");
    await tab.key(" ");
    expect(await tab.eval(() => document.querySelector('[data-cosmic-fixture="dark"] input[role="switch"]').checked), "Space must toggle the focused switch");
    await tab.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await tab.waitFor("reduced motion disables glass filter", () => getComputedStyle(document.querySelector('.cosmic-glass-overlay')).backdropFilter === "none");
    await tab.cdp("Emulation.setEmulatedMedia", { features: [] });
    await tab.eval(() => document.querySelector('[data-cosmic-fixture="dark"]').scrollIntoView({ block: "start" }));
    await tab.waitFor("dark fixture scrolled into view", () => document.querySelector('[data-cosmic-fixture="dark"]').getBoundingClientRect().top < 150);
    await tab.shot(`cosmic-dark-${mobile ? "390x844" : "1440x900"}`);
    await tab.eval(() => document.querySelector('[data-cosmic-fixture="light"]').scrollIntoView({ block: "start" }));
    await tab.waitFor("light fixture scrolled into view", () => document.querySelector('[data-cosmic-fixture="light"]').getBoundingClientRect().top < 150);
    await tab.win.webContents.executeJavaScript(axe.source);
    const contrast = await tab.eval(async () => {
      const { violations } = await window.axe.run(document.querySelector('[data-cosmic-fixture="light"]'), { runOnly: { type: "rule", values: ["color-contrast"] } });
      return violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
    });
    expect(!contrast.length, `light cosmic contrast: ${JSON.stringify(contrast)}`);
    await tab.shot(`cosmic-light-${mobile ? "390x844" : "1440x900"}`);
    await tab.eval(() => { document.querySelector("main").scrollTop = 0; });
  });
  await step("a11y-run-status", async () => {
    const tab = (current = tabs.admin);
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.a11y" }, body: JSON.stringify({ method, input }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
    const at = new Date().toISOString();
    await machineRpc("machines.heartbeat", { machine: "a11y", instance: "a1100001", version: "0.142.0", projects: ["payment"] });
    const run = { runId: "R-a11y", project: "payment", taskId: "PAY-1", taskTitle: "Kiểm trạng thái run", role: "implement", profileId: null, status: "running", createdAt: at, startedAt: at };
    await machineRpc("runs.push", { machine: "a11y", runs: [run] });
    await tab.go("runs?run=R-a11y");
    await tab.waitFor("selected live run", () => document.querySelector("main h2")?.textContent === "Kiểm trạng thái run");
    await tab.waitFor("live run announcement", () => document.querySelector('[data-run-state][role="status"]')?.textContent.includes("Đang chạy"));
    await machineRpc("runs.push", { machine: "a11y", runs: [{ ...run, status: "succeeded", finishedAt: new Date().toISOString() }] });
    await tab.waitFor("completed run announcement", () => document.querySelector('[data-run-state][role="status"]')?.textContent.includes("Xong"));
    await runContrast({ tab, expect });
  });

  await step("auto-release", async () => {
    const previous = (await rpc("sdlc.get", {})).projects.payment;
    const tab = current = tabs.admin;
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.release-e2e" }, body: JSON.stringify({ method, input }) });
      const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
    };
    try {
      await machineRpc("machines.heartbeat", { machine: "release-e2e", instance: "aa00bb11", projects: ["payment"], acceptsRuns: true });
      const machine = (await rpc("machines.list", {})).find(m => m.machine === "release-e2e");
      expect(!!machine, "fixture Gate machine exists");
      await rpc("tasks.create", { project: "payment", id: "RELEASE-E2E", title: "Green batch fixture" });
      await rpc("tasks.update", { id: "RELEASE-E2E", status: "done" });
      await rpc("sdlc.setProject", { project: "payment", settings: { gates: { ...previous.gates, release: "human" }, releaseMachine: machine.id } });
      await tab.go("pipeline?project=payment");
      await tab.waitFor("release gate", () => !!document.querySelector('[data-pipeline-gate="release"]'));
      await tab.click('[data-pipeline-gate="release"]');
      await tab.waitFor("release editor excludes AI and shows machine", () => !!document.querySelector("[data-release-machine]") && !document.querySelector('[data-pipeline-editor] [data-pipeline-mode="ai"]'));
      if (mobile) {
        const bounds = await tab.eval(() => [...document.querySelectorAll('[data-pipeline-editor] button')].filter(e => e.getBoundingClientRect().width).map(e => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
        expect(bounds.every(r => r.w >= 44 && r.h >= 44), `release targets: ${JSON.stringify(bounds)}`);
      }
      await tab.shot("auto-release-gate");
      await tab.key("Escape");
      await tab.waitFor("release editor closed", () => !document.querySelector("[data-pipeline-editor]"));
      await machineRpc("autoRelease.green", { project: "payment", batchId: "e2e-green", version: "9.0.1", sha: "a".repeat(40), taskIds: ["RELEASE-E2E"], checks: [{ name: "fixture full checks", passed: true }], landed: true });
      await tab.reload();
      await tab.waitFor("human release appears", () => document.querySelector("[data-release-queue]")?.textContent.includes("9.0.1"));
      await tab.click("[data-release-queue] button", "Duyệt phát hành");
      await until("release approved", async () => (await rpc("autoRelease.list", { project: "payment" })).releases[0]?.state === "queued");
      await machineRpc("autoRelease.take", { project: "payment" });
      await machineRpc("autoRelease.result", { project: "payment", batchId: "e2e-green", success: false, step: "deploy" });
      await tab.reload();
      await tab.waitFor("release queue paused", () => document.querySelector("[data-release-queue]")?.textContent.includes("Hàng chờ đã dừng"));
      if (mobile) expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "release fits phone");
      await tab.shot("auto-release-failed");
      await tab.go("today?section=inbox");
      await tab.waitFor("release failure in Today", () => document.body.textContent.includes("OPS-release-9.0.1"));
      await tab.shot("auto-release-today");
    } finally {
      await rpc("sdlc.setProject", { project: "payment", settings: { gates: previous.gates, maxFixRounds: previous.maxFixRounds, maxParallel: previous.maxParallel, fastLaneKinds: previous.fastLaneKinds, planApproval: previous.planApproval, releaseMachine: previous.releaseMachine ?? null } });
      await rpc("autoRelease.resume", { project: "payment" });
      await rpc("tasks.update", { id: "OPS-release-9.0.1", status: "done" }).catch(() => null);
    }
  });
  await step("merge-queue", async () => {
    const project = "autopilot-fixture";
    const instance = "60b060b0";
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.merge-e2e" }, body: JSON.stringify({ method, input }) });
      const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
    };
    await machineRpc("machines.heartbeat", { machine: "merge-e2e", instance, projects: [project], gateRunner: true });
    const machine = (await rpc("machines.list")).find(m => m.machine === "merge-e2e");
    await rpc("tasks.create", { project, id: "MERGE-E2E", title: "Merge fixture", kind: "feature" });
    await machineRpc("runs.push", { machine: "merge-e2e", runs: [{ runId: "R-merge-e2e", project, taskId: "MERGE-E2E", taskTitle: "Merge fixture", role: "review", status: "succeeded", verdict: "approve", branch: "ai/MERGE-E2E", profileId: null, createdAt: new Date().toISOString() }] });
    await rpc("tasks.update", { id: "MERGE-E2E", status: "review" });
    const tab = current = tabs.admin;
    await tab.go("runs");
    // This fixture creates a service after sign-in; refresh the shell's service inventory too.
    await tab.reload();
    await tab.waitFor("merge queue", () => !!document.querySelector("[data-merge-queue]"));
    await tab.click("[data-merge-queue] > summary");
    await tab.waitFor("merge fixture in the refreshed service list", (project) => [...document.querySelectorAll("[data-merge-queue] > label select option")].some((option) => option.value === project), project);
    await tab.select("[data-merge-queue] > label select", project);
    await tab.waitFor("waiting branch", () => document.querySelector("[data-merge-queue]")?.textContent.includes("ai/MERGE-E2E"));
    await tab.click("[data-merge-queue] summary", "Cài đặt hàng chờ");
    await tab.click('[data-merge-queue] button[role="switch"]');
    await tab.select("[data-merge-machine]", machine.id);
    for (const [selector, value] of [["[data-merge-max]", "1"], ["[data-merge-wait]", "0"], ["[data-merge-commands]", "true"]]) {
      await tab.click(selector); await tab.shortcut("a"); await tab.type(value);
    }
    await tab.select("[data-merge-mode]", "push");
    await tab.click('[data-merge-queue] button[type="submit"]');
    await until("saved queue", async () => (await rpc("mergeQueue.get", { project })).config.enabled === true);
    if (mobile) {
      // Radix Switch adds an aria-hidden, unfocusable checkbox inside a form; only fields a person types in can zoom iOS.
      const layout = await tab.eval(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, fonts: [...document.querySelectorAll("[data-merge-queue] input, [data-merge-queue] select, [data-merge-queue] textarea")].filter(e => e.getBoundingClientRect().width && !e.closest('[aria-hidden="true"]')).map(e => parseFloat(getComputedStyle(e).fontSize)) }));
      expect(!layout.overflow && layout.fonts.every(size => size >= 16), `merge form on phone: ${JSON.stringify(layout)}`);
    }
    await tab.shot("merge-queue-settings");
    const batch = await machineRpc("mergeQueue.take", { project, instance });
    expect(!!batch, "Gate takes the waiting branch");
    await machineRpc("mergeQueue.finish", { id: batch.id, instance, result: { status: "landed", sha: "b".repeat(40), step: "landed", outcomes: [{ taskId: "MERGE-E2E", status: "included", sha: "a".repeat(40) }] } });
    await tab.reload();
    await tab.click("[data-merge-queue] > summary");
    // The service picker is page state: after a reload it is empty again and no queue shows.
    await tab.waitFor("merge fixture after reload", (project) => [...document.querySelectorAll("[data-merge-queue] > label select option")].some((option) => option.value === project), project);
    await tab.select("[data-merge-queue] > label select", project);
    await tab.waitFor("landed merge", () => document.querySelector("[data-merge-queue]")?.textContent.includes("Đã vào nhánh đích"));
    expect((await rpc("tasks.list", { project })).find(t => t.id === "MERGE-E2E")?.status === "done", "landing completes the task");
    await tab.shot("merge-queue-landed");
  });

  await step("blocker-center", async () => {
    const tab = (current = tabs.admin);
    await rpc("tasks.create", { project: "payment", id: "BLOCKER-DEP", title: "Dependency blocker", dependsOn: ["PAY-1"] });
    await rpc("tasks.create", { project: "payment", id: "BLOCKER-UNKNOWN", title: "Needs diagnosis" });
    await rpc("tasks.update", { id: "BLOCKER-UNKNOWN", status: "blocked", note: "Inspect the latest run" });
    await tab.go("tasks");
    await tab.click('[data-task-view="blockers"]');
    await tab.waitFor("dependency blocker", () => document.querySelector('[data-blocker-kind="dependency"]')?.textContent.includes("BLOCKER-DEP"));
    expect(await tab.eval(() => document.documentElement.scrollWidth <= window.innerWidth), "blocker centre fits viewport");
    if (mobile) expect(await tab.eval(() => [...document.querySelectorAll('[data-blocker-filter]')].every(button => button.getBoundingClientRect().height >= 44)), "blocker filters have touch targets");
    await tab.click('[data-blocker-filter="unknown"]');
    await tab.waitFor("diagnosis filter", () => document.querySelector('[data-blocker-kind="unknown"]')?.textContent.includes("BLOCKER-UNKNOWN") && !document.querySelector('[data-blocker-kind="dependency"]'));
    await tab.click('[data-blocker-filter="dependency"]');
    await tab.click('[data-blocker-kind="dependency"] button');
    await tab.waitFor("task resolution sheet", () => document.body.innerText.includes("Dependency blocker") && !!document.querySelector('[role="dialog"]'));
    await tab.key("Escape");
    await tab.shot(`${String(n).padStart(2, "0")}-blocker-center`);
    await tab.click('[data-task-view="kanban"]');
  });

  await step("scope-search-tasks", async () => {
    const tab = (current = tabs.admin);
    await tab.go("tasks");
    await tab.waitFor("tasks from several projects", () => document.body.innerText.includes("Việc đầu tiên của payment") && document.body.innerText.includes("Việc đầu tiên của demo"));
    await tab.click("[data-project-picker-trigger]");
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("pay");
    await tab.waitFor("payment in the picker", () => [...document.querySelectorAll('[role="option"]')].some((item) => item.textContent.includes("payment")));
    await tab.key("Enter");
    await tab.waitFor("only payment tasks", () => document.body.innerText.includes("Việc đầu tiên của payment") && !document.body.innerText.includes("Việc đầu tiên của demo") && !document.body.innerText.includes("Việc đầu tiên của ledger"));
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả service");
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

  await step("auto-dispatch", async () => {
    const tab = (current = tabs.admin);
    const original = (await rpc("sdlc.get")).projects.payment;
    const router = await rpc("modelRouter.get");
    try {
      await tab.go("pipeline?project=payment");
      await tab.click('[data-pipeline-preset="maximum"]');
      await tab.waitFor("auto-dispatch preview", () => !!document.querySelector('[data-auto-dispatch-preview]'));
      await tab.click('[data-pipeline-apply]');
      await until("maximum enables auto-dispatch", async () => (await rpc("sdlc.get")).projects.payment?.autoDispatch === true);
      await tab.waitFor("preset closed", () => !document.querySelector('[data-pipeline-preview]'));
      await tab.click('[data-pipeline-gate="dispatch"]');
      await tab.waitFor("auto-dispatch enabled", () => document.querySelector('[data-auto-dispatch]')?.checked === true);
      const target = await tab.eval(() => document.querySelector('[data-auto-dispatch]').closest('label').getBoundingClientRect().height);
      expect(target >= 44, `auto-dispatch touch target: ${target}`);
      await tab.shot(`${String(n).padStart(2, "0")}-auto-dispatch`);
      await tab.click('[data-auto-dispatch]');
      await tab.click('[data-auto-kind="claude"]');
      await tab.eval(() => document.querySelector('[data-pipeline-save]').focus());
      await tab.key("Enter");
      await until("auto-dispatch and allowed kinds saved", async () => {
        const p = (await rpc("sdlc.get")).projects.payment;
        return p?.autoDispatch === false && !p.allowedAgentKinds.includes("claude");
      });
      await tab.reload();
      await tab.click('[data-pipeline-gate="dispatch"]');
      await tab.waitFor("disabled state persisted", () => document.querySelector('[data-auto-dispatch]')?.checked === false);
      expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth + 1), "auto-dispatch overflow");
      await tab.key("Escape");
    } finally {
      await rpc("sdlc.setProject", { project: "payment", settings: original ?? null });
      await rpc("modelRouter.set", { project: "payment", setting: router.projects.payment ?? { enabled: true, profile: "balanced", cells: {} } });
    }
  });

  await step("graph", async () => {
    await rpc("tasks.create", { id: "PAY-GRAPH", project: "payment", title: "Kiểm tra sơ đồ", dependsOn: ["PAY-1"] });
    const heartbeat = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" }, body: JSON.stringify({ method: "machines.heartbeat", input: { machine: "lan-mbp", instance: "e2e00001", version: "0.135.0", projects: ["payment"], acceptsRuns: true, profiles: [{ id: "graph-plan", label: "Graph plan", kind: "codex", enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 2, sessionPercent: 25, weekPercent: 40 }], runs: [] } }) });
    const beat = await heartbeat.json();
    if (beat.error) throw new Error(`graph heartbeat: ${beat.error.message}`);
    const graphMachine = (await rpc("machines.list")).find((m) => m.machine === "lan-mbp");
    const tab = (current = tabs.admin);
    await openPicker();
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("payment");
    await tab.key("Enter");
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
    // 51c opened the SDLC layer; only System stays locked in a single project (it needs a system scope).
    const locked = await tab.eval(() => [...document.querySelectorAll('[aria-label="Lớp sơ đồ"] button:disabled')].map((b) => b.getAttribute("data-graph-layer")));
    expect(locked.length === 1 && locked[0] === "system", `only the System layer is locked in a project: ${locked}`);
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
    await openPicker();
    await tab.click('[role="option"]', "Tất cả service");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
  });

  // Roadmap 40c: in a system's scope the Docs tree has the system's pages first, then a group per service, and a new page
  // goes to system/<name>/ unless another place is picked.
  await step("docs-system-default", async () => {
    const overview = await rpc("docs.get", { key: "system/ban-hang/tong-quan" });
    await rpc("docs.save", { key: "system/ban-hang/tong-quan", title: "Tổng quan", content: `${overview?.content ?? "# Tổng quan\n"}\nBa service.\n`, baseVersion: overview?.version ?? 0 });
    const tab = (current = tabs.admin);
    await openPicker();
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("ban-hang");
    await tab.click('[role="option"]', "ban-hang");
    // Otherwise the drawer's scrim takes the click on "+ Trang" and no form opens (the "new page's key" timeout).
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.go("docs");
    await tab.waitFor("the system's page before the service groups", () => {
      const rows = [...document.querySelectorAll('[data-doc-list] > ul > li > div')];
      const first = rows.findIndex((r) => r.querySelector('[title="system/ban-hang/tong-quan"]'));
      const groups = ["demo", "ledger", "payment"].map((p) => rows.findIndex((r) => r.dataset.serviceGroup === p));
      // Earlier full-suite steps finish tasks and create the system journal before this page.
      return first >= 0 && groups.every((g) => g > first);
    });
    await tab.click("button", "+ Trang");
    await tab.type("Quy ước chung");
    const key = await tab.waitFor("the new page's key", () => document.querySelector("[data-new-doc-key]")?.textContent.trim());
    expect(key === "system/ban-hang/quy-uoc-chung", `new page key: ${key}`);
    const places = await tab.eval(() => [...(document.querySelector("select[data-doc-owner]")?.options ?? [])].map((o) => o.value));
    expect(["sys:ban-hang", "demo", "ledger", "payment"].every((o) => places.includes(o)), `places to put it: ${places}`);
    await tab.key("Enter");
    await tab.waitFor("the new page picked in the tree", () => document.querySelector('[data-doc-item][aria-current="page"]')?.getAttribute("title") === "system/ban-hang/quy-uoc-chung");
    // On a phone too the new page opens on its editor (only shown ones are clicked), not behind the assistant.
    await tab.click(".ProseMirror");
    await tab.type("Mọi service dùng chung.");
    // On a phone saving sits in the modes menu (roadmap 42b), as in docs-rich-editor.
    if (mobile) await tab.click("summary", "Chế độ");
    await tab.click("button", "Lưu thành v1");
    await until("the page saved in the system", async () => (await rpc("docs.get", { key: "system/ban-hang/quy-uoc-chung" }))?.version === 1);
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả service");
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
    if (mobile) {
      // The phone menu is a Sheet, mounted only while open: the account line is inside it.
      await tab.waitFor("Hoa signed in", () => !document.querySelector("#username") && !!document.querySelector('button[aria-label="Ẩn hoặc hiện thanh bên"]'));
      await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    }
    await tab.waitFor("Hoa signed in", () => !document.querySelector("#username") && document.body.innerText.includes("@hoa"));
    // A member's menu has no project settings or hub administration (Máy & agent, the team's machines, stays).
    const nav = await tab.eval(() => document.querySelector("nav")?.innerText ?? "");
    for (const label of ["Cài đặt service", "Quản trị", "Đội máy", "Hàng đợi", "Nhật ký"]) expect(!nav.includes(label), `${label} in Hoa's menu:\n${nav}`);
    if (mobile) await tab.click('button[aria-label="Đóng menu"]');
  });

  if (mobile && tabs.hoa) await mobileAudit({ tab: tabs.hoa, out, step, expect,
    pages: ["overview", `device?port=12345&state=${"s".repeat(16)}&challenge=${"c".repeat(43)}`],
    reportName: "mobile-audit-member.json" });

  // Roadmap 49b: the menu by job, for a hub admin and for a project member (Hoa reviews payment). Token and the
  // password are in the account menu; old addresses land on their tab.
  await step("nav-by-job", async () => {
    const menus = [
      // Quy trình (56a) is for whoever may view a project: Hoa views payment, so she reads it without Cài đặt service.
      ["admin", tabs.admin, ["Hôm nay", "Task", "Chat", "Nghiệm thu & phát hành", "Dự án & tính năng", "Agent đang chạy", "Tài liệu", "Memory", "Skill", "Artifact", "Lịch sử", "Sơ đồ", "Máy & agent", "Cài đặt service", "Quản trị"]],
      ["member", tabs.hoa, ["Hôm nay", "Task", "Nghiệm thu & phát hành", "Dự án & tính năng", "Agent đang chạy", "Tài liệu", "Memory", "Skill", "Artifact", "Lịch sử", "Sơ đồ", "Máy & agent"]],
    ];
    for (const [who, tab, want] of menus) {
      current = tab;
      await tab.go("today?section=inbox");
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
      if (mobile) await tab.waitFor("the drawer closed after the account menu", () => !document.querySelector("#hive-navigation"));
    }
    // A member following an admin's old link lands on Hôm nay, not on a page they may not open.
    current = tabs.hoa;
    await tabs.hoa.go("users");
    await tabs.hoa.waitFor("Hôm nay for Hoa", () => document.querySelector('[data-shell-title]')?.textContent.includes("Hôm nay"));
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
    await tab.click("button", "Sửa");
    const text = await tab.waitFor("the members of payment", () => document.body.innerText.includes("Hoa Trần") && document.body.innerText);
    expect(/Minh Lê/.test(text), "Minh is a member of payment");
  });

  await step("admin-grants-a-role", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/users");
    await tab.waitFor("the users table", () => document.body.innerText.includes("@minh"));
    await tab.waitFor("Minh's Phân quyền", () => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.textContent.includes("@minh"));
      const b = row && [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === "Phân quyền");
      b?.setAttribute("data-e2e-target", "");
      return !!b;
    });
    await tab.click("[data-e2e-target]");
    await tab.find('[role="dialog"]');
    expect((await tab.text('[role="dialog"]')).includes("@minh"), "the grants dialog is not Minh's");
    await tab.select('[role="dialog"] select[aria-label="Quyền trên demo"]', "reviewer");
    await tab.waitFor("the reviewer grant selected", () => document.querySelector('[role="dialog"] select[aria-label="Quyền trên demo"]')?.value === "reviewer");
    await tab.click('[role="dialog"] button', "Lưu quyền");
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
    await tab.shortcut("s");
    const doc = await until("version 3", async () => {
      const d = await rpc("docs.get", { key: "project/demo/huong-dan" });
      return d?.version >= 3 && d;
    });
    expect(doc.version === 3 && doc.content.includes("Viết bằng Markdown."), `v${doc.version}:\n${doc.content}`);
  });

  await step("mermaid-draws", async () => {
    const tab = (current = tabs.admin);
    await tab.go(`admin/docs?doc=${encodeURIComponent("project/demo/so-do")}`);
    if (mobile) await tab.click("summary", "Chế độ");
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
    const picked = (key) => document.querySelector('[data-doc-item][aria-current="page"]')?.getAttribute("title") === key;
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
    await tab.go("admin?tab=policy");
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
    await tab.go("settings?tab=context");
    await tab.click("button", "Sửa");
    await tab.select('select[aria-label="Service"]', "payment");
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
    await tab.click('[data-map-manage="lan-mbp"]');
    await tab.click("summary", "Bật/tắt và ưu tiên gói");
    await tab.click('[aria-label="Bật gói claude-1"]');
    await tab.waitFor("the change waiting on the page", () => document.body.innerText.includes("chờ máy áp dụng"));
    await until("the change at Lan's heartbeat", async () => (await beat(before)).profileChanges?.find((c) => c.profileId === "claude-1" && c.enabled === false && c.requestedBy === "lan"));
    // The machine saved it and reports claude-1 off: nothing left to send, the page shows the switch off.
    const after = await beat([profile("claude-1", false, 10), profile("claude-2", true, 20)]);
    expect(after.profileChanges.length === 0, `still sent: ${JSON.stringify(after.profileChanges)}`);
    await tab.reload();
    await tab.go("machines");
    await tab.click('[data-map-manage="lan-mbp"]');
    await tab.click("summary", "Bật/tắt và ưu tiên gói");
    await tab.waitFor("claude-1 off, nothing waiting", () => document.querySelector('[aria-label="Bật gói claude-1"]')?.getAttribute("aria-checked") === "false" && !document.body.innerText.includes("chờ máy áp dụng"));
  });

  await step("quota-outlook", async () => {
    const stamp = new Date().toISOString();
    const sessionAt = new Date(Date.now() + 5 * 3600000).toISOString();
    const weekAt = new Date(Date.now() + 6 * 86400000).toISOString();
    // The hub takes a runner instance as hex only, one per machine.
    for (const [machine, instance] of [["quota-one", "c0a10001"], ["quota-two", "c0a10002"]]) {
      const response = await fetch(`${base}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machine}` },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine, instance, version: "0.136.0", projects: ["payment"], acceptsRuns: true,
          profiles: [{ id: "quota-codex", label: "Quota Codex", kind: "codex", account: "quota-shared", enabled: true, installed: true, loggedIn: true, maxConcurrent: 2, cooldownUntil: null, runs: 0, rateLimited: 0,
            sessionPercent: 40, weekPercent: 20, sessionResetsAt: sessionAt, weekResetsAt: weekAt, usageCheckedAt: stamp, resetsLeft: 23, fullSessionsLeft: 9, weekPerSession: 8, planType: "plus", credits: { balance: 0, hasCredits: false, unlimited: false } }] } }),
      });
      const result = await response.json();
      expect(!result.error, `quota heartbeat: ${JSON.stringify(result.error)}`);
    }
    const tab = current = tabs.lan;
    await tab.eval(() => localStorage.removeItem("xdev-hive.scope"));
    await tab.reload();
    await tab.go("machines?tab=quota");
    await tab.waitFor("shared quota account", () => document.querySelector('[data-quota-account="quota-shared"]'));
    expect(await tab.eval(() => document.querySelectorAll('[data-quota-account="quota-shared"]').length === 1), "shared account counted twice");
    expect(await tab.eval(() => {
      const row = document.querySelector('[data-quota-account="quota-shared"]');
      return row.innerText.includes("quota-one") && row.innerText.includes("quota-two") && row.innerText.includes("ước tính") && row.innerText.includes("credits 0");
    }), "missing machines, estimate or credits");
    expect(await tab.eval(() => document.querySelector('[data-quota-total="codex"]')?.getAttribute("data-quota-slots") === "4"), "shared capacity total differs");
    if (mobile) {
      expect(await tab.eval(() => getComputedStyle(document.querySelector('[data-quota-account="quota-shared"]')).display !== "table-row"), "quota table did not become cards");
      expect(await tab.eval(() => [...document.querySelectorAll("[data-quota-kind], [data-quota-machine], [data-quota-available]")].every(el => (el.tagName === "INPUT" ? el.closest("label") : el).getBoundingClientRect().height >= 44)), "quota controls smaller than 44px");
      expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "quota page overflows phone");
    }
    expect(await tab.eval(() => document.querySelector('[data-quota-table] thead tr').children.length === 5), "quota needs five columns");
    const heights = await tab.eval(() => [...document.querySelectorAll('[data-quota-missing]')].map(row => row.getBoundingClientRect().height));
    if (!mobile) expect(heights.every(h => h <= 72), `missing quota rows taller than 72px: ${heights}`);
    expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "quota overflows viewport");
    for (const theme of ["light", "dark"]) {
      await tab.eval(theme => document.documentElement.dataset.theme = theme, theme);
      await tab.shot(`${String(n).padStart(2, "0")}-quota-outlook-${theme}`);
    }
    await tab.eval(() => document.documentElement.dataset.theme = "light");
    await tab.eval(() => {
      const select = document.querySelector("[data-quota-machine]");
      const option = [...select.options].find(o => o.textContent === "quota-one");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await tab.waitFor("capacity follows machine filter", () => document.querySelector('[data-quota-total="codex"]')?.getAttribute("data-quota-slots") === "2");

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
    expect(await tab.eval(() => !document.querySelector("[data-create-task-toggle], [data-prompt-agent], [data-map-open]") && !document.body.innerText.includes("task_claim")), "task page uses human wording and one create entry");
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
    // Keyboard shortcuts do not go through the click helper, so wait for the dialog overlay too.
    await tab.waitFor("closed new work dialog", () => !document.querySelector('[data-slot="dialog-overlay"]'));
    await tab.shortcut("n");
    await tab.click('[data-new-work-path="ask"]');
    await tab.select("#new-work-project", "payment");
    await tab.click("#new-work-title"); await tab.type("Câu hỏi tiếp theo khi Chat đang mở");
    await tab.click("[data-new-work-submit]");
    await tab.waitFor("replace an existing Chat draft", () => [...document.querySelectorAll("textarea")].some((el) => el.value === "Câu hỏi tiếp theo khi Chat đang mở"));
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
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.139.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1"), profile("claude-2")], runs: [] });
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

  // Roadmap 31c: Lan asks an agent to split a payment job, adds a part to its list and runs it; every part runs on
  // Lan's machine, then one run merges them. The merge fails once and Lan starts it again on Đợt chạy.
  await step("map-reduce", async () => {
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
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.139.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1"), profile("claude-2")], runs: [] });
    /** The machine takes each request and reports its run ended. */
    const finish = async (requests, status, tag) => {
      const at = new Date().toISOString();
      for (const r of requests) {
        const runId = `R-map-${tag}-${r.id}`;
        await machineRpc("runs.requestResult", { id: r.id, status: "accepted", runId });
        await machineRpc("runs.push", {
          machine: "lan-mbp",
          runs: [{ runId, project: "payment", taskId: r.taskId, taskTitle: r.taskTitle, role: r.role, status, profileId: r.profileId ?? "claude-1", createdAt: at, finishedAt: at }],
        });
      }
    };
    const group = async (id) => (await rpc("runs.groups", { project: "payment" })).find((g) => g.id === id);
    await beat();
    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("tasks");
    await tab.click("[data-agent-work-menu]");
    await tab.click("[data-map-open]");
    await tab.click("[data-map-mode=agent]");
    await tab.waitFor("Lan's machine in the list", () => document.querySelector("#map-machine")?.options.length > 1);
    await tab.eval(() => {
      const select = document.querySelector("#map-machine");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, select.options[1].value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await tab.click("#map-job");
    await tab.type("Thêm trang hoàn tiền:\n- Form\n- API\n- Tài liệu");
    await tab.shot(`${String(n).padStart(2, "0")}-map-split-form`);
    await tab.click("[data-map-send]", "Nhờ agent chia");
    const split = await until("the map-reduce group", async () => (await rpc("runs.groups", { project: "payment" })).find((g) => g.kind === "mapreduce"));
    expect(split.phase === "split" && split.parentTask, `phase: ${split.phase}`);
    // The split run (a plan run on the job's task) writes the parts in the task's note, as the agent would.
    const [plan] = (await beat()).runRequests.filter((r) => r.taskId === split.parentTask);
    expect(plan?.role === "plan", `split request: ${plan?.role}`);
    await finish([plan], "succeeded", "split");
    expect((await group(split.id)).parts.length === 0, "the original prompt must not become the split result");
    await rpc("tasks.update", { id: split.parentTask, status: "review", note: "- Form hoàn tiền ở src/refund/form.tsx\n- API hoàn tiền ở src/api/refund.ts" });
    expect((await group(split.id)).phase === "ready", "the split did not leave parts to check");
    // Lan checks the agent's list from the Task page and adds the docs.
    await tab.reload();
    await tab.go("tasks");
    await tab.click(`[data-map-ready="${split.id}"]`);
    await tab.waitFor("the agent's parts", () => document.querySelector("#map-parts")?.value.split("\n").length === 2);
    await tab.eval(() => {
      const box = document.querySelector("#map-parts");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, `${box.value}\nTài liệu ở docs/refund.md`);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tab.click("[data-map-profile=claude-2]");
    await tab.shot(`${String(n).padStart(2, "0")}-map-ready-form`);
    await tab.click("[data-map-send]", "Chạy 3 việc con");
    const map = await until("the parts", async () => ((g) => g?.phase === "map" && g)(await group(split.id)));
    expect(map.items.length === 3 && map.items.every((i) => i.profileId === "claude-2" && i.machineId === map.machineId), `items: ${map.items.map((i) => `${i.taskId}:${i.profileId}`).join()}`);
    // Every part runs and succeeds; the next heartbeat brings the merge run on the job's task.
    await finish((await beat()).runRequests.filter((r) => r.taskId.startsWith(`${split.parentTask}-`)), "succeeded", "part");
    const [merge] = (await beat()).runRequests.filter((r) => r.taskId === split.parentTask);
    expect(merge?.role === "implement" && merge.reviewAfter && merge.instructions.includes(`ai/${split.parentTask}-3`), "no merge run of the three branches");
    await finish([merge], "failed", "merge");
    await tab.go(`runs?tab=batches&group=${split.id}`);
    await tab.waitFor("the job stopped", (id) => document.querySelector(`[data-group="${id}"] [data-map-phase]`)?.getAttribute("data-map-phase") === "stopped", split.id);
    await tab.shot(`${String(n).padStart(2, "0")}-map-stopped`);
    await tab.click("[data-map-resume]");
    await tab.waitFor("merging again", (id) => document.querySelector(`[data-group="${id}"] [data-map-phase]`)?.getAttribute("data-map-phase") === "reduce", split.id);
    const [again] = (await beat()).runRequests.filter((r) => r.taskId === split.parentTask);
    expect(again, "no second merge run");
    await finish([again], "succeeded", "merge2");
    await tab.reload();
    await tab.go(`runs?tab=batches&group=${split.id}`);
    await tab.waitFor("merged", (id) => document.querySelector(`[data-group="${id}"] [data-map-phase]`)?.getAttribute("data-map-phase") === "done", split.id);
  });

  // Roadmap 31d: Lan runs one payment task as a chain of roles on her machine: code, then tests, then review, each with
  // its profile. The tests step fails once, the chain stops there, and Lan starts it again on Đợt chạy.
  await step("roles", async () => {
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
    const beat = async () =>
      (await machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.139.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1"), profile("claude-2")], runs: [] }))
        .runRequests.filter((r) => r.taskId === "PAY-ROLES");
    /** The machine takes the step's request and reports its run ended. */
    const finish = async (r, status) => {
      const at = new Date().toISOString();
      const runId = `R-roles-${r.id}`;
      await machineRpc("runs.requestResult", { id: r.id, status: "accepted", runId });
      await machineRpc("runs.push", {
        machine: "lan-mbp",
        runs: [{ runId, project: "payment", taskId: r.taskId, taskTitle: r.taskTitle, role: r.role, status, profileId: r.profileId ?? "claude-1", createdAt: at, finishedAt: at }],
      });
    };
    await rpc("tasks.create", { project: "payment", id: "PAY-ROLES", title: "Hoàn tiền một phần" });
    await beat();
    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("tasks");
    await tab.click('[data-task-view="list"]');
    await tab.waitFor("the task's pick box", () => !!document.querySelector('[data-pick-task="PAY-ROLES"]'));
    // Clicked in the page: a notice coming in above the table would move it under a pointer click.
    await tab.eval(() => document.querySelector('[data-pick-task="PAY-ROLES"]').click());
    await tab.waitFor("PAY-ROLES picked", () => document.querySelector('[data-pick-task="PAY-ROLES"]')?.getAttribute("data-state") === "checked");
    await tab.click("[data-roles-open]");
    await tab.waitFor("Lan's machine in the list", () => document.querySelector("#roles-machine")?.options.length > 1);
    const pick = (selector, value) =>
      tab.eval(
        (s, v) => {
          const select = document.querySelector(s);
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, v ?? select.options[1].value);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        },
        selector,
        value,
      );
    await pick("#roles-machine");
    await tab.waitFor("the steps' profiles", () => [...(document.querySelector("#roles-profile-1")?.options ?? [])].some((o) => o.value === "claude-2"));
    await pick("#roles-profile-0", "claude-1");
    await pick("#roles-profile-1", "claude-2");
    // The sheet slides in: shoot it once it is all in view.
    await tab.waitFor("the form in view", () => document.querySelector("[data-roles-form]").getBoundingClientRect().right <= window.innerWidth);
    await tab.shot(`${String(n).padStart(2, "0")}-roles-form`);
    await tab.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await tab.waitFor("role form fits a phone", () => document.querySelector("[data-roles-form]").getBoundingClientRect().right <= 390);
    const controls = await tab.eval(() => [...document.querySelectorAll("[data-roles-form] button, [data-roles-form] select, [data-roles-form] input")].map((el) => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize), tag: el.tagName })));
    expect(controls.every((el) => el.height >= 44), `role touch targets: ${JSON.stringify(controls)}`);
    expect(controls.filter((el) => el.tag === "SELECT").every((el) => el.font >= 16), "role selects must not zoom a phone");
    await tab.shot(`${String(n).padStart(2, "0")}-roles-mobile`);
    // Clear it rather than override again: a kept override pins innerWidth, so later steps that resize the window never see it.
    await tab.cdp("Emulation.clearDeviceMetricsOverride", {});

    await tab.click("[data-roles-send]", "Chạy chuỗi 3 bước");
    const chain = await until("the chain", async () => (await rpc("runs.groups", { project: "payment" })).find((g) => g.kind === "roles"));
    expect(
      chain.parentTask === "PAY-ROLES" && chain.items.map((i) => `${i.step}:${i.profileId}`).join() === "code:claude-1,test:claude-2,review:null",
      `items: ${chain.items.map((i) => `${i.step}:${i.profileId}`).join()}`,
    );
    const [code, ...early] = await beat();
    expect(code?.role === "implement" && !early.length, `first step: ${code?.role}, then ${early.length}`);
    await finish(code, "succeeded");
    const [test] = await beat();
    expect(test?.role === "implement" && test.profileId === "claude-2" && test.instructions.includes("Viết test cho phần"), `tests step: ${test?.instructions}`);
    await finish(test, "failed");
    await tab.go(`runs?tab=batches&group=${chain.id}`);
    await tab.waitFor("the chain stopped", (id) => document.querySelector(`[data-group="${id}"] [data-roles-phase]`)?.getAttribute("data-roles-phase") === "stopped", chain.id);
    expect((await beat()).length === 0, "the review ran after a failed step");
    await tab.shot(`${String(n).padStart(2, "0")}-roles-stopped`);
    await tab.click(`[data-group="${chain.id}"] [data-map-resume]`);
    await tab.waitFor("going again", (id) => document.querySelector(`[data-group="${id}"] [data-roles-phase]`)?.getAttribute("data-roles-phase") === "going", chain.id);
    const [retry] = await beat();
    expect(retry?.profileId === "claude-2", `again: ${retry?.profileId}`);
    await finish(retry, "succeeded");
    const [review] = await beat();
    expect(review?.role === "review", `last step: ${review?.role}`);
    await finish(review, "succeeded");
    await tab.reload();
    await tab.go(`runs?tab=batches&group=${chain.id}`);
    await tab.waitFor("the chain done", (id) => document.querySelector(`[data-group="${id}"] [data-roles-phase]`)?.getAttribute("data-roles-phase") === "done", chain.id);
    await tab.shot(`${String(n).padStart(2, "0")}-roles-done`);
    await tab.go(`runs?run=R-roles-${review.id}`);
    await tab.waitFor("chain action on the completed run", () => !!document.querySelector("[data-run-roles-open]"));
    await tab.click("[data-run-roles-open]");
    await tab.waitFor("chain form from the run", () => !!document.querySelector('[data-roles-form="PAY-ROLES"]'));
    await tab.waitFor("run machine preselected", () => !!document.querySelector("#roles-machine")?.value);
    await tab.shot(`${String(n).padStart(2, "0")}-roles-from-run`);

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
    await tab.go("admin?tab=policy");
    await tab.waitFor("the hub's gate row", () => !!document.querySelector('[data-sdlc-row="hub"] [data-sdlc-gate="merge"]'));
    await setSelect(tab, '[data-sdlc-row="hub"] [data-sdlc-gate="merge"]', "ai");
    await tab.waitFor("edited ceiling ready to save", () => !document.querySelector('[data-sdlc-save="hub"]')?.disabled);
    // A toast from the preceding page can cover this horizontally scrolled table on phones.
    if (mobile) {
      await tab.eval(() => document.querySelector('[data-sdlc-save="hub"]').focus());
      await tab.key("Enter");
    } else await tab.click('[data-sdlc-save="hub"]');
    await until("the ceiling on the hub", async () => (await rpc("sdlc.get", {})).ceiling.merge === "ai");
    await tab.shot(`${String(n).padStart(2, "0")}-sdlc-ceiling`);

    tab = current = tabs.lan;
    await tab.reload();
    // 56b: project settings links to the dedicated process page; it has no duplicate gate table.
    await tab.go("settings?tab=policy");
    await tab.waitFor("process link", () => !!document.querySelector('a[href="#/pipeline"]'));
    expect(!(await tab.eval(() => !!document.querySelector('[data-sdlc-row="payment"]'))), "settings duplicated the process table");
    await tab.eval(() => document.querySelector('a[href="#/pipeline"]')?.click());
    await tab.waitFor("process page", () => location.hash.startsWith("#/pipeline"));
    await rpc("sdlc.setProject", { project: "payment", settings: { gates: { spec: "auto", merge: "ai" }, maxFixRounds: 2, maxParallel: null } });
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
    const profile = (id, kind) => ({ id, label: id, kind, enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1, planApproval: true, supportedModels: kind === "codex" ? ["gpt-6-luna"] : ["sonnet", "haiku"] });
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
    const run = { kind: "claude", model: "sonnet", effort: "low", tier: "strong", runId: "R-spec1", project: "payment", taskId: "SPEC-E2E", taskTitle: "Spec: hoàn tiền", role: "implement", profileId: "claude-1", createdAt: at };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "running" }] });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "succeeded", finishedAt: at }] });
    await machineRpc("specs.push", { project: "payment", features: [{ dir: "001-hoan-tien", branch: "ai/SPEC-E2E", commit: "abc1230", files: { spec: "# Hoàn tiền\n", plan: null, tasks: null } }] });

    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("tasks?task=SPEC-E2E");
    await tab.waitFor("the flow waiting at its spec gate", () => document.querySelector('[data-flow="SPEC-E2E"]')?.getAttribute("data-flow-state") === "gate");
    await tab.shot(`${String(n).padStart(2, "0")}-sdlc-flow-gate`);
    await step("pipeline", async () => {
      try {
        await tab.go("settings?tab=sdlc&project=payment");
        await tab.waitFor("legacy SDLC link redirected to pipeline", () => location.hash.startsWith("#/pipeline?") && !!document.querySelector('[data-pipeline-step="spec"]'));
        await tab.waitFor("Pipeline flow counts loaded", () => /\b1\b/.test(document.querySelector('[data-pipeline-count="spec"]')?.textContent ?? ""));
        const count = await tab.eval(() => document.querySelector('[data-pipeline-count="spec"]')?.textContent);
        expect(/\b1\b/.test(count ?? ""), `Spec does not show one active flow: ${count}`);
        const stepCount = await tab.eval(() => document.querySelectorAll("[data-pipeline-step]").length);
        expect(stepCount === 12, `pipeline stages: ${stepCount}`);
        if (mobile) {
          const layout = await tab.eval(() => ({ vertical: !!document.querySelector("[data-pipeline-mobile]"), overflow: document.documentElement.scrollWidth > innerWidth }));
          expect(layout.vertical && !layout.overflow, `pipeline mobile layout: ${JSON.stringify(layout)}`);
        }
        const gateCount = await tab.eval(() => document.querySelectorAll("[data-pipeline-gate]").length);
        expect(gateCount === 9, `pipeline gates: ${gateCount}`);
        if (!mobile) {
          await tab.waitFor("Pipeline policy and models loaded", () => [...document.querySelectorAll('[data-pipeline-preset]')].some((button) => !button.disabled));
          await tab.eval(() => document.fonts.ready.then(() => true));
          await tab.waitFor("measured Pipeline nodes and edges", () => {
            const nodes = [...document.querySelectorAll('[data-pipeline-graph] .react-flow__node')];
            return nodes.length === 21 && nodes.every((node) => getComputedStyle(node).visibility !== "hidden") && document.querySelectorAll('[data-pipeline-graph] .react-flow__edge-path').length === 20;
          });
          // Unchanged card sizes do not trigger ResizeObserver again: exercise real poll rebuilds before clicking a gate.
          const canvases = await tab.eval(() => new Promise((resolve, reject) => {
            const snapshot = () => ({
              nodes: [...document.querySelectorAll('[data-pipeline-graph] .react-flow__node')].map((node) => ({ id: node.dataset.id, width: node.offsetWidth, height: node.offsetHeight, visible: getComputedStyle(node).visibility !== "hidden" })),
              edges: [...document.querySelectorAll('[data-pipeline-graph] .react-flow__edge-path')].map((edge) => edge.getAttribute("d")),
            });
            const samples = [snapshot()];
            const original = window.fetch;
            const cleanup = () => { window.fetch = original; clearTimeout(timer); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("Pipeline did not complete two polls")); }, 40_000);
            window.fetch = async (...args) => {
              const response = await original(...args);
              if (typeof args[1]?.body === "string" && JSON.parse(args[1].body).method === "sdlc.get" && response.ok) {
                // Let useQuery consume the response and React Flow adopt the rebuilt nodes.
                setTimeout(() => {
                  samples.push(snapshot());
                  if (samples.length === 3) { cleanup(); resolve(samples); }
                }, 100);
              }
              return response;
            };
          }));
          for (const canvas of canvases) {
            expect(canvas.nodes.length === 21 && canvas.nodes.every((node) => node.visible && node.width > 0 && node.height > 0), `Pipeline nodes after poll: ${JSON.stringify(canvas.nodes)}`);
            expect(JSON.stringify(canvas.nodes) === JSON.stringify(canvases[0].nodes), "Pipeline dimensions changed after polling unchanged data");
            expect(canvas.edges.length === 20 && canvas.edges.every((d) => d && !/NaN|Infinity/.test(d)), `Pipeline edges after poll: ${JSON.stringify(canvas.edges)}`);
          }
        }
        await tab.shot(`${String(n).padStart(2, "0")}-pipeline-open`);
        await tab.click('[data-pipeline-gate="review"]');
        await tab.waitFor("Review gate editor", () => !!document.querySelector('[data-pipeline-editor] [data-pipeline-mode="ai"]'));
        if (mobile) {
          const targets = await tab.eval(() => [...document.querySelectorAll('[data-pipeline-editor] button')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
          expect(targets.every((r) => r.width >= 44 && r.height >= 44), `pipeline editor touch targets: ${JSON.stringify(targets)}`);
        }
        await tab.shot(`${String(n).padStart(2, "0")}-pipeline-editor`);
        await tab.click('[data-pipeline-editor] [data-pipeline-mode="ai"]');
        await tab.click('[data-pipeline-save]');
        await until("Review changed to AI check", async () => (await rpc("sdlc.get", {})).projects.payment?.effective.review === "ai");
        await tab.click('[data-pipeline-preset="cautious"]');
        await tab.waitFor("cautious preview", () => document.querySelectorAll('[data-pipeline-preview] [data-pipeline-change]').length === 9);
        await tab.shot(`${String(n).padStart(2, "0")}-pipeline-preview`);
        await tab.click('[data-pipeline-apply]');
        await until("cautious preset saved", async () => {
          const p = (await rpc("sdlc.get", {})).projects.payment;
          return p?.effective.spec === "human" && p?.effective.review === "human" && p?.effective.merge === "human";
        });
        await tab.shot(`${String(n).padStart(2, "0")}-pipeline-saved`);
        await tab.eval(() => { const picker = document.querySelector("[data-pipeline-feature]"); picker.value = "SPEC-E2E"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
        await tab.waitFor("feature highlighted at Spec", () => document.querySelector('[data-pipeline-step="spec"]')?.getAttribute("data-active") === "true");
        await tab.click('[data-pipeline-count="spec"]');
        await tab.waitFor("Spec count opens filtered features", () => location.hash.includes("pipelineStep=spec") && !!document.querySelector('[data-feature-column="spec"]'));
        await tab.go("pipeline?project=payment");
        await rpc("sdlc.setCeiling", { ceiling: { merge: "human" } });
        // Reload policy on the page: the ceiling is edited separately by the hub admin.
        await tab.go("tasks");
        await tab.go("pipeline?project=payment");
        await tab.click('[data-pipeline-gate="merge"]');
        await tab.waitFor("Merge cannot exceed the ceiling", () => document.querySelector('[data-pipeline-editor] [data-pipeline-mode="auto"]')?.disabled && document.querySelector('[data-pipeline-editor] [data-pipeline-mode="ai"]')?.disabled);
        await tab.shot(`${String(n).padStart(2, "0")}-pipeline-ceiling`);
        await tab.key("Escape");
        await tab.waitFor("merge editor closed", () => !document.querySelector("[data-pipeline-editor]"));
        await tab.click('[data-pipeline-preset="fast"]');
        await tab.waitFor("fast path preview", () => document.querySelectorAll("[data-pipeline-fast-kind]").length === 3);
        await tab.click('[data-pipeline-fast-kind="test"]');
        await tab.click('[data-pipeline-apply]');
        await until("only chosen fast kinds saved", async () => {
          const kinds = (await rpc("sdlc.get", {})).projects.payment?.fastLaneKinds ?? [];
          return kinds.length === 2 && kinds.includes("docs") && kinds.includes("small-fix") && !kinds.includes("test");
        });
        await tab.shot(`${String(n).padStart(2, "0")}-pipeline-fast`);
      } finally {
        // The flow below waits at a person's spec gate on the Task page: put both back even when a check above failed,
        // so a pipeline failure is reported once and not again as sdlc-flow's.
        await rpc("sdlc.setCeiling", { ceiling: {} });
        await rpc("sdlc.setProject", { project: "payment", settings: null });
        await tab.go("tasks?task=SPEC-E2E");
      }
      await tab.waitFor("the flow on Task after pipeline", () => !!document.querySelector('[data-flow="SPEC-E2E"]'));
    });
    await step("plan-approval", async () => {
      try {
        await tab.go("pipeline?project=payment");
        await tab.click('[data-pipeline-gate="dispatch"]');
        await tab.waitFor("planning settings next to dispatch", () => !!document.querySelector("[data-plan-settings]"));
        await tab.click('[data-plan-mode="medium-large"]');
        await tab.waitFor("only the selected plan mode is pressed", () => document.querySelectorAll('[data-plan-mode][aria-pressed="true"]').length === 1 && document.querySelector('[data-plan-mode="medium-large"]')?.getAttribute("aria-pressed") === "true");
        await tab.click('[data-pipeline-save]');
        await until("plan mode saved", async () => (await rpc("sdlc.get", {})).projects.payment?.planApproval?.mode === "medium-large");
        await lanRpc("tasks.create", { id: "PLAN-E2E", project: "payment", title: "Lập kế hoạch sửa hoàn tiền", kind: "feature", size: "m" });
        const first = await lanRpc("runs.dispatch", { project: "payment", taskId: "PLAN-E2E", machineId: "runner.lan-mbp@lan-e2e" });
        expect(first.plan?.phase === "plan", "first phase must only plan");
        const finishPlan = async (req, runId, planText) => {
          await machineRpc("runs.requestResult", { id: req.id, status: "accepted", runId });
          await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ runId, project: "payment", taskId: "PLAN-E2E", taskTitle: "Lập kế hoạch sửa hoàn tiền", role: "implement", status: "succeeded", profileId: "claude-1", createdAt: at, finishedAt: at, planText }] });
        };
        await finishPlan(first, "R-impl-plan1", "## Việc sẽ làm\nSửa hoàn tiền.\n## File\npayment.ts\n## Cách kiểm\nnpm test\n## Rủi ro\nKhông đổi dữ liệu.");
        await tab.reload(); await tab.go("today?section=inbox");
        await tab.click(`[data-inbox-key="plan:${first.plan.id}:1"]`);
        await tab.waitFor("plan ready in Today", () => !!document.querySelector("[data-plan-note]"));
        await tab.shot(`${String(n).padStart(2, "0")}-plan-today`);
        await tab.click("[data-plan-note]"); await tab.type("Thêm test hoàn tiền hai lần");
        await tab.click("button", "Sửa kế hoạch");
        const revised = await until("revised planning request", async () => (await beat()).runRequests.find((r) => r.taskId === "PLAN-E2E"));
        expect(revised.plan.phase === "plan" && revised.plan.note.includes("hai lần"), "revision notes reach planner");
        await finishPlan(revised, "R-impl-plan2", "Kế hoạch sửa: thêm test hoàn tiền hai lần, sửa payment.ts, chạy npm test. Rủi ro: giữ nguyên dữ liệu.");
        await tab.reload(); await tab.go("tasks?task=PLAN-E2E");
        await tab.click("[data-task-plan-tab]");
        await tab.waitFor("task Plan tab", () => !!document.querySelector("[data-plan-approve]"));
        if (mobile) {
          const check = await tab.eval(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, targets: [...document.querySelectorAll('[data-implementation-plan] button')].map((el) => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })) }));
          expect(!check.overflow && check.targets.every((r) => r.w >= 44 && r.h >= 44), `plan mobile targets: ${JSON.stringify(check)}`);
        }
        await tab.shot(`${String(n).padStart(2, "0")}-plan-task-tab`);
        await tab.click("[data-plan-approve]");
        const implementation = await until("implementation queued after approval", async () => (await beat()).runRequests.find((r) => r.taskId === "PLAN-E2E"));
        expect(implementation.plan.phase === "implement" && implementation.plan.text.includes("hai lần"), "approved plan accompanies implementation");
        await rpc("runs.cancelRequest", { id: implementation.id });
      } finally {
        await rpc("sdlc.setProject", { project: "payment", settings: null });
        await tab.go("tasks?task=SPEC-E2E");
      }
    });

    await step("models-in-pipeline", async () => {
      const original = await rpc("modelRouter.get", {});
      try {
        const qualityAt = new Date().toISOString();
        await rpc("tasks.create", { id: "QUALITY-E2E", project: "payment", title: "Quality cohort", kind: "feature", size: "m", risk: "normal" });
        await rpc("runs.push", { machine: "quality-fixture", runs: [{ runId: "R-quality", project: "payment", taskId: "QUALITY-E2E", taskTitle: "Quality cohort", role: "implement", profileId: "quality-profile", kind: "codex", model: "quality-model", tier: "standard", status: "failed", createdAt: qualityAt, startedAt: qualityAt, finishedAt: qualityAt }] });
        await tab.go("pipeline?project=payment");
        await tab.waitFor("model per step", () => document.querySelector('[data-pipeline-step="spec"]')?.textContent.includes("Sonnet") || document.querySelector('[data-pipeline-step="spec"]')?.textContent.includes("Opus"));
        await tab.click('[data-pipeline-gate="review"]');
        await tab.waitFor("model editor", () => !!document.querySelector('[data-step-model] [data-model-tier]'));
        await tab.eval(() => { const el = document.querySelector('[data-step-model] [data-model-tier]'); el.value = "light"; el.dispatchEvent(new Event("change", { bubbles: true })); });
        await tab.click('[data-step-model-save]');
        await until("review cell saved", async () => (await rpc("modelRouter.get", {})).projects.payment?.cells.review?.m === "light");
        await tab.shot(`${String(n).padStart(2, "0")}-models-step`);
        await tab.key("Escape");
        await tab.waitFor("step editor closed", () => !document.querySelector("[data-pipeline-editor]"));
        await tab.click('[data-model-tab="models"]');
        await tab.waitFor("task cell table", () => document.querySelectorAll('[data-model-row]').length === 11);
        await tab.waitFor("quality cohort visible", () => [...document.querySelectorAll('[data-quality-cohort]')].some((el) => el.textContent.includes("quality-model")));
        await tab.click('[data-model-quality] input');
        await tab.type("quality-model");
        await tab.waitFor("quality filter applied", () => document.querySelectorAll('[data-quality-cohort]').length === 1);
        expect(await tab.eval(() => document.querySelector('[data-quality-cohort]').textContent.includes("0/1")), "failed unfinished task stays in denominator");
        await tab.eval(() => document.querySelector('[data-model-quality]').scrollIntoView());
        await tab.shot(`${String(n).padStart(2, "0")}-model-quality`);
        await tab.waitFor("supported profile models alongside routing", () => !!document.querySelector("[data-supported-models] h2") && document.querySelector('[data-supported-profile="codex-1"]')?.textContent.includes("gpt-6-luna"));
        expect(await tab.eval(() => !document.querySelector('[data-hub-model-save]')), "project manager cannot edit hub tiers");
        await tab.click('[data-model-profile="economy"]');
        await tab.eval(() => { const el = document.querySelector('[data-model-row="docs"] [data-model-tier]'); el.value = "standard"; el.dispatchEvent(new Event("change", { bubbles: true })); });
        await tab.click('[data-model-save]');
        await until("profile and docs cell saved", async () => { const p = (await rpc("modelRouter.get", {})).projects.payment; return p?.profile === "economy" && p.cells.docs?.s === "standard"; });
        if (mobile) {
          const fit = await tab.eval(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, controls: [...document.querySelectorAll('[data-model-routing] select, [data-model-routing] button')].every((el) => el.getBoundingClientRect().height >= 44 && parseFloat(getComputedStyle(el).fontSize) >= 12) }));
          expect(!fit.overflow && fit.controls, `model table mobile: ${JSON.stringify(fit)}`);
        }
        await tab.shot(`${String(n).padStart(2, "0")}-models-table`);
        const adminTab = tabs.admin; current = adminTab;
        await adminTab.go("pipeline?project=payment");
        await adminTab.click('[data-model-tab="models"]');
        await adminTab.click('[data-model-routing] summary');
        await adminTab.waitFor("admin hub tier table", () => !!document.querySelector('[data-hub-model="light/claude"]'));
        expect(await adminTab.eval(() => {
          const light = document.querySelector('[data-hub-model="light/gemini"]');
          const standard = document.querySelector('[data-hub-model="standard/gemini"]');
          const strong = document.querySelector('[data-hub-model="strong/gemini"]');
          return light?.value === "flash" && standard?.value === "auto" && strong?.value === "pro" && light.closest("label").parentElement.querySelector("select").disabled;
        }), "Gemini tier aliases are editable with CLI-default effort only");
        await adminTab.eval(() => {
          const input = document.querySelector('[data-hub-model="light/claude"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "haiku");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const opencode = document.querySelector('[data-hub-model="light/opencode"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(opencode, "test/model");
          opencode.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await adminTab.waitFor("hub model draft", () => document.querySelector('[data-hub-model="light/claude"]')?.value === "haiku");
        await adminTab.click('[data-hub-model-save]');
        await until("hub model saved", async () => (await rpc("modelRouter.get", {})).tiers.light.claude?.model === "haiku");
        await until("qualified OpenCode model saved", async () => (await rpc("modelRouter.get", {})).tiers.light.opencode?.model === "test/model");
        await adminTab.shot(`${String(n).padStart(2, "0")}-models-hub`);
        current = tab;
        await tab.go("tasks?task=SPEC-E2E");
        await tab.waitFor("task model reason", () => document.querySelector('[data-task-model]')?.textContent.includes("spec/"));
        await tab.shot(`${String(n).padStart(2, "0")}-models-task`);
        await tab.go("runs?run=R-spec1");
        await tab.waitFor("run model with original selection", () => [...document.querySelectorAll('[data-run-model="sonnet"]')].some((el) => el.textContent.includes("spec/m") && el.title.includes("balanced")));
        await tab.shot(`${String(n).padStart(2, "0")}-models-run`);
      } finally {
        await rpc("modelRouter.set", { project: null, tiers: original.tiers, cells: original.cells });
        await rpc("modelRouter.set", { project: "payment", setting: original.projects.payment ?? { enabled: true, profile: "balanced", cells: {} } });
        current = tab;
        await tab.go("tasks?task=SPEC-E2E");
        await tab.waitFor("flow after model settings", () => !!document.querySelector('[data-flow="SPEC-E2E"]'));
      }
    });
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

  await step("diff-review-hunks", async () => {
    const tab = (current = tabs.admin);
    await rpc("tasks.create", { id: "PAY-57C", project: "payment", title: "Review grouped diff", kind: "small-fix", size: "s" });
    const machineRpc = async (method, input) => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" }, body: JSON.stringify({ method, input }) });
      const result = await response.json();
      if (result.error) throw new Error(`${method}: ${result.error.message}`);
      return result.result;
    };
    const now = new Date().toISOString();
    const patch = "diff --git a/db.ts b/db.ts\n@@ -1 +1 @@\n-old\n+ALTER TABLE users ADD COLUMN role TEXT;\n@@ -8 +8 @@\n-safe\n+DELETE FROM users;\ndiff --git a/ui.ts b/ui.ts\n@@ -1 +1 @@\n-before\n+after\n";
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ runId: "R-e2e57c", project: "payment", taskId: "PAY-57C", taskTitle: "Review grouped diff", role: "implement", status: "succeeded", profileId: "claude-1", createdAt: now, finishedAt: now, patch,
      diffReview: { groups: [{ title: "Đổi quyền người dùng", explanation: "Thêm vai và cập nhật giao diện.", files: ["db.ts", "ui.ts"] }], risks: [{ path: "db.ts", hunk: 1, level: "high", kind: "deletion", explanation: "Xoá dữ liệu người dùng." }] } }] });
    await tab.go("runs?run=R-e2e57c");
    await tab.waitFor("diff groups", () => document.body.innerText.includes("Thêm vai và cập nhật giao diện."));
    await tab.click('[data-run-tab="diff"]');
    await tab.click('nav[aria-label="Cờ rủi ro"] a', "Cao · Xoá dữ liệu · db.ts");
    // The desktop list consumes ?run= once the run is selected, so there the route is plain #/runs; the phone keeps it as its detail route.
    expect(await tab.eval(() => document.activeElement?.textContent.includes("@@ -8 +8 @@") && (location.hash === "#/runs" || location.hash.includes("R-e2e57c")) && document.body.innerText.includes("R-e2e57c")), "risk flag must focus the exact hunk without leaving the run");
    await tab.click("section:focus button", "Yêu cầu sửa");
    await tab.waitFor("hunk note", () => !!document.querySelector("textarea"));
    await tab.click("textarea");
    await tab.type("Giữ dữ liệu người dùng.");
    if (mobile) {
      const layout = await tab.eval(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, targets: [...document.querySelectorAll('nav[aria-label="Cờ rủi ro"] a')].map(e => e.getBoundingClientRect().height), font: getComputedStyle(document.querySelector("textarea")).fontSize }));
      expect(!layout.overflow && layout.targets.every(h => h >= 44) && Number.parseFloat(layout.font) >= 16, `diff mobile layout: ${JSON.stringify(layout)}`);
    }
    await tab.shot(`${String(n).padStart(2, "0")}-diff-review-hunks`);
    await tab.click("button", "Xếp lượt sửa (1 ghi chú)");
    await tab.waitFor("fix sent", () => document.body.innerText.includes("Đã xếp lượt sửa cùng task"));
    const requests = await rpc("runs.requests", { project: "payment" });
    const fix = requests.find(r => r.taskId === "PAY-57C" && r.role === "implement");
    expect(fix?.instructions.includes("db.ts\n@@ -8 +8 @@\nGiữ dữ liệu người dùng.") && fix.reviewAfter, "fix instructions must keep the exact file and hunk");
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
    // The previous step left the Runs page mounted with a list from before this run was pushed; leave it so the next visit loads fresh.
    await tab.go("tasks");
    await tab.go("batches");
    await tab.waitFor("old batch route in runs", () => location.hash === "#/runs");
    // The previous step left its run selected on the desktop list too, so pick this one by its link everywhere.
    await tab.go("runs?run=R-e2ereview");
    await tab.waitFor("run needs a person", () => document.querySelector('[data-run-review]')?.textContent.includes("ĐÃ LÀM") && document.body.innerText.includes("Chờ người"));
    await tab.waitFor("empty artifacts hidden", () => !document.querySelector('[data-run-review] [data-artifacts]'));
    expect(await tab.eval(() => ![...document.querySelectorAll('[data-run-review] h3')].some(h => ["Log", "Thay đổi / MR"].includes(h.textContent))), "repeated headings hidden");
    await tab.click('[data-run-tab="log"]');
    await tab.waitFor("log tab content", () => document.querySelector('[role="tabpanel"]')?.textContent.includes("Bàn giao"));
    expect(await tab.eval(() => !document.querySelector('[role="tabpanel"]')?.textContent.includes("ĐÃ LÀM")), "summary hidden in log tab");
    await tab.click('[data-run-tab="diff"]');
    await tab.waitFor("diff tab content", () => document.querySelector('[role="tabpanel"]')?.textContent.includes("pay.ts"));
    await tab.click('[data-run-tab="summary"]');
    await tab.shot(`${String(n).padStart(2, "0")}-runs-review-detail`);
    if (mobile) await tab.go("runs");
    await tab.click("[data-run-filters] summary");
    await tab.select('select[aria-label="Lọc theo máy"]', "runner.lan-mbp@lan-e2e");
    await tab.select('select[aria-label="Lọc theo task"]', "PAY-1");
    await tab.click("[data-run-filters] summary");
    expect(await tab.eval(() => !document.querySelector('[data-run-filters]').open && document.querySelector('[data-run-filters] summary').textContent.includes('(2)')), "active filter count survives collapse");
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
    const tab = (current = tabs.lan);
    await tab.go("settings?tab=agent");
    await tab.waitFor("agent summary", () => !!document.querySelector("[data-policy-summary]"));
    await tab.shot(`${String(n).padStart(2, "0")}-settings-agent-summary`);
    await tab.click("[data-compact-agent-policy] button", "Sửa");
    await tab.waitFor("agent editor", () => !!document.querySelector("[data-policy-editor]"));
    await tab.waitFor("model chips from the router", () => { const sheet = document.querySelector('[data-policy-editor]'); const box = sheet?.getBoundingClientRect(); return box?.left >= 0 && box?.right <= innerWidth && sheet?.textContent.includes("sonnet"); });
    if (mobile) { const short = await tab.eval(() => [...document.querySelectorAll('[data-policy-editor] button')].filter((b) => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height < 44).map((b) => `${b.textContent.trim() || b.getAttribute('aria-label')}: ${Math.round(b.getBoundingClientRect().height)}px`)); expect(short.length === 0, `agent editor touch targets below 44px: ${short.join(", ")}`); }
    await tab.shot(`${String(n).padStart(2, "0")}-settings-agent-editor`);
    await tab.click('[data-policy-editor] button[aria-pressed]', "Chỉ đọc");
    await tab.click('[data-policy-editor] button', "Lưu");
    await until("payment at read", async () => (await rpc("agentPolicy.get", {})).effective?.payment?.autonomy === "read");
    await tab.waitFor("effective summary", () => document.querySelector("[data-policy-summary]")?.textContent.includes("Chỉ đọc"));
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
    await tab.click("button", "Sửa");
    await tab.select("#tools-project", "payment");
    await tab.select("#tool-codegraph-state", "on");
    await until("codegraph on for payment", async () => (await rpc("tools.list", { project: "payment" })).find((t) => t.id === "codegraph")?.projects[0]?.effective === true);
    await tab.waitFor("the card says it is on", () => !!document.querySelector('[data-tool="codegraph"] [data-tool-effective="on"]'));

    tab = current = tabs.admin;
    await tab.go("admin?tab=tools");
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
    await tab.waitFor("the tool card", () => document.body.innerText.includes("Đặt tool Spec Kit cho service: bật, bắt buộc") && document.body.innerText.includes("Hiện tại: theo mặc định của tool"));
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

  // Roadmap 62c: a throwaway runner supplies suggestions and replies, never a real agent.
  await step("chat-shortcuts", async () => {
    const machineRpc = async (method, input) => {
      const res = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.shortcuts" }, body: JSON.stringify({ method, input }) });
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const at = new Date().toISOString();
    const liveRun = { runId: "R-shortcuts-live", project: "payment", taskId: "SHORT-LIVE", taskTitle: "Đang chạy", role: "implement", status: "running", profileId: "claude-1", since: at };
    const beat = () => machineRpc("machines.heartbeat", { machine: "shortcuts", instance: "e2e0062c", projects: ["payment"], acceptsRuns: true, profiles: [{ id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 }], runs: [liveRun] });
    await beat();
    const machineId = (await rpc("machines.list")).find(m => m.machine === "shortcuts").id;
    await machineRpc("runs.push", { machine: "shortcuts", runs: [{ ...liveRun, createdAt: at }, { ...liveRun, runId: "R-shortcuts-failed", status: "failed", createdAt: at, finishedAt: at }] });
    for (const status of ["done", "review", "blocked"]) {
      await rpc("tasks.create", { id: `SHORT-${status}`, project: "payment", title: `Shortcut ${status}` });
      await rpc("tasks.update", { id: `SHORT-${status}`, project: "payment", status });
    }
    const tab = (current = tabs.lan);
    await tab.go("chat");
    await tab.click("[data-chat-new]");
    await tab.select("#chat-project", "payment");
    await tab.select("#chat-machine", machineId);
    const draft = () => tab.eval(() => document.querySelector('[data-chat-commands] textarea').value);
    const replace = async text => { await tab.click('[data-chat-commands] textarea'); await tab.eval(() => document.querySelector("[data-chat-commands] textarea").select()); await tab.key("Backspace"); if (text) await tab.type(text); };
    const before = (await rpc("chat.threads", { project: "payment" }, people.lan.token)).length;
    await replace("/");
    await tab.waitFor("six command suggestions with localized descriptions and examples", () => document.querySelectorAll('[data-chat-command-menu] [role="option"]').length === 6 && document.querySelector('[data-chat-command-menu]').textContent.includes("Kế hoạch"));
    await tab.shot(`${String(n).padStart(2, "0")}-chat-shortcuts-menu`);
    if (mobile) {
      const layout = await tab.eval(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, chips: document.querySelector('[data-chat-chips]').scrollWidth > document.querySelector('[data-chat-chips]').clientWidth, targets: [...document.querySelectorAll('[data-chat-chips] button, [data-chat-command-menu] button')].map(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })), font: parseFloat(getComputedStyle(document.querySelector('[data-chat-commands] textarea')).fontSize) }));
      expect(!layout.overflow && layout.chips && layout.font >= 16 && layout.targets.every(r => r.w >= 44 && r.h >= 44), `shortcut mobile layout: ${JSON.stringify(layout)}`);
    }
    await replace("/re");
    await tab.waitFor("three filtered commands", () => document.querySelectorAll('[data-chat-command-menu] [role="option"]').length === 3);
    await tab.key("ArrowDown"); await tab.key("Enter");
    expect((await draft()).startsWith("/release\n"), "Enter fills release without sending");
    expect((await rpc("chat.threads", { project: "payment" }, people.lan.token)).length === before, "selection did not send a message");
    await replace("/"); await tab.key("Escape");
    expect(await tab.eval(() => !document.querySelector('[data-chat-command-menu]')), "Escape dismisses suggestions");
    await replace("Việc đã soạn"); await tab.click('[data-chat-command="assign"]');
    await tab.waitFor("service suggestion for assign", () => !!document.querySelector('[data-chat-suggestion="payment"]'));
    await tab.key("Tab");
    expect((await draft()).startsWith("/assign payment\n") && (await draft()).includes("Việc đã soạn"), "Tab fills service and preserves draft");
    await replace("/research "); await tab.key("Enter");
    expect((await draft()) === "/research payment", "research suggests only the thread's service");
    await replace("/cancel ");
    await tab.waitFor("a running run suggestion", () => [...document.querySelectorAll('[data-chat-command-menu] button')].some(el => el.textContent.includes("R-shortcuts-live")));
    await tab.key("Enter");
    expect((await draft()) === `/cancel ${machineId}/R-shortcuts-live`, "cancel includes machine identity");
    await replace("/retry ");
    await tab.waitFor("a failed run suggestion", () => [...document.querySelectorAll('[data-chat-command-menu] button')].some(el => el.textContent.includes("R-shortcuts-failed")));
    await tab.key("Tab");
    expect((await draft()) === `/retry ${machineId}/R-shortcuts-failed`, "retry fills a failed run");
    expect(!(await rpc("runs.list", { project: "payment" })).find(r => r.runId === "R-shortcuts-live").cancelRequestedAt, "draft commands never cancel a run");
    await replace(""); await tab.click('[data-chat-command="status"]');
    await tab.click('button[type="submit"]', "Bắt đầu");
    const sent = await until("a status thread from the UI", async () => (await rpc("chat.threads", { project: "payment" }, people.lan.token)).find(th => th.title.startsWith("/status")));
    const reply = (await rpc("chat.get", { threadId: sent.id }, people.lan.token)).messages.at(-1);
    await machineRpc("chat.progress", { replyId: reply.id, text: "Kiểm tra tình trạng." });
    await machineRpc("chat.finish", { replyId: reply.id, status: "done", text: "Cần xử lý task chờ review." });
    await tab.waitFor("status counters and links", () => document.querySelector('[data-chat-status="payment"] [data-chat-status-count="done"]') && document.querySelector('[data-chat-status="payment"] a[href="#/pipeline?project=payment"]'));
    const counts = await tab.eval(() => Object.fromEntries([...document.querySelectorAll('[data-chat-status-count]')].map(el => [el.dataset.chatStatusCount, Number(el.textContent)])));
    const tasks = await rpc("tasks.list", { project: "payment" });
    for (const key of ["done", "review", "blocked"]) expect(counts[key] === tasks.filter(task => task.status === key).length, `status ${key} uses hub tasks`);
    expect(counts.running === 1, "status counts a live run");
    await tab.waitFor("finished status reply", () => document.querySelector("[data-chat-thread]").textContent.includes("Cần xử lý task chờ review."));
    await tab.eval(() => document.querySelector("[data-chat-status]").scrollIntoView({ block: "start" }));
    await tab.shot(`${String(n).padStart(2, "0")}-chat-shortcuts-status`);
    await replace("/can"); await tab.key("Enter");
    expect((await draft()).startsWith("/cancel "), "existing-thread composer has shortcuts too");
    await tab.eval(() => localStorage.setItem("xdev-hive.locale", "en"));
    await tab.reload();
    await replace("/");
    await tab.waitFor("English descriptions with English command names", () => document.querySelector('[data-chat-command-menu]')?.textContent.includes("Describe work for the leader"));
    await tab.eval(() => localStorage.setItem("xdev-hive.locale", "vi"));
    await tab.reload();
  });

  // 64b: realistic streaming, draft recovery and reuse with a throwaway runner and account.
  await step("chat-design", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.chat-design" }, body: JSON.stringify({ method, input }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const profile = { id: "claude-design", label: "Claude", kind: "claude", enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 };
    await machineRpc("machines.heartbeat", { machine: "chat-design", instance: "cd0064b1", projects: ["payment"], acceptsRuns: true, profiles: [profile] });
    const machineId = (await rpc("machines.list")).find(m => m.machine === "chat-design").id;
    const sent = await rpc("chat.send", { project: "payment", machineId, text: "Thiết kế Chat 64b" }, people.lan.token);
    const longReply = Array.from({ length: 35 }, (_, i) => `Đoạn ${i}: Nội dung đang đọc, kế hoạch và kiểm tra.\n\n`).join("");
    await machineRpc("chat.progress", { replyId: sent.reply.id, text: longReply, activity: "Đọc thiết kế Chat", steps: "▶ Đọc thiết kế\n✓ Đã đọc" });
    const tab = current = await Tab.open("chat-design-lan");
    tab.win.showInactive();
    await tab.click("#username"); await tab.type("lan");
    await tab.click("#password"); await tab.type(people.lan.password); await tab.key("Enter");
    await tab.waitFor("signed in", () => !document.querySelector("#username"));
    await tab.go(`chat?thread=${sent.thread.id}`);
    await tab.waitFor("streaming transcript", () => document.querySelector('[data-chat-thread]')?.textContent.includes("Đọc thiết kế Chat"));
    expect(await tab.eval(() => !document.querySelector('[data-chat-steps]').open), "agent log starts collapsed while running");
    expect(await tab.eval(() => !document.querySelector('[data-chat-thread] ol[aria-live]')), "streamed Markdown is not a live region");
    await tab.click('[data-chat-steps] summary');
    await machineRpc("chat.progress", { replyId: sent.reply.id, text: longReply, activity: "Kiểm tra layout", steps: "▶ Đọc thiết kế\n✓ Đã đọc\n▶ Kiểm tra layout" });
    await tab.waitFor("poll keeps opened log", () => document.querySelector('[data-chat-steps]').open && document.querySelector('[data-chat-steps]').textContent.includes("Kiểm tra layout"));
    await tab.click('[data-chat-steps] summary');
    const replace = async text => {
      await tab.click('[data-chat-commands] textarea');
      await tab.eval(() => document.querySelector('[data-chat-commands] textarea').select());
      await tab.key("Backspace"); if (text) await tab.type(text);
    };
    await replace("Bản nháp giữ khi busy");
    expect(await tab.eval(() => document.querySelector('[data-chat-thread] button[type="submit"]').disabled), "busy disables send while input stays enabled");
    await tab.eval(() => { const list = document.querySelector('[data-chat-transcript]'); list.scrollTop = 0; list.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await machineRpc("chat.progress", { replyId: sent.reply.id, text: longReply + "Phần mới ở cuối.", activity: "Đang xác minh", steps: "▶ Đọc thiết kế\n✓ Đã đọc\n▶ Kiểm tra layout\n✓ Hoàn tất" });
    await tab.waitFor("new content without pulling the reader down", () => !!document.querySelector('[data-chat-new-content]') && document.querySelector('[data-chat-transcript]').scrollTop < 10);
    await tab.click('[data-chat-new-content]');
    await machineRpc("chat.finish", { replyId: sent.reply.id, status: "done", text: longReply + "Hoàn tất.", steps: "▶ Đọc thiết kế\n✓ Đã đọc\n▶ Kiểm tra layout\n✓ Hoàn tất", tokens: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 25 } });
    await tab.waitFor("terminal reply keeps the draft", () => !document.querySelector('[data-chat-thread] button[type="submit"]').disabled && document.querySelector('[data-chat-commands] textarea').value === "Bản nháp giữ khi busy");
    expect((await rpc("chat.get", { threadId: sent.thread.id }, people.lan.token)).messages.filter(m => m.role === 'user').length === 1, "busy ending does not auto-send");
    expect(await tab.eval(() => !document.querySelector('[data-chat-steps]').open), "closed log does not reopen at completion");
    expect(await tab.eval(() => document.querySelector('[data-chat-session]').textContent.includes('175') && document.querySelector('[data-chat-session]').textContent.includes('Chưa có dữ liệu')), "session distinguishes measured tokens from unknown quota");
    await tab.key("f", process.platform === "darwin" ? "Meta" : "Control", "Shift");
    await tab.waitFor("search shortcut focuses its input", () => document.activeElement === document.querySelector('[data-chat-search] input'));
    await tab.type("kế hoạch");
    await tab.waitFor("safe search highlight", () => document.querySelector('[data-chat-search-excerpt] mark')?.textContent === "kế hoạch");
    await tab.key("Escape");
    await tab.click('[data-chat-message] button', "Dùng lại tin nhắn");
    await tab.waitFor("reuse offers a choice", () => !!document.querySelector('[data-chat-reuse]'));
    await tab.click('[data-chat-reuse] button', "Giữ bản nháp hiện tại");
    expect(await tab.eval(() => document.querySelector('[data-chat-commands] textarea').value === "Bản nháp giữ khi busy"), "reuse does not silently replace draft");
    await replace("Tin nhắn IME");
    await tab.eval(() => document.querySelector('[data-chat-commands] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true })));
    expect((await rpc("chat.get", { threadId: sent.thread.id }, people.lan.token)).messages.filter(m => m.role === 'user').length === 1, "IME Enter never sends");
    if (mobile) {
      await tab.key("Enter");
      expect((await rpc("chat.get", { threadId: sent.thread.id }, people.lan.token)).messages.filter(m => m.role === 'user').length === 1, "phone Enter adds a line");
    }
    // Attach a real file, send it, then reuse after failure. The API requires a new upload id.
    await tab.eval(() => {
      const input = document.querySelector('input[type="file"]');
      const files = new DataTransfer(); files.items.add(new File(["64b attachment"], "reuse.txt", { type: "text/plain" }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await tab.waitFor("attachment uploaded", () => document.querySelector('[data-chat-thread]').textContent.includes('reuse.txt') && !document.querySelector('[data-chat-thread]').textContent.includes('Đang tải lên'));
    await tab.click('[data-chat-thread] button[type="submit"]', "Gửi");
    let thread = await until("message with file", async () => {
      const got = await rpc('chat.get', { threadId: sent.thread.id }, people.lan.token);
      return got.messages.filter(m => m.role === 'user').length === 2 && got;
    });
    const fileId = thread.messages.findLast(m => m.role === 'user').files[0].id;
    await machineRpc('chat.finish', { replyId: thread.messages.at(-1).id, status: 'failed', text: 'Có lỗi tạm thời' });
    await tab.waitFor("retry draft action", () => document.querySelector('[data-chat-thread]').textContent.includes('Thử lại trong bản nháp'));
    await tab.click('[data-chat-thread] button', 'Thử lại trong bản nháp');
    // Replacing a full draft must free its attachment slots before restoring the sent file.
    await replace("Bản nháp bốn tệp");
    await tab.eval(() => {
      const input = document.querySelector('input[type="file"]');
      const files = new DataTransfer();
      for (let i = 0; i < 4; i++) files.items.add(new File(["draft"], `draft-${i}.txt`, { type: "text/plain" }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await tab.waitFor("full draft uploaded", () => document.querySelector('[data-chat-thread]').textContent.includes('draft-3.txt') && !document.querySelector('[data-chat-thread] button[type="submit"]').disabled);
    await tab.click('[data-chat-reuse] button', 'Thay bản nháp');
    await tab.waitFor("file reuploaded for retry", () => document.querySelector('[data-chat-commands] textarea').value.startsWith('Tin nhắn IME') && !document.querySelector('[data-chat-thread] button[type="submit"]').disabled);
    await tab.click('[data-chat-thread] button[type="submit"]', 'Gửi');
    thread = await until("retry has a new file id", async () => {
      const got = await rpc('chat.get', { threadId: sent.thread.id }, people.lan.token);
      const users = got.messages.filter(m => m.role === 'user');
      return users.length === 3 && users.at(-1).files.length === 1 && got;
    });
    expect(thread.messages.findLast(m => m.role === 'user').files[0].id !== fileId, 'retry preserved file by creating an authorized new upload');
    await machineRpc('chat.finish', { replyId: thread.messages.at(-1).id, status: 'done', text: 'Đã thử lại cùng tệp.' });
    await tab.waitFor('retry finished', () => document.querySelector('[data-chat-thread]').textContent.includes('Đã thử lại cùng tệp.'));
    const metrics = await tab.eval(() => {
      const input = document.querySelector('[data-chat-commands] textarea').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, inputBottom: input.bottom, height: innerHeight, font: parseFloat(getComputedStyle(document.querySelector('[data-chat-commands] textarea')).fontSize) };
    });
    expect(!metrics.overflow && metrics.inputBottom <= metrics.height, `composer stays in viewport: ${JSON.stringify(metrics)}`);
    if (mobile) {
      expect(metrics.font >= 16, 'phone composer text >=16px');
      await tab.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
      const small = await tab.eval(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, targets: [...document.querySelectorAll('[data-leader-chat] button')].filter(el => el.getBoundingClientRect().width).filter(el => el.getBoundingClientRect().width < 44 || el.getBoundingClientRect().height < 44).map(el => el.textContent) }));
      expect(!small.overflow && !small.targets.length, `320px layout and touch targets: ${JSON.stringify(small)}`);
      await tab.shot(`${String(n).padStart(2, '0')}-chat-design-320`);
      await tab.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    } else {
      tab.win.webContents.setZoomFactor(2);
      await sleep(150);
      expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), '200% zoom does not overflow the page');
      tab.win.webContents.setZoomFactor(1);
    }
    await tab.shot(`${String(n).padStart(2, '0')}-chat-design`);
    await tab.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'dark' }] });
    await tab.waitFor("Chat dark theme", () => document.documentElement.dataset.theme === "dark");
    await tab.shot(`${String(n).padStart(2, '0')}-chat-design-dark`);
    await tab.cdp('Emulation.setEmulatedMedia', { features: [] });
    await tab.go('today');
    expect(await tab.eval(() => !document.querySelector('[data-leader-panel]')), 'closed Chat leaves Today approval area clear');
    await tab.click('[data-ask-leader]'); await sleep(450);
    await tab.waitFor('modal panel', () => !!document.querySelector('[data-leader-panel][role="dialog"]'));
    expect(await tab.eval(() => document.querySelector('[data-leader-panel]').contains(document.activeElement)), 'focus enters the requested modal');
    await tab.click('[data-chat-panel-close]');
    await tab.waitFor('Today clear and focus restored', () => !document.querySelector('[data-leader-panel]') && document.activeElement?.hasAttribute('data-ask-leader'));
    const reader = current = await Tab.open("chat-design-member");
    await reader.click("#username"); await reader.type("minh");
    await reader.click("#password"); await reader.type(people.minh.password); await reader.key("Enter");
    await reader.waitFor("member signed in", () => !document.querySelector("#username"));
    await reader.go(`chat?thread=${sent.thread.id}`);
    // Chat is a menu page only with chatUse (webPages): a view-only member who opens the link lands elsewhere, never on a composer.
    await reader.waitFor("member lands outside Chat", () => !!document.querySelector("nav, aside, [data-shell-title]") && !document.querySelector('[data-chat-thread]'));
    expect(await reader.eval(() => !document.querySelector('[data-chat-thread] textarea') && !document.querySelector('[data-chat-new]') && !document.querySelector('a[href$="/chat"]')), "member without chatUse has no Chat page, composer or new-chat control");
  });

  // Roadmap 62d: the shell and Chat share drafts and threads; RPC stands in for the leader.
  await step("chat-everywhere", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.chat-everywhere" }, body: JSON.stringify({ method, input }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const profile = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 };
    await machineRpc("machines.heartbeat", { machine: "chat-everywhere", instance: "ce000001", version: "0.143.0", projects: ["payment"], acceptsRuns: true, profiles: [profile] });
    const machineId = (await rpc("machines.list")).find((m) => m.machine === "chat-everywhere").id;
    const tab = current = await Tab.open("chat-everywhere-lan");
    // Hidden Electron windows freeze the sheet's entrance animation off-screen.
    tab.win.showInactive();
    await tab.click("#username");
    await tab.type("lan");
    await tab.click("#password");
    await tab.type(people.lan.password);
    await tab.key("Enter");
    if (mobile) {
      // The phone menu is a Sheet, mounted only while open: the account line and the service picker are inside it.
      await tab.waitFor("Lan signed in", () => !document.querySelector("#username") && !!document.querySelector('button[aria-label="Ẩn hoặc hiện thanh bên"]'));
      await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    }
    await tab.waitFor("Lan signed in", () => !document.querySelector("#username") && document.body.innerText.includes("@lan"));
    await tab.go("today?section=inbox");
    await openPicker();
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("payment");
    await tab.key("Enter");
    await tab.key("Escape");
    if (mobile) await tab.key("Escape");
    await tab.click("[data-ask-leader]");
    await sleep(450);
    await tab.waitFor("new chat in payment scope", () => document.querySelector('[data-leader-panel] #chat-project')?.value === "payment");
    expect(await tab.eval(() => ![...document.querySelector('[data-leader-panel] #chat-project').options].some((o) => o.value === "*")), "service lead must not see whole-hub chat");
    expect(await tab.eval(() => !document.querySelector('[data-chat-setup]').open), "new chat keeps configuration folded");
    if (mobile) expect(await tab.eval(() => {
      const r = document.querySelector('[data-leader-panel] textarea').getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }), "phone new-chat composer is visible before opening advanced choices");
    await tab.select('[data-leader-panel] #chat-new-model', 'opus');
    await tab.select('[data-leader-panel] #chat-new-effort', 'high');
    await tab.click('[data-leader-panel] textarea');
    await tab.type("Bản nháp từ mọi trang");
    // A real upload also survives moving between the two surfaces.
    await tab.eval(() => {
      const input = document.querySelector('[data-leader-panel] input[type="file"]');
      if (!input) throw new Error("no file input; panel=" + !!document.querySelector("[data-leader-panel]"));
      const data = new DataTransfer();
      data.items.add(new File(["draft attachment"], "draft.txt", { type: "text/plain" }));
      input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await tab.waitFor("uploaded attachment", () => document.querySelector('[data-leader-panel]')?.textContent.includes("draft.txt") && !document.querySelector('[data-leader-panel]')?.textContent.includes("Đang tải lên"));
    await tab.click("[data-chat-panel-close]");
    await tab.waitFor("focus restored to shell opener", () => document.activeElement?.hasAttribute("data-ask-leader"));
    await tab.key("l", "Control", "Shift");
    await sleep(450);
    await tab.waitFor("draft on reopen", () => document.querySelector('[data-leader-panel] textarea')?.value === "Bản nháp từ mọi trang");
    await tab.click("[data-chat-open-page]");
    await tab.waitFor("draft on Chat page", () => !document.querySelector('[data-leader-panel]') && document.querySelector('main textarea')?.value === "Bản nháp từ mọi trang" && document.querySelector('main')?.textContent.includes("draft.txt") && document.querySelector("#chat-new-model")?.value === "opus" && document.querySelector("#chat-new-effort")?.value === "high");
    await tab.click("[data-ask-leader]");
    await sleep(450);
    await tab.select('[data-leader-panel] #chat-machine', machineId);
    await tab.click('[data-leader-panel] button[type="submit"]', "Bắt đầu");
    const threadId = await tab.waitFor("started thread", () => Number(document.querySelector('[data-leader-panel] [data-chat-thread]')?.getAttribute("data-chat-thread")));
    let thread = await rpc("chat.get", { threadId }, people.lan.token);
    expect(thread.messages[0].text === "Bản nháp từ mọi trang" && thread.messages[0].files.length === 1, "the shared draft and attachment were sent once");
    await machineRpc("chat.finish", { replyId: thread.messages.at(-1).id, status: "done", text: "Đã nhận yêu cầu." });
    await tab.waitFor("completed reply", () => document.querySelector('[data-leader-panel]')?.textContent.includes("Đã nhận yêu cầu."));
    await tab.click('[data-leader-panel] textarea');
    await tab.type("Bản nháp trả lời");
    await tab.click("[data-chat-open-page]");
    await tab.waitFor("same thread and reply draft on Chat", (id) => document.querySelector('[data-chat-thread]')?.getAttribute('data-chat-thread') === String(id) && document.querySelector('main textarea')?.value === "Bản nháp trả lời", threadId);
    await tab.go("tasks?task=PAY-1");
    await tab.waitFor("task details", () => document.querySelector('[role="dialog"]')?.textContent.includes("PAY-1"));
    await tab.key("l", "Control", "Shift");
    await sleep(450);
    await tab.waitFor("task context", () => document.querySelector('[data-chat-context] a')?.getAttribute('href') === "#/tasks?task=PAY-1");
    await tab.eval(() => {
      const input = document.querySelector('[data-leader-panel] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'x'.repeat(8000));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tab.waitFor("context included in message limit", () => document.querySelector('[data-leader-panel] button[type="submit"]')?.disabled && document.querySelector('[data-leader-panel]')?.textContent.includes("vượt quá 8.000 ký tự"));
    await tab.eval(() => {
      const input = document.querySelector('[data-leader-panel] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Bản nháp trả lời');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tab.click('[data-leader-panel] button[type="submit"]', "Gửi");
    thread = await until("context in the sent message", async () => {
      const th = await rpc("chat.get", { threadId }, people.lan.token);
      return th.messages.find((m) => m.role === "user" && m.text.includes("[PAY-1](#/tasks?task=PAY-1)")) && th;
    });
    expect(thread.messages.filter((m) => m.role === "user").at(-1).text.endsWith("Bản nháp trả lời"), "task context accompanies the existing draft");
    await machineRpc("chat.finish", { replyId: thread.messages.at(-1).id, status: "done", text: "Đã đọc task." });
    await tab.shot(`${String(n).padStart(2, "0")}-chat-everywhere-task`);
    if (mobile) {
      const metrics = await tab.eval(() => {
        const panel = document.querySelector('[data-leader-panel]').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('[data-leader-panel] button')].filter((b) => b.getBoundingClientRect().width);
        return { width: panel.width, height: panel.height, viewport: [innerWidth, innerHeight], small: buttons.filter((b) => b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44).map((b) => b.getAttribute('aria-label') ?? b.textContent) };
      });
      expect(metrics.width === metrics.viewport[0] && metrics.height === metrics.viewport[1], `full-screen phone panel: ${JSON.stringify(metrics)}`);
      expect(!metrics.small.length, `phone touch targets: ${metrics.small.join(', ')}`);
      expect(await tab.eval(() => parseFloat(getComputedStyle(document.querySelector('[data-leader-panel] textarea')).fontSize) >= 16), "phone input text is at least 16px");
      await tab.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
      await tab.waitFor("dark theme tokens", () => document.documentElement.dataset.theme === "dark");
      await sleep(150);
      await tab.shot(`${String(n).padStart(2, "0")}-chat-everywhere-dark-mobile`);
      await tab.cdp("Emulation.setEmulatedMedia", { features: [] });
    }
    await tab.key("Escape");
    await tab.key("Escape");
    const at = new Date().toISOString();
    await machineRpc("runs.push", { machine: "chat-everywhere", runs: [{ runId: "R-chat-context", project: "payment", taskId: "PAY-1", taskTitle: "Run context", role: "implement", profileId: "claude-1", status: "succeeded", createdAt: at, finishedAt: at }] });
    await tab.go(`runs?run=${encodeURIComponent(`${machineId}/R-chat-context`)}`);
    await tab.waitFor("run detail", () => document.querySelector('main')?.textContent.includes("Run context"));
    await tab.click("[data-ask-leader]");
    await sleep(450);
    await tab.waitFor("run context", () => document.querySelector('[data-chat-context] a')?.textContent === "R-chat-context");
    await tab.key("Escape");
    await machineRpc("specs.push", { project: "payment", features: [{ dir: "062-chat-context", branch: "ai/chat-context", commit: "abc1260", files: { spec: "# Ngữ cảnh tính năng\n", plan: null, tasks: null } }] });
    await tab.go("features?project=payment&dir=062-chat-context&branch=ai%2Fchat-context");
    await tab.waitFor("feature detail", () => document.querySelector('[data-feature-title]')?.getAttribute('data-feature-title'));
    await tab.click("[data-ask-leader]");
    await sleep(450);
    await tab.waitFor("feature context", () => document.querySelector('[data-chat-context] a')?.textContent === "062-chat-context");
    await tab.click('[data-leader-panel] button[aria-label="Bỏ ngữ cảnh"]');
    expect(await tab.eval(() => !document.querySelector('[data-chat-context]')), "page context can be removed");
    await tab.key("Escape");
    const adminTab = current = tabs.admin;
    adminTab.win.showInactive();
    await adminTab.go("today");
    await adminTab.click("[data-ask-leader]");
    await adminTab.waitFor("admin can choose the whole hub", () => [...document.querySelector('[data-leader-panel] #chat-project')?.options ?? []].some((o) => o.value === "*"));
    await adminTab.key("Escape");
  });

  // Roadmap 60d: payment's leader turns a request into a plan (spec, tasks, batches); Lan starts it with one click.
  await step("leader-plan", async () => {
    const previousPolicy = (await rpc("sdlc.get")).projects.payment;
    try {
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
    const sent = await rpc("chat.send", { project: "payment", machineId, text: "Làm trang hoàn tiền" }, people.lan.token);
    const request = await until("the chat request at Lan's heartbeat", async () => (await beat()).chatRequests?.find((r) => r.replyId === sent.reply.id));
    await lanRpc("chat.progress", { replyId: sent.reply.id, text: "Mình lên kế hoạch." });
    const action = {
      kind: "plan.create",
      spec: { key: "project/payment/hoan-tien", title: "Hoàn tiền", content: "# Hoàn tiền\nNgười mua yêu cầu hoàn tiền trong 7 ngày." },
      tasks: [
        { id: "PAY-R1", title: "API hoàn tiền", acceptance: "Trả lỗi rõ khi quá 7 ngày", dependsOn: [] },
        { id: "PAY-R2", title: "Trang hoàn tiền", acceptance: "Người mua thấy trạng thái yêu cầu", dependsOn: ["PAY-R1"] },
      ],
      batches: [{ title: "API", taskIds: ["PAY-R1"] }, { title: "Giao diện", taskIds: ["PAY-R2"] }],
    };
    const proposed = await lanRpc("chat.propose", { action, reason: "Yêu cầu trong chat" }, request.grant);
    expect(proposed.status === "proposed", `a plan waits for Lan unless payment lets its leader run plans: ${JSON.stringify(proposed)}`);
    await lanRpc("chat.finish", { replyId: sent.reply.id, status: "done", text: "Mình đề xuất Kế hoạch hoàn tiền." });
    const tab = (current = tabs.lan);
    await tab.go(`chat?thread=${sent.thread.id}`);
    await tab.waitFor("the plan card", () => {
      const text = document.body.innerText;
      return text.includes("Kế hoạch: Hoàn tiền") && text.includes("Xong khi: Trả lỗi rõ khi quá 7 ngày") && text.includes("Lô dự kiến");
    });
    await tab.shot(`${String(n).padStart(2, "0")}-leader-plan-proposed`);
    await tab.click('[data-action-status="proposed"] button', "Làm");
    await until("the spec and both tasks made", async () => {
      const tasks = await rpc("tasks.list", { project: "payment" });
      const ui = tasks.find((t) => t.id === "PAY-R2");
      return (await rpc("docs.get", { key: "project/payment/hoan-tien" })) && tasks.some((t) => t.id === "PAY-R1") && ui?.dependsOn.includes("PAY-R1");
    });
    expect((await rpc("sdlc.get")).projects.payment?.autoDispatch === true, "starting a plan opts the service into auto-dispatch");
    await tab.waitFor("the plan done, its spec and task ids linked", () => {
      const card = document.querySelector('[data-action-status="done"] [data-plan="project/payment/hoan-tien"]');
      return !!card?.querySelector('a[href="#/tasks?task=PAY-R2"]') && !!card.querySelector('a[href="#/docs?doc=project%2Fpayment%2Fhoan-tien"]');
    });
    } finally {
      await rpc("sdlc.setProject", { project: "payment", settings: { ...previousPolicy, gates: previousPolicy.gates, autoDispatch: previousPolicy.autoDispatch ?? false } });
    }
  });

  // Research uses an isolated hub and machine RPCs; no paid agent or production hub is called.
  await step("leader-research", async () => {
    const machineRpc = async (method, input, token = people.lan.token) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-hive-agent": "runner.lan-research" }, body: JSON.stringify({ method, input }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const profile = { id: "claude-research", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, research: true };
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-research", instance: "abcd0062", projects: ["payment"], acceptsRuns: true, profiles: [profile] });
    await beat();
    const machineId = (await rpc("machines.list")).find(m => m.machine === "lan-research").id;
    const sent = await rpc("chat.send", { project: "payment", machineId, text: "Nghiên cứu lưu trữ trạng thái hoàn tiền" }, people.lan.token);
    const reply = (await beat()).chatRequests.find(r => r.replyId === sent.reply.id);
    const proposed = await machineRpc("chat.propose", { action: { kind: "research.start", topic: "Lưu trữ trạng thái hoàn tiền", questions: ["Phương án nào dễ kiểm tra và khôi phục?"], sources: ["repo", "hive"], format: "comparison" }, reason: "Đọc trước khi triển khai" }, reply.grant);
    await machineRpc("chat.finish", { replyId: sent.reply.id, status: "done", text: "Mình đề xuất nghiên cứu trước khi lập kế hoạch." });
    const tab = (current = tabs.lan);
    await tab.go(`chat?thread=${sent.thread.id}`);
    await tab.waitFor("research proposal", () => document.body.innerText.includes("Nghiên cứu: Lưu trữ trạng thái hoàn tiền") && !!document.querySelector('[data-research="proposed"]'));
    await tab.click('[data-action-status="proposed"] button', "Xác nhận");
    const research = await until("research queued", async () => {
      const got = await rpc("chat.get", { threadId: sent.thread.id }, people.lan.token);
      const action = got.messages.flatMap(m => m.actions).find(a => a.id === proposed.id);
      return action?.result?.researchId ? rpc("research.get", { id: action.result.researchId }, people.lan.token) : null;
    });
    await machineRpc("runs.requestResult", { id: research.requestId, status: "accepted", runId: "R-research-e2e" });
    await machineRpc("runs.push", { machine: "lan-research", runs: [{ runId: "R-research-e2e", project: "payment", taskId: `research-${research.id}`, taskTitle: "Lưu trữ trạng thái hoàn tiền", role: "research", status: "running", profileId: profile.id, createdAt: new Date().toISOString() }] });
    await tab.waitFor("research in progress", () => document.body.innerText.includes("Đang nghiên cứu"));
    const artifact = await machineRpc("artifacts.put", { project: "payment", taskId: `research-${research.id}`, runId: "R-research-e2e", name: "report.md", data: Buffer.from("# Báo cáo nghiên cứu\nChọn SQLite.\n\n## Nguồn\nREADME.md\n\n## Đề xuất\nPAY-RS1: Lưu trạng thái với test khôi phục.\n").toString("base64") });
    await machineRpc("research.finish", { id: research.id, artifactId: artifact.id, sources: ["README.md", "project/payment/agents"], recommendations: "PAY-RS1: Lưu trạng thái; xong khi test khôi phục xanh." });
    await tab.waitFor("report ready", () => document.body.innerText.includes("Có báo cáo") && document.body.innerText.includes("Nguồn đã đọc"));
    await tab.click('[data-research] button', "Xem báo cáo");
    await tab.waitFor("inline Markdown report", () => document.body.innerText.includes("Chọn SQLite.") && document.body.innerText.includes("Báo cáo nghiên cứu"));
    await tab.click("[data-artifact-preview] button", "Đóng");
    expect(!(await rpc("tasks.list", { project: "payment" })).some(t => t.id === "PAY-RS1"), "research alone creates no work task");
    if (mobile) {
      const targets = await tab.eval(() => [...document.querySelectorAll('[data-research] button, [data-research] a')].map(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
      expect(targets.every(r => r.h >= 44 && r.w >= 44), "research controls have 44px tap areas");
      expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "research card fits the phone");
    }
    await tab.shot(`${String(n).padStart(2, "0")}-research-report`);
    await tab.click('[data-research] button', "Biến thành Kế hoạch");
    const planReply = await until("recommendations sent to same thread", async () => (await beat()).chatRequests?.find(r => r.threadId === sent.thread.id));
    expect(planReply.text.includes("PAY-RS1") && planReply.text.includes("plan.create"), "recommendations go to the plan proposal flow");
    await machineRpc("chat.propose", { action: { kind: "plan.create", spec: { key: "project/payment/research-storage-plan", title: "Lưu trạng thái hoàn tiền", content: "# Lưu trạng thái\nTheo nghiên cứu, dùng SQLite." }, tasks: [{ id: "PAY-RS1", title: "Lưu trạng thái", acceptance: "Test khôi phục xanh", dependsOn: [] }], batches: [{ title: "Lưu trữ", taskIds: ["PAY-RS1"] }] }, reason: "Từ báo cáo nghiên cứu" }, planReply.grant);
    await machineRpc("chat.finish", { replyId: planReply.replyId, status: "done", text: "Mình đề xuất Kế hoạch từ nghiên cứu." });
    await tab.waitFor("plan from research", () => !!document.querySelector('[data-plan="project/payment/research-storage-plan"]'));
    // Starting the plan opts payment into auto-dispatch; put it back so later steps (agent-assign) own the free places.
    const previousPolicy = (await rpc("sdlc.get")).projects.payment;
    try {
      await tab.click('[data-action-status="proposed"] button', "Làm");
      await until("research plan task created", async () => (await rpc("tasks.list", { project: "payment" })).find(t => t.id === "PAY-RS1"));
    } finally {
      await rpc("sdlc.setProject", { project: "payment", settings: { ...previousPolicy, gates: previousPolicy?.gates ?? {}, autoDispatch: previousPolicy?.autoDispatch ?? false } });
    }
  });

  // Roadmap 37b: the UI opens a hub thread; heartbeat/RPC stand in for a leader, with no real CLI or hub.
  await step("codex-leader-chat", async () => {
    const machineRpc = async (method, input) => {
      const response = await fetch(`${base}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.codex-leader-e2e" },
        body: JSON.stringify({ method, input }),
      });
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const profile = (id, kind, priority, overLimit = false) => ({ id, label: id, kind, priority, overLimit, enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, supportedModels: kind === "codex" ? ["gpt-test-leader"] : ["opus"] });
    const beat = (tired = true) => machineRpc("machines.heartbeat", { machine: "codex-leader-e2e", instance: "ab000062", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-leader", "claude", 1, tired), profile("codex-leader", "codex", 2)] });
    await beat();
    const machineId = (await rpc("machines.list")).find((m) => m.machine === "codex-leader-e2e").id;
    await rpc("chat.setDefaults", { project: "payment", machineId, profileId: null, model: null, effort: null });
    const tab = (current = tabs.admin);
    await tab.eval(() => localStorage.removeItem("xdev-hive.scope"));
    await tab.reload(); await tab.go("chat"); await tab.click("[data-chat-new]");
    await tab.select("#chat-project", "payment");
    await tab.waitFor("available Codex plan chosen by default", (id) => document.querySelector("#chat-machine")?.value === id && document.querySelector("#chat-plan")?.value === "codex-leader", machineId);
    await tab.select("#chat-new-model", "gpt-test-leader"); await tab.select("#chat-new-effort", "high");
    if (mobile) {
      const targets = await tab.eval(() => [...document.querySelectorAll('#chat-project, #chat-machine, #chat-plan, #chat-new-model, #chat-new-effort')].map((el) => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) })));
      expect(targets.every((el) => el.height >= 44 && el.font >= 16), JSON.stringify(targets));
    }
    await tab.click("button", "Lưu làm mặc định");
    await until("Codex defaults saved", async () => (await rpc("chat.defaults", { project: "payment" })).profileId === "codex-leader");
    await tab.shot("codex-leader-picker");
    await tab.click('textarea[aria-label="Tin nhắn"]'); await tab.type("Leader Codex 62a"); await tab.click("button", "Bắt đầu");
    const thread = await until("Codex thread created", async () => (await rpc("chat.threads", { project: "payment" })).find((t) => t.title === "Leader Codex 62a"));
    const request = (await beat()).chatRequests.find((r) => r.threadId === thread.id);
    expect(request.profileId === "codex-leader" && request.model === "gpt-test-leader" && request.effort === "high", JSON.stringify(request));
    await machineRpc("chat.finish", { replyId: request.replyId, status: "done", text: "Đã đọc service bằng Codex.", sessionId: "codex-e2e-thread", profileId: "codex-leader", tokens: { inputTokens: 80, cacheReadTokens: 20, outputTokens: 30 } });
    // Since 64b the turn's total is in the session bar's summary; the in/cache/out split is inside the folded bar.
    await tab.waitFor("Codex reply and tokens", () => document.body.innerText.includes("Đã đọc service bằng Codex") && document.querySelector("[data-chat-session] > summary")?.innerText.includes("Token lượt: 130"));
    await tab.click("[data-chat-session] > summary");
    await tab.waitFor("Codex token split", () => document.querySelector("[data-chat-session]")?.innerText.includes("Token: 80 vào · 20 cache · 30 ra"));
    await beat(false);
    const claude = await rpc("chat.send", { project: "payment", machineId, profileId: "claude-leader", model: "opus", text: "Claude hết quota 62a" });
    await machineRpc("chat.finish", { replyId: claude.reply.id, status: "failed", text: "Câu trả lời dở dang", sessionId: "claude-e2e-thread", rateLimited: true, error: { message: "Usage limit reached" } });
    const next = await rpc("chat.send", { project: "payment", threadId: claude.thread.id, text: "Tiếp tục bằng gói còn quota" });
    const switched = (await beat(false)).chatRequests.find((r) => r.replyId === next.reply.id);
    expect(switched.profileId === "codex-leader" && switched.sessionId === null && switched.model === null, JSON.stringify(switched));
    await machineRpc("chat.finish", { replyId: next.reply.id, status: "done", text: "Tiếp tục bằng Codex.", profileId: "codex-leader", sessionId: "codex-fallback-thread", tokens: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 } });
    await tab.go(`chat?thread=${claude.thread.id}`);
    await tab.waitFor("quota fallback notice in thread", () => document.body.innerText.includes("claude-leader hết quota") && document.body.innerText.includes("chuyển sang codex-leader") && document.body.innerText.includes("Tiếp tục bằng Codex."));
    await tab.shot("codex-leader-fallback");
  });

  await step("hub-leader-chat", async () => {
    const machineRpc = async (method, input, token = admin) => {
      const response = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-hive-agent": "runner.hub-leader-e2e" },
        body: JSON.stringify({ method, input }),
      });
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const claude = { id: "claude-hub", label: "Claude hub", kind: "claude", enabled: true, priority: 1, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
    const beat = () => machineRpc("machines.heartbeat", { machine: "hub-leader-e2e", instance: "ab000001", projects: [], acceptsRuns: true, profiles: [claude] });
    await beat();
    const machineId = (await rpc("machines.list")).find((m) => m.machine === "hub-leader-e2e").id;
    const beforePayment = await rpc("chat.defaults", { project: "payment" });
    const tab = (current = tabs.admin);
    // Keep sheet animations running while exercising their controls.
    tab.win.showInactive();
    await tab.eval(() => localStorage.removeItem("xdev-hive.scope"));
    await tab.reload();
    await tab.go("chat");
    await tab.click("[data-chat-new]");
    const options = await tab.waitFor("whole hub first in the scope choices", () => {
      const select = document.querySelector("#chat-project");
      return select && [...select.options].map((o) => ({ value: o.value, label: o.textContent }));
    });
    expect(options[0].value === "*" && options[0].label === "Toàn hub", JSON.stringify(options));
    await tab.select("#chat-project", "*");
    await tab.select("#chat-machine", machineId);
    await tab.select("#chat-plan", "claude-hub");
    await tab.select("#chat-new-model", "opus");
    await tab.select("#chat-new-effort", "high");
    await tab.click("button", "Lưu làm mặc định");
    await until("hub chat defaults saved", async () => {
      const d = await rpc("chat.defaults", { project: "*" });
      return d.machineId === machineId && d.profileId === "claude-hub" && d.model === "opus" && d.effort === "high";
    });
    if (mobile) {
      const targets = await tab.eval(() => [...document.querySelectorAll('#chat-project, #chat-machine, #chat-plan, #chat-new-model, #chat-new-effort')].map((el) => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) })));
      expect(targets.every((el) => el.height >= 44 && el.font >= 16), JSON.stringify(targets));
    }
    await tab.click("button", "Hướng dẫn leader");
    await tab.select("#guide-project", "*");
    await tab.waitFor("shared guide and separate hub autonomy", () => document.body.innerText.includes("Leader toàn hub dùng skill hive-leader chung") && document.body.innerText.includes("Cài đặt này độc lập với từng service"));
    await tab.click("label", "Đổi trạng thái task");
    await tab.click("button", "Lưu việc tự chạy cho Toàn hub");
    await until("hub autonomy saved", async () => (await rpc("chat.defaults", { project: "*" })).autoKinds.includes("task.update"));
    await tab.click("#guide-commands");
    // Select the defaults so typing replaces them; a Meta+A key event does not select in this Electron page.
    await tab.eval(() => document.querySelector("#guide-commands").select());
    await tab.type("git status\ngit log");
    await tab.click("button", "Lưu lệnh cho Toàn hub");
    await until("hub commands saved", async () => (await rpc("chat.defaults", { project: "*" })).commands.length === 2);
    expect(JSON.stringify(await rpc("chat.defaults", { project: "payment" })) === JSON.stringify(beforePayment), "hub settings did not change payment's defaults, commands or autonomy");
    await tab.key("Escape");
    await tab.click('textarea[aria-label="Tin nhắn"]');
    await tab.type("Điều phối toàn hub 37b");
    await tab.click("button", "Bắt đầu");
    const sent = await until("hub thread sent from the UI", async () => (await rpc("chat.threads", { project: "*" })).find((th) => th.title === "Điều phối toàn hub 37b"));
    const reply = (await rpc("chat.get", { threadId: sent.id })).messages.at(-1);
    const request = await until("hub leader heartbeat request", async () => (await beat()).chatRequests?.find((r) => r.replyId === reply.id));
    await machineRpc("chat.progress", { replyId: reply.id, text: "Đề xuất theo service và máy." });
    for (const [project, id] of [["payment", "HUB-PAY-37B"], ["demo", "HUB-DEMO-37B"]]) {
      await machineRpc("chat.propose", { action: { kind: "task.create", project, id, title: `Việc toàn hub cho ${project}`, dependsOn: [] }, reason: "Admin giao điều phối toàn hub" }, request.grant);
    }
    await machineRpc("chat.propose", { action: { kind: "machine.profile", machine: "hub-leader-e2e", profileId: "claude-hub", enabled: true }, reason: "Gói cho leader toàn hub" }, request.grant);
    await machineRpc("chat.finish", { replyId: reply.id, status: "done", text: "Đề xuất theo service và máy." });
    await tab.waitFor("all service and hub proposal labels", () => ["payment", "demo", "*"].every((p) => document.querySelector(`[data-action-project="${p}"]`)));
    const labels = await tab.eval(() => [...document.querySelectorAll("[data-action-project]")].map((el) => el.textContent));
    expect(labels.includes("cho service payment") && labels.includes("cho service demo") && labels.includes("Cả hub"), JSON.stringify(labels));
    await tab.shot("hub-leader-proposals");
    await tab.click("button", "Xác nhận tất cả");
    await until("hub proposals confirmed together", async () => (await rpc("chat.get", { threadId: sent.id })).messages.at(-1).actions.every((a) => a.status === "done"));
    for (const [project, id] of [["payment", "HUB-PAY-37B"], ["demo", "HUB-DEMO-37B"]]) {
      expect((await rpc("tasks.list", { project })).some((t) => t.id === id), `${id} was created in ${project}`);
    }
    // A project lead can open Chat, but cannot choose or see the hub's thread or its settings.
    const lead = tabs.lan;
    await lead.reload();
    await lead.go("chat");
    await lead.click("[data-chat-new]");
    expect(await lead.eval(() => !document.querySelector('#chat-project option[value="*"]')), "a project lead has no whole-hub choice");
    await lead.click("button", "Hướng dẫn leader");
    expect(await lead.eval(() => !document.querySelector('#guide-project option[value="*"]')), "a project lead has no whole-hub settings");
    await lead.key("Escape");
    expect(!(await rpc("chat.threads", {}, people.lan.token)).some((t) => t.id === sent.id), "a project lead cannot list hub threads");
    await tab.reload();
    await tab.go("chat");
    await tab.waitFor("the hub label in the thread list", () => [...document.querySelectorAll('nav[aria-label="Các cuộc chat"] button')].some((el) => el.textContent.includes("Điều phối toàn hub 37b") && el.textContent.includes("Toàn hub")));
  });

  await step("hub-page", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/overview");
    await tab.waitFor("startup log card", () => document.body.innerText.includes("Sau lần khởi động này") && document.body.innerText.includes("Backup lúc khởi động"));
    expect(await tab.eval(() => document.body.innerText.includes("Giữ log 24 giờ")), "log retention and alert threshold are explained");
    await tab.eval(() => [...document.querySelectorAll("h2")].find((h) => h.textContent === "Sau lần khởi động này")?.closest("section")?.scrollIntoView({ block: "start", behavior: "instant" }));
    await tab.waitFor("startup card in view", () => {
      const card = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Sau lần khởi động này")?.closest("section");
      const rect = card?.getBoundingClientRect();
      return rect && rect.top >= 0 && rect.top < innerHeight;
    });
    await tab.shot("startup-log-card");
    if (mobile) expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "startup log card overflows phone");
    await tab.go("admin/hub");
    await tab.waitFor("the hub's cards", () => ["Tệp tài liệu", "Backup"].every((t) => document.body.innerText.includes(t)));
  });

  await step("backup-late-today", async () => {
    const tab = (current = tabs.admin);
    await tab.go("today?section=inbox");
    const alert = await until("the overdue backup alert", async () => (await rpc("alerts.list", {})).open.find((a) => a.rule === "backup_overdue"));
    await tab.waitFor("the overdue backup in Hôm nay", () => {
      const row = document.querySelector(`[data-inbox-key="alert:${alert.id}"]`);
      return row?.innerText.includes("Backup quá hạn") && row;
    });
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
    await tab.click("button", "Sửa");
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
    await rpc("tasks.create", { id: "OLD-1", project: "throwaway", title: "Việc của service bỏ đi" });
    await rpc("memory.write", { project: "throwaway", kind: "gotcha", content: "Ghi chú của service bỏ đi." });
    await rpc("docs.save", { key: "project/throwaway/arch", title: "Kiến trúc", content: "# Kiến trúc cũ\n" });
    const tab = (current = tabs.admin);
    await tab.reload();
    await tab.go("settings?tab=systems");
    await tab.click("button", "Sửa");
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

  // Roadmap 40a: the scope picker lists systems first, a repo in no system as a system of its own; a system's services
  // show when it is opened or searched, picking the system leaves its services' tasks, and the titles name the system.
  await step("scope-system-first", async () => {
    await rpc("tasks.create", { id: "KHO-1", project: "kho-api", title: "Việc của kho-api" });
    await rpc("tasks.create", { id: "KHO-2", project: "kho-web", title: "Việc của kho-web" });
    await rpc("tasks.create", { id: "KHOLE-1", project: "kho-le", title: "Việc của kho-le" });
    await rpc("systems.save", { name: "kho", projects: ["kho-api", "kho-web"] });
    const tab = (current = tabs.admin);
    // From all projects whatever an earlier step left picked.
    await tab.eval(() => localStorage.removeItem("xdev-hive.scope"));
    await tab.reload();
    await tab.go("tasks");
    await tab.waitFor("tasks of every project", () => ["kho-api", "kho-web", "kho-le", "payment"].every((p) => document.body.innerText.includes(`Việc ${p === "payment" ? "đầu tiên " : ""}của ${p}`)));
    await tab.click("[data-project-picker-trigger]");
    // Roots as "name", a virtual one as "name*".
    const closed = await tab.waitFor("kho and kho-le as roots, services hidden", () => {
      const all = [...document.querySelectorAll('[data-scope-row="root"]')].map((r) => `${r.dataset.scopeRoot}${r.hasAttribute("data-scope-virtual") ? "*" : ""}`);
      return all.includes("kho") && all.includes("kho-le*") && !document.querySelector('[data-scope-row="service"][data-scope-root="kho"]') && all;
    });
    expect(!closed.some((r) => r.startsWith("kho-api") || r.startsWith("kho-web")), `a service of kho as a root: ${closed}`);
    await tab.click('[data-scope-toggle="kho"]');
    await tab.waitFor("kho opened on its two services", () => document.querySelectorAll('[data-scope-row="service"][data-scope-root="kho"]').length === 2);
    await tab.shot(`${String(n).padStart(2, "0")}-scope-picker`);
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("kho");
    const found = await tab.waitFor("two roots for kho", () => {
      const all = [...document.querySelectorAll('[data-scope-row="root"]')].map((r) => `${r.dataset.scopeRoot}${r.hasAttribute("data-scope-virtual") ? "*" : ""}`);
      return all.length === 2 && all;
    });
    expect(found.join() === "kho,kho-le*", `roots for kho: ${found}`);
    await tab.click('[role="option"]', "kho");
    await tab.waitFor("only the tasks of kho's two services", () => {
      const text = document.body.innerText;
      return text.includes("Việc của kho-api") && text.includes("Việc của kho-web") && !text.includes("Việc của kho-le") && !text.includes("Việc đầu tiên của payment");
    });
    await tab.waitFor("the system in the title", () => document.querySelector("[data-shell-title]")?.textContent.startsWith("kho › "));
    await tab.shot(`${String(n).padStart(2, "0")}-scope-system`);
    // A service reads as system › service in the menu and the title.
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[data-scope-toggle="kho"]');
    await tab.click('[role="option"]', "kho-api");
    await tab.waitFor("kho › kho-api", () => document.querySelector("[data-project-picker-trigger]")?.textContent.includes("kho › kho-api") && document.querySelector("[data-shell-title]")?.textContent.startsWith("kho › kho-api › "));
    await tab.waitFor("only kho-api's task", () => document.body.innerText.includes("Việc của kho-api") && !document.body.innerText.includes("Việc của kho-web"));
    // The lone repo: its own scope, named by itself.
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "kho-le");
    await tab.waitFor("only kho-le's task", () => document.body.innerText.includes("Việc của kho-le") && !document.body.innerText.includes("Việc của kho-api") && document.querySelector("[data-shell-title]")?.textContent.startsWith("kho-le › "));
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả service");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
  });

  await step("overview-by-system", async () => {
    const at = new Date().toISOString();
    for (const [id, project, status] of [["OV-1", "ov-api", "review"], ["OV-2", "ov-web", "todo"], ["OV-3", "ov-jobs", "doing"], ["OV-4", "ov-solo", "todo"]]) {
      await rpc("tasks.create", { id, project, title: `Overview ${project}` });
      if (status !== "todo") await rpc("tasks.update", { id, status });
    }
    await rpc("systems.save", { name: "ov-shop", projects: ["ov-api", "ov-web"] });
    await rpc("systems.save", { name: "ov-backoffice", projects: ["ov-jobs"] });
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.overview" }, body: JSON.stringify({ method, input }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
    await machineRpc("machines.heartbeat", { machine: "overview", instance: "0e40d001", version: "0.138.0", projects: ["ov-api", "ov-web", "ov-jobs"] });
    await machineRpc("runs.push", { machine: "overview", runs: [
      { runId: "OV-R1", project: "ov-api", taskId: "OV-1", taskTitle: "Overview ov-api", role: "implement", profileId: null, status: "running", createdAt: at, startedAt: at },
      { runId: "OV-R2", project: "ov-web", taskId: "OV-2", taskTitle: "Overview ov-web", role: "implement", profileId: null, status: "queued", createdAt: at },
      { runId: "OV-R3", project: "ov-jobs", taskId: "OV-3", taskTitle: "Overview ov-jobs", role: "implement", profileId: null, status: "running", createdAt: at, startedAt: at },
    ] });
    const tab = (current = tabs.admin);
    await tab.eval(() => localStorage.removeItem("xdev-hive.scope"));
    await tab.reload();
    for (const route of ["overview"]) {
      await tab.go(route);
      await tab.waitFor(`${route}: counts of two systems and lone repo`, () => {
        const totals = (name) => [...document.querySelectorAll(`[data-system-card="${name}"] [data-system-total] [data-system-count]`)].map((el) => el.textContent).join();
        return totals("ov-shop") === "2,1,1" && totals("ov-backoffice") === "1,1,0" && totals("ov-solo") === "1,0,0";
      });
      expect(await tab.eval(() => !document.querySelector('[data-system-card="ov-api"]') && document.querySelectorAll('[data-system-card="ov-shop"] [data-system-service]').length === 2), "services also appeared as roots or are missing");
      expect(await tab.eval(() => {
        const counts = (service) => [...document.querySelectorAll(`[data-system-card="ov-shop"] [data-system-service="${service}"] [data-system-count]`)].map((el) => el.textContent).join();
        return counts("ov-api") === "1,1,1" && counts("ov-web") === "1,0,0";
      }), "service counts differ from their system total");
      expect(await tab.eval(() => [...document.querySelectorAll('[data-system-card="ov-shop"] button')].every((b) => { const r = b.getBoundingClientRect(); return r.height >= 44 && r.width >= 44; })), "system/service touch target below 44px");
      if (mobile) expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "system overview overflows phone");
      await tab.shot(`${String(n).padStart(2, "0")}-${route}-systems`);
    }
    await tab.click('[data-system-card="ov-shop"] > button');
    await tab.go("tasks");
    await tab.click('[data-task-view="list"]');
    await tab.waitFor("both services in task list", () => document.body.innerText.includes("Overview ov-api") && document.body.innerText.includes("Overview ov-web"));
    expect(await tab.eval(() => [...document.querySelectorAll("th")].some((th) => th.textContent === "Service")), "task table has no Service column");
    await tab.select("[data-service-filter]", "ov-web");
    await tab.waitFor("tasks filtered by service", () => document.body.innerText.includes("Overview ov-web") && !document.body.innerText.includes("Overview ov-api"));
    // A closed phone menu (a Sheet) is not mounted; the shell title names the same scope.
    expect(await tab.eval(() => (document.querySelector('[data-project-picker-trigger]') ?? document.querySelector("[data-shell-title]"))?.textContent.includes("ov-shop")), "filter changed sidebar scope");
    await tab.go("runs");
    await tab.waitFor("runs from both services", () => document.querySelector('[data-run-service="ov-api"]') && document.querySelector('[data-run-service="ov-web"]'));
    await tab.select("[data-service-filter]", "ov-api");
    await tab.waitFor("runs filtered by service", () => document.querySelector('[data-run-service="ov-api"]') && !document.querySelector('[data-run-service="ov-web"]'));
    if (mobile) expect(await tab.eval(() => document.querySelector('[data-service-filter]').getBoundingClientRect().height >= 44), "service filter touch target below 44px");
    // Changing scope invalidates the local service filter, including across two systems.
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[data-scope-row="root"][data-scope-root="ov-backoffice"] [role="option"]');
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.waitFor("other system's service", () => document.querySelector('[data-run-service="ov-jobs"]') && document.querySelector('[data-service-filter]')?.value === "");
    await tab.eval(() => localStorage.removeItem("xdev-hive.scope"));
    await tab.reload();
  });

  // Roadmap 19d: a task of one service waits for another service's (demo waits for payment's), named with its project.
  await step("cross-service-task", async () => {
    const task = await rpc("tasks.create", { id: "DEMO-2", project: "demo", title: "Trang đơn hàng", dependsOn: ["PAY-1"] });
    expect(task.depProjects?.["PAY-1"] === "payment", `DEMO-2: ${JSON.stringify(task)}`);
    const tab = (current = tabs.lan);
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả service");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.go("tasks?task=DEMO-2");
    await tab.waitFor("DEMO-2 waiting for payment/PAY-1", () => document.body.innerText.includes("Trang đơn hàng") && document.body.innerText.includes("payment/PAY-1"));
  });

  // Roadmap 51c: with All projects the graph is one node per project and the 19d dependency between them; a node opens
  // its project, whose SDLC layer lets Lan pass a flow's spec gate on the step itself; a system shows its services.
  await step("graph-sdlc-system", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" }, body: JSON.stringify({ method, input }) });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const lanRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}` }, body: JSON.stringify({ method, input }) });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    // The same profiles sdlc-flow left, so the steps after this one find the machine as they did.
    const profile = (id, kind) => ({ id, label: id, kind, enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, maxConcurrent: 1 });
    const beat = () => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", version: "0.115.0", projects: ["payment"], acceptsRuns: true, profiles: [profile("claude-1", "claude"), profile("codex-1", "codex")], runs: [] });
    await beat();
    // A flow at payment's spec gate (a person's, as seed.mjs pins it), the way sdlc-flow gets there.
    await lanRpc("specs.runStep", { project: "payment", step: "specify", taskId: "SPEC-GRAPH", title: "Spec: sơ đồ", input: "Sơ đồ luồng.", machineId: "runner.lan-mbp@lan-e2e" });
    const [specify] = (await beat()).runRequests.filter((r) => r.taskId === "SPEC-GRAPH");
    await machineRpc("runs.requestResult", { id: specify.id, status: "accepted", runId: "R-graph1" });
    const at = new Date().toISOString();
    const run = { runId: "R-graph1", project: "payment", taskId: "SPEC-GRAPH", taskTitle: "Spec: sơ đồ", role: "implement", profileId: "claude-1", createdAt: at };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "running" }] });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "succeeded", finishedAt: at }] });
    await machineRpc("specs.push", { project: "payment", features: [{ dir: "002-so-do", branch: "ai/SPEC-GRAPH", commit: "abc1240", files: { spec: "# Sơ đồ\n", plan: null, tasks: null } }] });

    // cross-service-task left Lan on All projects.
    const tab = (current = tabs.lan);
    await tab.go("graph");
    await tab.waitFor("a node per project and the cross-service edge", () => !!document.querySelector('[data-graph-service="payment"]') && !!document.querySelector('[data-graph-service="demo"]') && !!document.querySelector('.react-flow__edge[data-id="system:payment->system:demo"]'));
    // Polling replaces the node objects; the service edge must keep its handle positions after that refresh.
    await sleep(5500);
    await tab.waitFor("cross-service edge after graph refresh", () => !!document.querySelector('.react-flow__edge[data-id="system:payment->system:demo"]'));
    expect(!!(await tab.eval(() => document.querySelector('[data-graph-layer="system"]')?.getAttribute("aria-pressed") === "true" && document.querySelector('[data-graph-layer="task"]')?.disabled)), "All projects shows only the system layer");
    const demo = await tab.eval(() => document.querySelector('[data-graph-service="demo"]')?.getAttribute("aria-label") ?? "");
    expect(/task mở/.test(demo) && /run đang chạy/.test(demo), `service node label: ${demo}`);
    await tab.shot("graph-system-all");
    await tab.click('[data-graph-service="payment"]');
    await tab.waitFor("the payment project's task layer", () => document.querySelector('[data-graph-layer="task"]')?.getAttribute("aria-pressed") === "true" && !!document.querySelector('[data-graph-task="PAY-1"]'));

    await tab.click('[data-graph-layer="sdlc"]');
    await tab.waitFor("the flow's spec step waiting for a person", () => document.querySelector('[data-graph-step="SPEC-GRAPH:spec"]')?.getAttribute("data-graph-step-state") === "gate" && !!document.querySelector('[data-graph-step="SPEC-GRAPH:spec"] [data-graph-pass]'));
    const label = await tab.eval(() => document.querySelector('[data-graph-step="SPEC-GRAPH:spec"] a')?.getAttribute("aria-label") ?? "");
    expect(label.includes("Chờ chốt") && label.includes("giao run"), `step label: ${label}`);
    await tab.shot("graph-sdlc-layer");
    await tab.click('[data-graph-step="SPEC-GRAPH:spec"] [data-graph-pass]');
    await tab.waitFor("the spec step passed and plan next", () => document.querySelector('[data-graph-step="SPEC-GRAPH:spec"]')?.getAttribute("data-graph-step-state") === "done" && document.querySelector('[data-graph-step="SPEC-GRAPH:plan"]')?.getAttribute("data-graph-step-state") === "running");
    const gates = await rpc("sdlc.gates", { taskId: "SPEC-GRAPH" });
    expect(gates[0]?.gate === "spec" && gates[0]?.status === "passed" && gates[0]?.decidedBy?.startsWith("lan"), `gate: ${JSON.stringify(gates[0])}`);
    // Leave the hub as the other steps expect it: no plan step waiting for lan-mbp.
    const [plan] = (await beat()).runRequests.filter((r) => r.taskId === "SPEC-GRAPH");
    if (plan) await rpc("runs.cancelRequest", { id: plan.id });

    await tab.click("[data-project-picker-trigger]");
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("ban-hang");
    await tab.click('[role="option"]', "ban-hang");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.click('[data-graph-layer="system"]');
    // Only the services Lan sees: ledger may not be one of them.
    await tab.waitFor("the system's services", () => ["payment", "demo"].every((p) => !!document.querySelector(`[data-graph-service="${p}"]`)));
    await tab.shot("graph-system-layer");
    await tab.click("[data-project-picker-trigger]");
    await tab.click('[role="option"]', "Tất cả service");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
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
    // Roadmap 49g: and a run that stopped to ask (Chờ người, 49e), which lands in Agent đang chờ bạn.
    const asked = { runId: "R-today2", project: "payment", taskId: "TODAY-ASK", taskTitle: "Hỏi cách làm", role: "implement", profileId: "claude-1", createdAt: at, finishedAt: at };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...asked, status: "succeeded", summary: "Cần bạn xác nhận: dùng API cũ hay mới?" }] });

    const tab = (current = tabs.lan);
    await tab.reload();
    await tab.go("today?section=inbox");
    // Lan leads payment: what she decides comes first, then the agents waiting on her, then what to review.
    const groups = await tab.waitFor("Hôm nay grouped for a lead", () => {
      const list = [...document.querySelectorAll("[data-inbox-group]")].map((g) => g.getAttribute("data-inbox-group"));
      return document.querySelector("[data-inbox-role]")?.getAttribute("data-inbox-role") === "lead" && list.includes("agent") && list.includes("decide") && list;
    });
    expect(groups[0] === "decide" && groups.indexOf("agent") < (groups.includes("review") ? groups.indexOf("review") : Infinity), `groups: ${groups.join()}`);
    const askedKey = await tab.waitFor("the asking run in Agent đang chờ bạn", () =>
      document.querySelector('[data-inbox-group="agent"] [data-inbox-key*="/R-today2:question:"]')?.getAttribute("data-inbox-key"));
    expect(await tab.eval(() => !document.querySelector("[data-system-card]")), "Today must focus on inbox without system overview");
    expect(await tab.eval(() => (document.querySelector("[data-today-shortcuts]")?.getBoundingClientRect().height > 0) === (innerWidth >= 768)), "keyboard hints follow viewport");
    await tab.shot(`${String(n).padStart(2, "0")}-today-groups`);
    await tab.click(`[data-inbox-key="${askedKey}"]`);
    await tab.waitFor("the run's question", () => document.body.innerText.includes("dùng API cũ hay mới"));
    await tab.click("button", "Mở run");
    await tab.waitFor("the run on Agent đang chạy", () => location.hash.startsWith("#/runs") && document.body.innerText.includes("Hỏi cách làm"));
    await tab.go("today?section=inbox");
    await tab.click(`[data-inbox-key="gate:${gate.id}"]`);
    expect(await tab.eval(() => {
      const actions = document.querySelector("[data-today-actions]");
      const content = actions?.previousElementSibling;
      if (!content) return false;
      const gap = actions.getBoundingClientRect().top - content.getBoundingClientRect().bottom;
      return gap >= 0 && gap <= 16 && actions.parentElement.parentElement.classList.contains("overflow-y-auto");
    }), "Today actions must immediately follow content in its scroll area");
    await tab.shot(`${String(n).padStart(2, "0")}-today-gate`);
    await tab.click("button", "Duyệt, sang bước sau");
    await until("the spec gate passed from Hôm nay", async () => {
      const [gate] = await rpc("sdlc.gates", { taskId: "SPEC-TODAY" });
      return gate?.status === "passed" && gate.decidedBy?.startsWith("lan");
    });
    if (mobile) {
      // A toast (the approval's) must not sit over the way back: the button under its own centre is itself.
      await tab.waitFor("Quay lại danh sách not covered", () => {
        const back = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("Quay lại danh sách"));
        if (!back) return false;
        const r = back.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && back.contains(hit);
      });
      await tab.click("button", "Quay lại danh sách");
    }
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
    await tab.click('details summary', "Checklist cá nhân trên trình duyệt");
    await tab.waitFor("three items to check", () => document.querySelectorAll("[data-check]").length === 3 && document.querySelector("[data-checks-progress]")?.textContent.includes("0/3"));
    await tab.click('[data-check="SC-001"] [role="checkbox"]');
    await tab.waitFor("one checked", () => document.querySelector("[data-checks-progress]")?.textContent.includes("1/3"));
    await tab.reload();
    await tab.click('details summary', "Checklist cá nhân trên trình duyệt");
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

  await step("acceptance-evidence", async () => {
    const project = "payment", taskId = "EVID-E2E", specDir = "070-nghiem-thu", specBranch = `ai/${taskId}`;
    const spec = "# Nghiệm thu dùng chung\n## Acceptance criteria\n- **AC-001**: Người kiểm lưu kết quả kèm báo cáo\n- **AC-002**: Người khác xem lại được sau khi tải lại\n";
    const publish = (commit, text = spec) => rpc("specs.push", { project, features: [{ dir: specDir, branch: specBranch, commit, files: { spec: text, plan: null, tasks: null } }] });
    await rpc("tasks.create", { id: taskId, project, title: "Kiểm nghiệm thu dùng chung" });
    await publish("a".repeat(40));
    const artifact = await rpc("artifacts.put", { project, taskId, runId: "R-evidence", name: "verification.log", data: Buffer.from("expected: shared result\nactual: shared result\n").toString("base64") });
    const context = await rpc("evidence.context", { project, taskId, specDir, specBranch });
    expect(context?.commitSha === "a".repeat(40), "the hub supplies the full tested SHA");
    const route = `features?project=${project}&dir=${specDir}&branch=${encodeURIComponent(specBranch)}&view=checks`;
    const tab = current = tabs.admin;
    await tab.go(route);
    await tab.waitFor("shared verification form", () => !!document.querySelector("[data-evidence-form]") && document.querySelector('[data-evidence-progress]')?.textContent.includes("0/2"));
    await tab.shot("acceptance-before-verification");
    await tab.select("[data-evidence-outcome]", "passed");
    await tab.waitFor("passed selected", () => document.querySelector("[data-evidence-outcome]")?.value === "passed");
    await tab.click("[data-evidence-note]");
    await tab.type("Web 390/1440px: lưu kết quả, tải lại; mong đợi dữ liệu giữ nguyên; thực tế đúng.");
    await tab.click("[data-evidence-form] label", "verification.log");
    await tab.click("[data-evidence-save]");
    await tab.waitFor("shared passed result", () => !!document.querySelector('[data-evidence-result="passed"]') && document.querySelector('[data-evidence-progress]')?.textContent.includes("1/2"));
    const rows = await rpc("evidence.list", context);
    expect(rows.length === 1 && rows[0].outcome === "passed" && rows[0].artifactIds[0] === artifact.id, "UI saved the real result and attached file to the right revision");
    await tab.reload();
    await tab.waitFor("verification survives reload", () => document.querySelector('[data-evidence-progress]')?.textContent.includes("1/2"));
    await tab.shot("acceptance-after-verification");
    await tab.click('[data-evidence-result] a', "verification.log");
    await tab.waitFor("the exact verified log opens", () => document.querySelector('[data-artifact-content]')?.textContent.includes("actual: shared result"));
    await tab.shot("acceptance-attached-log");
    await tab.go(route);
    await tab.waitFor("verification form after opening the log", () => !!document.querySelector('[data-evidence-form]'));
    const viewer = current = await signInWithToken("evidence-reader", people.hoa.token, route);
    await viewer.waitFor("another person reads shared verification", () => !!document.querySelector('[data-evidence-result="passed"]'));
    expect(await viewer.eval(() => !document.querySelector("[data-evidence-form]")), "reader has no verification form");
    current = tab;
    await tab.click("[data-evidence-note]"); await tab.type("Attempt on a now superseded revision.");
    await publish("b".repeat(40), spec + "- **AC-003**: Revision mới phải kiểm lại\n");
    await tab.click("[data-evidence-save]");
    await tab.waitFor("stale verification refused", () => document.body.innerText.includes("Đặc tả hoặc commit đã đồng bộ vừa thay đổi"));
    expect((await rpc("evidence.list", context)).length === 1, "stale save did not create a result");
    await tab.reload();
    await tab.waitFor("new revision starts unverified", () => document.querySelector('[data-evidence-progress]')?.textContent.includes("0/3") && document.body.innerText.includes("Bản trước"));
    await tab.shot("acceptance-revision-changed");
    if (mobile) expect(await tab.eval(() => {
      const box = document.querySelector("[data-acceptance-evidence]");
      return box.scrollWidth <= box.clientWidth + 1 && [...box.querySelectorAll("button, select, textarea, a")].every(el => el.getBoundingClientRect().height >= 44);
    }), "acceptance evidence fits the phone and has 44px controls");
    await accessibilityAudit({ tab, out, expect, routes: [route], filename: "acceptance-accessibility.json" });
    await tab.eval(() => localStorage.setItem("xdev-hive.locale", "en"));
    await tab.reload();
    await tab.waitFor("English verification labels", () => document.querySelector('[data-acceptance-evidence]')?.textContent.includes("Shared acceptance evidence"));
    await tab.shot("acceptance-english");
    await tab.eval(() => localStorage.setItem("xdev-hive.locale", "vi"));
    await tab.reload();
    viewer.win.close();
    await rpc("runs.push", { machine: "acceptance-fixture", runs: [{ runId: "R-evidence-sha", project, taskId, taskTitle: "Nghiệm thu revision code", role: "implement", status: "succeeded", profileId: null, branch: specBranch, headSha: "c".repeat(40), createdAt: new Date().toISOString() }] });
    await tab.go("runs?run=R-evidence-sha");
    await tab.waitFor("the run exposes its exact code revision", () => document.querySelector('[data-run-head-sha]')?.textContent.includes("c".repeat(40)));
    if (mobile) expect(await tab.eval(() => {
      const heading = document.querySelector('[data-run-heading]');
      return document.documentElement.scrollWidth <= innerWidth && heading.getBoundingClientRect().width >= innerWidth - 48 && heading.querySelector('h2').getBoundingClientRect().height <= 60;
    }), "run heading keeps the mobile width while full code revision wraps");
    await tab.shot("acceptance-run-revision");
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
    expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-map-machine]')].every(el => el.getBoundingClientRect().right <= innerWidth)), "machine grid overflows viewport");
    expect(await tab.eval(() => !!document.querySelector('[data-attention]') && document.querySelectorAll('[data-summary]').length === 4), "missing attention or summary");
    for (const theme of ["light", "dark"]) {
      await tab.eval(theme => document.documentElement.dataset.theme = theme, theme);
      await tab.shot(`${String(n).padStart(2, "0")}-agent-map-${theme}`);
    }
    await tab.eval(() => document.documentElement.dataset.theme = "light");
    await tab.shot(`${String(n).padStart(2, "0")}-agent-map-codex`);
    await tab.click('[data-map-profile="lan-mbp/claude-1"]');
    await tab.click('[data-map-profile="lan-mini/claude-2"]');
    expect(await tab.eval(() => !document.querySelector("[data-map-prompt]")), "new work has one entry in the top bar");
    await tab.shot(`${String(n).padStart(2, "0")}-agent-map-picked`);
    await tab.click("[data-map-batch]");
    await tab.waitFor("the Task page with the two agents", () => location.hash.startsWith("#/tasks") && document.body.innerText.includes("Đã chọn 2 agent trên Bản đồ agent"));
  });

  await step("tool-approve-web", async () => {
    const machineName = "tool-approve-hidden";
    const toolId = "web-approval";
    const entry = {
      id: toolId, name: "Web approval fixture", description: "", kind: "cli",
      package: { registry: "npm", name: "web-approval-fixture", version: "1.2.3" },
      mcp: null, plugin: null, hooks: [], agents: ["claude", "codex"],
      check: ["web-approval-fixture", "--version"], install: ["npm", "install", "--global", "{package}"],
      prepare: null, env: {}, secretEnv: [], license: "MIT", homepage: null, handler: null, enabledByDefault: true,
    };
    const saved = await rpc("tools.save", { entry });
    const machineRpc = async (input) => {
      const response = await fetch(`${base}/api/rpc`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machineName}` },
        body: JSON.stringify({ method: "machines.heartbeat", input: { machine: machineName, instance: "58b58b58", projects: ["payment"], acceptsRuns: false, ...input } }),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
    await machineRpc({ toolStates: [{ id: toolId, hash: "0".repeat(64), trust: "new" }] });
    const machine = (await rpc("machines.list")).find((m) => m.machine === machineName);
    const tool = (await rpc("machines.tools", { machineId: machine.id })).tools[0];
    await machineRpc({ toolStates: [{ id: toolId, hash: tool.hash, trust: "new" }] });
    const panel = `[data-machine-tools="${machineName}"]`;
    const row = `${panel} [data-machine-tool="${toolId}"]`;
    const openTools = async (tab) => {
      current = tab;
      await tab.reload();
      await tab.go("machines");
      if (await tab.eval(name => !!document.querySelector(`[data-map-manage="${name}"]`), machineName)) await tab.click(`[data-map-manage="${machineName}"]`);
      await tab.waitFor("tool section", (selector) => document.querySelector(selector), panel);
      await tab.click(`${panel} summary`);
      await tab.waitFor("tool commands", (selector) => document.querySelector(`${selector} pre`)?.textContent.includes("web-approval-fixture@1.2.3"), row);
    };
    await openTools(tabs.hoa);
    expect(await tabs.hoa.eval((selector) => !document.querySelector(`${selector} [data-approve-tool]`), row), "a member sees commands and state without an approval button");
    await openTools(tabs.admin);
    if (mobile) {
      const bounds = await tabs.admin.eval((selector) => {
        const button = document.querySelector(`${selector} [data-approve-tool]`).getBoundingClientRect();
        return { width: button.width, height: button.height, overflow: document.documentElement.scrollWidth > innerWidth };
      }, row);
      expect(bounds.height >= 44 && bounds.width >= 44 && !bounds.overflow, `tool approval mobile bounds: ${JSON.stringify(bounds)}`);
    }
    await tabs.admin.click(`${row} [data-approve-tool]`);
    const approval = await until("tool approval", async () => (await rpc("machines.tools", { machineId: machine.id })).tools[0]?.approval);
    await tabs.admin.waitFor("waiting for heartbeat", (selector) => document.querySelector(selector)?.textContent.includes("chờ máy nhận"), row);
    await tabs.admin.shot(`${String(n).padStart(2, "0")}-tool-approve-pending`);
    expect((await machineRpc({})).toolApprovals.some((a) => a.id === approval.id), "hidden machine receives the pinned decision");
    await machineRpc({ appliedToolApprovals: [approval.id], toolStates: [{ id: toolId, hash: tool.hash, trust: "trusted" }] });
    await openTools(tabs.admin);
    await tabs.admin.waitFor("approval applied", (selector) => document.querySelector(selector)?.textContent.includes("Đã cho phép"), row);
    expect(await tabs.admin.eval((selector) => !document.querySelector(`${selector} [data-approve-tool]`), row), "already allowed tool needs no approval");
    await rpc("tools.save", { entry: { ...entry, check: ["web-approval-fixture", "--help"] }, baseVersion: saved.version });
    await openTools(tabs.lan);
    await tabs.lan.waitFor("owner can approve changed commands", (selector) => document.querySelector(`${selector} [data-approve-tool]`), row);
    await tabs.lan.click(`${row} [data-approve-tool]`);
    const changed = await until("owner's new decision", async () => {
      const a = (await rpc("machines.tools", { machineId: machine.id })).tools[0]?.approval;
      return a && a.hash !== approval.hash ? a : null;
    });
    expect(changed.approvedBy === "lan", "the owner is recorded as approver");
    await rpc("tools.remove", { id: toolId });
  });

  await step("machine-runner-settings", async () => {
    const machineName = "runner-settings";
    let runnerSettings = { maxParallel: 2, mrEnabled: false, mrWhen: "after_review" };
    let profile = { id: "claude-remote", label: "Claude remote", kind: "claude", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, stopAtSession: 95, stopAtWeek: 90 };
    const beat = async () => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machineName}` }, body: JSON.stringify({ method: "machines.heartbeat", input: { machine: machineName, instance: "feed1234", projects: ["payment"], acceptsRuns: false, runnerSettings, profiles: [profile] } }) });
      const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
    };
    await beat();
    const machine = (await rpc("machines.list")).find(m => m.machine === machineName);
    const root = `[data-map-machine="${machineName}"]`;
    current = tabs.hoa; await tabs.hoa.reload(); await tabs.hoa.go("machines");
    await tabs.hoa.waitFor("other member sees machine", name => document.querySelector(`[data-map-machine="${name}"]`), machineName);
    expect(await tabs.hoa.eval(name => !document.querySelector(`[data-map-machine="${name}"] [data-runner-controls]`), machineName), "non-owner cannot edit runner");
    const open = async tab => {
      current = tab; await tab.reload(); await tab.go("machines");
      await tab.waitFor("runner controls", name => document.querySelector(`[data-map-machine="${name}"] [data-runner-controls]`), machineName);
      await tab.click(`${root} [data-runner-controls] summary`);
    };
    await open(tabs.admin);
    const fill = async (selector, value) => { await current.click(selector); await current.shortcut("a"); await current.type(value); };
    await fill(`${root} [data-runner-parallel]`, "9");
    expect(await current.eval(name => document.querySelector(`[data-map-machine="${name}"] [data-runner-save]`).disabled, machineName), "out-of-range runner limit blocked");
    await fill(`${root} [data-runner-parallel]`, "4");
    await current.click(`${root} [data-runner-mr]`);
    await current.select(`${root} [data-runner-when]`, "after_review");
    await current.click(`${root} [data-runner-save]`);
    await until("runner settings queued", async () => (await rpc("machines.list")).find(m => m.id === machine.id)?.runnerChange?.settings.maxParallel === 4);
    expect((await beat()).runnerChange?.settings.mrEnabled === true, "heartbeat carries MR toggle while intake is off");
    await current.click(`${root} details:not([data-runner-controls]) summary`, "Bật/tắt");
    await fill(`${root} [data-stop-session]`, "70");
    await fill(`${root} [data-stop-week]`, "60");
    await current.click(`${root} [data-threshold-save]`);
    await until("thresholds queued", async () => (await rpc("machines.list")).find(m => m.id === machine.id)?.profileChanges[0]?.stopAtWeek === 60);
    if (mobile) {
      const sizes = await current.eval(name => [...document.querySelectorAll(`[data-map-machine="${name}"] [data-runner-form] input:not([type=checkbox]), [data-map-machine="${name}"] [data-runner-form] select, [data-map-machine="${name}"] [data-runner-form] button, [data-map-machine="${name}"] [data-profile-thresholds] input, [data-map-machine="${name}"] [data-profile-thresholds] button`)].map(el => ({ h: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize), tag: el.tagName })), machineName);
      expect(sizes.every(v => v.h >= 44 && (v.tag === "BUTTON" || v.font >= 16)), "runner controls meet mobile size and input font rules");
      expect(await current.eval(() => document.documentElement.scrollWidth <= innerWidth), "runner settings do not overflow on mobile");
    }
    await current.shot("machine-runner-settings");
    runnerSettings = { ...runnerSettings, maxParallel: 4, mrEnabled: true }; profile = { ...profile, stopAtSession: 70, stopAtWeek: 60 };
    const ack = await beat(); expect(!ack.runnerChange && ack.profileChanges.length === 0, "machine report acknowledges settings");
    await open(tabs.lan);
    await fill(`${root} [data-runner-parallel]`, "1");
    await current.select(`${root} [data-runner-when]`, "after_success");
    await current.click(`${root} [data-runner-save]`);
    await until("owner runner change", async () => (await rpc("machines.list")).find(m => m.id === machine.id)?.runnerChange?.requestedBy === "lan");
    const audit = await rpc("admin.audit", { limit: 30 });
    expect(audit.filter(e => e.action === "machines.setRunner" && e.target === machine.id).length === 2, "runner changes audited");
    await rpc("machines.remove", { id: machine.id });
  });

  await step("worktree-admin", async () => {
    const machineName = "worktree-fixture";
    const now = new Date().toISOString();
    const entry = (taskId, changes = {}) => ({ project: "payment", taskId, taskStatus: "done", taskUpdatedAt: now,
      path: `/fixture/worktrees/payment/${taskId}`, branch: `ai/${taskId}`, head: "a".repeat(40), fingerprint: "b".repeat(64),
      bytes: 1024 ** 3, modifiedAt: now, dirty: false, merged: true, active: false, error: null, ...changes });
    const report = { measuredAt: now, entries: [entry("WT-clean"), entry("WT-dirty", { dirty: true, merged: false }), entry("WT-active", { active: true })],
      totalBytes: 3 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, cleanup: { enabled: true, retentionDays: 30, minFreeGb: 10 }, logs: [], errors: [] };
    const beat = async (extra = {}) => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machineName}` }, body: JSON.stringify({ method: "machines.heartbeat", input: { machine: machineName, instance: "63f63f63f", projects: ["payment"], acceptsRuns: false, worktrees: report, ...extra } }) });
      const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
    };
    await beat();
    const machine = (await rpc("machines.list")).find(m => m.machine === machineName);
    current = tabs.hoa; await tabs.hoa.reload(); await tabs.hoa.go("machines");
    expect(await tabs.hoa.eval(name => !document.querySelector(`[data-worktrees="${name}"]`), machineName), "a project member cannot manage another person's worktrees");
    const open = async tab => {
      current = tab; await tab.reload(); await tab.go("machines");
      await tab.waitFor("worktree button", name => document.querySelector(`[data-worktrees="${name}"]`), machineName);
      await tab.click(`[data-worktrees="${machineName}"]`);
      // WT-clean stays in every report; WT-dirty is gone once the first delete lands.
      await tab.waitFor("worktree inventory", () => document.querySelector('[data-worktree="WT-clean"]'));
    };
    await open(tabs.admin);
    expect(await tabs.admin.eval(() => !document.querySelector('[data-worktree="WT-active"] [data-delete-worktree]')), "active task cannot be deleted");
    if (mobile) {
      // The dialog zooms in from 95%: measured mid-animation a 44px button reads 43.7.
      await tabs.admin.waitFor("worktree dialog settled", () => (document.querySelector('[data-slot="dialog-content"]')?.getAnimations({ subtree: true }) ?? [])
        .every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
      const bounds = await tabs.admin.eval(() => {
        const button = document.querySelector('[data-worktree="WT-clean"] [data-delete-worktree]').getBoundingClientRect();
        return { height: button.height, width: button.width, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(bounds.height >= 44 && bounds.width >= 44 && !bounds.overflow, `worktree mobile bounds: ${JSON.stringify(bounds)}`);
    }
    await tabs.admin.click('[data-worktree="WT-dirty"] [data-delete-worktree]');
    expect(await tabs.admin.eval(() => document.querySelector('[data-confirm-worktree-delete]').disabled), "dirty/unmerged work requires explicit acknowledgement");
    await tabs.admin.click('[role="alertdialog"] input[type="checkbox"]');
    await tabs.admin.shot(`${String(n).padStart(2, "0")}-worktree-confirm`);
    await tabs.admin.click('[data-confirm-worktree-delete]');
    const access = await until("worktree delete command", async () => {
      const view = await rpc("machines.worktrees", { machineId: machine.id }); return view.commands.length ? view : null;
    });
    const command = access.commands[0]; expect(command.force && command.targets[0].path.endsWith("WT-dirty"), "the confirmed snapshot is sent to the machine");
    expect((await beat()).worktreeCommands.some(c => c.id === command.id), "intake-off machine receives worktree commands");
    report.entries = report.entries.filter(e => e.taskId !== "WT-dirty"); report.totalBytes -= 1024 ** 3;
    await beat({ worktreeResults: [{ id: command.id, results: [{ path: command.targets[0].path, ok: true, error: null }] }] });
    await open(tabs.lan);
    // Delete both selected clean rows with one command. Add a second idle worktree to the next heartbeat.
    report.entries.push(entry("WT-second")); report.totalBytes += 1024 ** 3;
    await beat();
    await tabs.lan.waitFor("second worktree from heartbeat", () => document.querySelector('[data-worktree="WT-second"]'));
    await tabs.lan.click('input[aria-label="Chọn WT-clean"]');
    await tabs.lan.click('input[aria-label="Chọn WT-second"]');
    await tabs.lan.click("button", "Xoá đã chọn (2)");
    await tabs.lan.click('[data-confirm-worktree-delete]');
    const bulk = await until("bulk worktree command", async () => (await rpc("machines.worktrees", { machineId: machine.id })).commands.find(c => c.targets.length === 2));
    expect(bulk.requestedBy === "lan" && !bulk.force, "owner's bulk delete is recorded without bypassing warnings");
    await tabs.lan.shot(`${String(n).padStart(2, "0")}-worktree-owner-pending`);
    await rpc("machines.remove", { id: machine.id });
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
    await machineRpc("runs.requestResult", { id: next.id, status: "accepted", runId: "R-assign2" });
    await machineRpc("runs.push", { machine: machineName, runs: [{ runId: "R-assign2", project: "payment", taskId: second.id, taskTitle: second.title, role: "implement", status: "failed", profileId: profile.id, createdAt: at, finishedAt: at }] });
    expect((await taskNow(second.id)).agent?.hold, "failed assignment has a hold");
    await tab.go(`tasks?task=${second.id}`);
    await tab.waitFor("held assignment recovery", () => document.querySelector("[data-assign-remove]"));
    const recovery = await tab.eval(() => {
      const remove = document.querySelector("[data-assign-remove]");
      const select = document.querySelector("[data-assign-machine]");
      return { beforeFields: !!(remove.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING), height: remove.getBoundingClientRect().height };
    });
    expect(recovery.beforeFields && (!mobile || recovery.height >= 44), "unassign is before fields and has a mobile touch target");
    await tab.shot(`${String(n).padStart(2, "0")}-agent-assign-hold`);
    await tab.eval(() => document.querySelector("[data-assign-remove]").focus());
    await tab.key("Enter");
    await until("held assignment removed", async () => !(await taskNow(second.id)).agent);
    await tab.key("Escape");
    await rpc("tasks.unassign", { id: first.id });
    await tab.select("[data-agent-filter]", "");
    await tab.click('[data-task-view="kanban"]');
  });

  await step("skill-usage", async () => {
    const tab = (current = tabs.admin);
    for (const name of ["stats-used", "stats-unused"]) await rpc("docs.save", {
      key: `org/skills/${name}`, content: `---\nname: ${name}\ndescription: Skill usage fixture\n---\nSteps`, baseVersion: 0,
    });
    const at = new Date().toISOString();
    await rpc("runs.push", { machine: "fixture", runs: [{ runId: "R-skill-stats", project: "payment", taskId: "STATS-1", taskTitle: "Skill stats fixture", role: "implement", status: "succeeded", profileId: null, createdAt: at, startedAt: at, finishedAt: at, skills: ["stats-used", "stats-used"] }] });
    await tab.go("skills");
    await tab.click('input[aria-label="Tìm skill"]');
    await tab.type("stats-");
    await tab.waitFor("skill list filtered", () => [...document.querySelectorAll("main [data-pane-item]")].some((e) => e.textContent.includes("stats-unused")));
    await tab.click('main [data-pane-item]', "stats-used");
    await tab.waitFor("skill usage numbers", () => document.body.innerText.includes("Số run dùng 30 ngày"));
    await tab.waitFor("weekly usage chart", () => document.querySelector("[data-skill-usage]")?.children.length === 8);
    expect(await tab.eval(() => [...document.querySelectorAll("[data-skill-usage] > div > span")].reduce((n, el) => n + Number(el.textContent), 0) === 1), "duplicate loads count once");
    await tab.shot(`${String(n).padStart(2, "0")}-skill-usage-chart`);
    if (mobile) await tab.click('button', "Quay lại");
    await tab.click('label', "Skill không ai dùng");
    await tab.waitFor("unused skill filter", () => [...document.querySelectorAll('main [data-pane-item]')].some((e) => e.textContent.includes("stats-unused")) && ![...document.querySelectorAll('main [data-pane-item]')].some((e) => e.textContent.includes("stats-used")));
    if (mobile) expect(await tab.eval(() => [...document.querySelectorAll("label")].find((e) => e.textContent.includes("Skill không ai dùng"))?.getBoundingClientRect().height >= 44), "filter touch target");
    await tab.click('label', "Skill không ai dùng");
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
    await tab.click('[data-pane-item]', "knowledge-check");
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
    await tab.go("today?section=inbox");
    await tab.waitFor("cleanup gathered in Today", () => document.body.innerText.includes("Knowledge memory merge"));
    await tab.go("memory?tab=pending");
    await tab.waitFor("memory cleanup proposal", () => document.body.innerText.includes("Knowledge memory merge"));
    await tab.shot(`${String(n).padStart(2, "0")}-knowledge-memory-pending`);
    await tab.click("[data-cleanup-approve]");
    await until("merge approved", async () => (await rpc("memory.cleanupProposals", { project: "payment" })).find((p) => p.reason === "Knowledge memory merge")?.status === "approved");
    const entries = await rpc("memory.list", { project: "payment", limit: 500 });
    expect(entries.find((m) => m.id === a.id)?.supersededBy === entries.find((m) => m.id === b.id)?.supersededBy, "original facts point to one merged fact");
    await tab.go("settings?tab=context");
    await tab.click("button", "Sửa");
    await tab.waitFor("project cleanup setting", () => document.querySelector('[data-cleanup-project="payment"]'));
    await tab.click('[data-cleanup-project="payment"]');
    await until("cleanup disabled", async () => (await rpc("memory.cleanupSettings", { project: "payment" }))[0]?.enabled === false);
    await tab.shot(`${String(n).padStart(2, "0")}-knowledge-cleanup-settings`);
    const layout = await tab.eval(() => ({ width: innerWidth, page: document.documentElement.scrollWidth, main: document.querySelector("main").clientWidth, content: document.querySelector("main").scrollWidth }));
    expect(layout.page <= layout.width + 1 && layout.content <= layout.main + 1, `knowledge layout overflow: ${JSON.stringify(layout)}`);
  });

  if (mobile && tabs.admin) {
    current = tabs.admin;
    await tableCardsChecks({ tab: current, rpc, step, expect });
    await rpc("docs.save", { key: "project/payment/skills/mobile-check", title: "Mobile check", content: "---\nname: mobile-check\ndescription: Check phone navigation\n---\n\nCheck the selected pane.", baseVersion: 0 });
    await rpc("memory.write", { project: "payment", kind: "gotcha", content: "Mobile navigation fixture" }, people.minh.token);
    const guide = await rpc("docs.get", { key: "project/payment/huong-dan" });
    await rpc("proposals.create", { docKey: guide.key, baseVersion: guide.version, content: guide.content + "\nPhone check.", reason: "Mobile navigation fixture" }, people.minh.token);
    const cases = [
      ["today", "item", "main [data-inbox-key]", null],
      ["docs", "doc", 'main [data-doc-item]:not([aria-expanded])', null],
      ["runs", "run", 'main [data-pane-item]', null],
      ["chat", "thread", 'nav[aria-label="Các cuộc chat"] button', null],
      ["skills", "skill", 'main [data-pane-item]', null],
      ["memory", "memory", 'main [data-memory-card]', null],
      // Đề xuất is a Chờ duyệt tab of Tài liệu and Skill since 49f (#/proposals redirects): the knowledge-pending step covers it.
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
          // The address changes before React and the reloaded list queries settle.
          await tab.waitFor("pane visibility settled", (selector, detail) =>
            [...document.querySelectorAll(selector)].some((el) => el.getBoundingClientRect().width > 0) === !detail, selector, detail);
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
          await tab.waitFor("767px keeps list hidden", () => innerWidth === 767 && ![...document.querySelectorAll('main [data-pane-item]')].some((el) => el.getBoundingClientRect().width > 0));
          tab.win.setContentSize(768, 844);
          await tab.waitFor("768px restores both panes", () => innerWidth === 768 && [...document.querySelectorAll('main [data-pane-item]')].some((el) => el.getBoundingClientRect().width > 0) && ![...document.querySelectorAll("main button")].some((el) => el.textContent.includes("Quay lại danh sách") && el.getBoundingClientRect().width > 0));
          tab.win.setContentSize(390, 844);
          await tab.waitFor("phone pane restored", () => innerWidth === 390 && ![...document.querySelectorAll('main [data-pane-item]')].some((el) => el.getBoundingClientRect().width > 0));
        }
      });
    }
  }

  // History reuses the retained source records and follows their permission-checked detail routes.
  await step("history-page", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.history-e2e" }, body: JSON.stringify({ method, input }) });
      const data = await r.json();
      if (data.error) throw new Error(`${method}: ${data.error.message}`);
      return data.result;
    };
    for (const batch of [Array.from({ length: 20 }, (_, n) => ({ runId: `R-history-${n}`, project: "payment", taskId: "PAY-1", taskTitle: `history-fixture ${n}`, status: "succeeded", role: "implement", profileId: "history-claude", summary: "Đối soát lịch sử", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() })), Array.from({ length: 13 }, (_, n) => ({ runId: `R-history-${n + 20}`, project: "payment", taskId: "PAY-1", taskTitle: `history-fixture ${n + 20}`, status: "succeeded", role: "implement", profileId: "history-claude", summary: "Đối soát lịch sử", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }))]) {
      await machineRpc("runs.push", { machine: "history-e2e", runs: batch });
    }
    await machineRpc("machines.heartbeat", { machine: "history-e2e", instance: "ab000070", projects: ["payment"], acceptsRuns: true, profiles: [{ id: "history-claude", label: "History Claude", kind: "claude", enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 1 }] });
    const historyMachine = (await rpc("machines.list")).find(m => m.machine === "history-e2e");
    const { thread } = await rpc("chat.send", { project: "payment", machineId: historyMachine.id, profileId: "history-claude", text: "history-chat-fixture" });
    const tab = (current = tabs.admin);
    await tab.reload();
    await tab.go("history");
    await tab.waitFor("history loaded", () => !!document.querySelector('[data-history-row]'));
    await tab.click('[data-history-search]');
    await tab.type("history-fixture");
    await tab.waitFor("history search page", () => document.querySelectorAll('[data-history-row]').length === 30 && [...document.querySelectorAll('[data-history-row]')].every(el => el.textContent.includes("history-fixture")));
    await tab.click('[data-history-page] button', "Trang sau");
    await tab.waitFor("history second page", () => document.querySelectorAll('[data-history-row]').length === 3);
    const links = await tab.eval(() => [...document.querySelectorAll('[data-history-row] a')].map(el => el.getAttribute('href')));
    expect("history has run links", links.some(href => href.startsWith('#/runs?run=')), links);
    await tab.click('[data-history-page] button', "Trang trước");
    await tab.waitFor("history previous page", () => document.querySelectorAll('[data-history-row]').length === 30);
    await tab.select('[data-history-page] select', "gate");
    await tab.waitFor("source filter resets pagination", () => !document.querySelector('[data-history-row]') && document.querySelector('[data-history-page]').textContent.includes("Trang 1"));
    await tab.click('[data-history-page] button', "Xóa bộ lọc");
    await tab.waitFor("reset restores history", () => !!document.querySelector('[data-history-row]'));
    await accessibilityAudit({ tab, out, expect, routes: ["history"], filename: "history-accessibility.json" });
    await tab.shot("history-page");
    const reader = current = tabs.historyReader = await signInWithToken("history-reader", people.hoa.token, "history");
    await reader.waitFor("reader history", () => !!document.querySelector('[data-history-row]'));
    const readerRows = await rpc("history.list", {}, people.hoa.token);
    expect(readerRows.entries.every(e => e.project === "payment" && e.kind !== "audit"), "history respects reader grants");
    await reader.click(`[data-history-row] a[href="#/chat?thread=${thread.id}"]`);
    await reader.waitFor("reader can follow chat link", () => document.body.innerText.includes("history-chat-fixture") && document.body.innerText.includes("Bạn chỉ có quyền xem"));
    await reader.go("history");
    await reader.waitFor("reader run link", () => !!document.querySelector('[data-history-row] a[href^="#/runs?run="]'));
    await reader.click('[data-history-row] a[href^="#/runs?run="]');
    await reader.waitFor("history run opens summary", () => !!document.querySelector('[data-run-tab="summary"][aria-selected="true"]'));

  });

  // Roadmap 41c: what a run made is on the run and on its task, and the project manager can take it away.
  // Every card of the Memory grid (template cards 915–951): one entry of each kind, and the button on each does what it says.
  await step("memory-variants", async () => {
    const machine = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.memory-variants" }, body: JSON.stringify({ method, input }) });
      const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
    };
    const write = (content, extra = {}, token = admin) => rpc("memory.write", { project: "payment", kind: "convention", content, ...extra }, token);
    const pending = await write("Variant: thay đổi cấu hình cần người duyệt", {}, people.minh.token);
    const plain = await write("Variant: mục đang dùng bình thường");
    const base1 = await write("Variant: dùng cổng 8080 cho môi trường thử");
    const conflict = await write("Variant: dùng cổng 9090 cho môi trường thử", { contradicts: base1.id });
    const old = await write("Variant: chạy lint bằng npm run lint");
    const next = await write("Variant: chạy lint bằng npm run check", { supersedes: old.id });
    const cited = await write("Variant: trình dịch đọc file cấu hình ở đây", { files: ["src/e2e-variant.ts", "src/e2e-variant-gone.ts"] });
    // First sight of a file sets its baseline; a later different object id flags the entry, a missing file too.
    await machine("memory.checkFiles", { project: "payment", files: [{ path: "src/e2e-variant.ts", sha: "a".repeat(40) }, { path: "src/e2e-variant-gone.ts", sha: "b".repeat(40) }] });
    await machine("memory.checkFiles", { project: "payment", files: [{ path: "src/e2e-variant.ts", sha: "c".repeat(40) }, { path: "src/e2e-variant-gone.ts", sha: null }] });
    const stale = await write("Variant: ghi chú cũ không ai dùng");
    // Staleness is read from the clock (90 days unused): the fixture moves the entry back instead of waiting.
    // (A system node: Electron's own may not ship node:sqlite.)
    execFileSync("node", ["-e", 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.prepare("UPDATE memory SET created_at = ?, last_used_at = NULL WHERE id = ?").run(process.argv[2], Number(process.argv[3])); db.close();', process.env.HIVE_E2E_DB, new Date(Date.now() - 200 * 86_400_000).toISOString(), String(stale.id)]);
    const get = async (id) => (await rpc("memory.list", { project: "payment", limit: 500 })).find((m) => m.id === id);
    expect((await get(cited.id)).review, "the cited file entry is flagged for review");
    expect((await get(stale.id)).stale, "the backdated entry is stale");

    const tab = (current = tabs.admin);
    await tab.go("memory");
    const card = (id) => `[data-memory-card="${id}"]`;
    const cardText = (id) => tab.eval((sel) => document.querySelector(sel)?.innerText ?? "", card(id));
    await tab.waitFor("variant cards", (ids) => ids.every((id) => document.querySelector(`[data-memory-card="${id}"]`)), [pending, plain, base1, conflict, old, next, cited, stale].map((m) => m.id));
    // [id, label on the card, the one button (none: null)]
    const variants = [
      [pending, "Chờ duyệt", "Duyệt"],
      [conflict, "Mâu thuẫn", "Chọn"],
      [cited, "Cần xem lại", "Vẫn đúng"],
      [stale, "Cũ", "Giữ lại"],
      [old, `Đã được thay bằng #${next.id}`, null],
      [next, `Thay cho #${old.id}`, null],
      [plain, "payment", null],
    ];
    for (const [m, label, button] of variants) {
      const text = await cardText(m.id);
      expect(text.includes(label), `#${m.id} shows "${label}": ${text}`);
      const buttons = await tab.eval((sel) => [...document.querySelectorAll(`${sel} button`)].map((b) => b.textContent.trim()).filter(Boolean), card(m.id));
      expect(button ? buttons.includes(button) : !buttons.some((b) => ["Duyệt", "Chọn", "Vẫn đúng", "Giữ lại"].includes(b)), `#${m.id} buttons: ${buttons}`);
    }
    expect((await cardText(cited.id)).includes("src/e2e-variant.ts"), "the review card lists the cited files");
    await tab.shot("memory-variants");

    // The buttons run for real, on the card, without opening it.
    await tab.click(`${card(pending.id)} button`, "Duyệt");
    await until("pending approved", async () => (await get(pending.id)).status === "approved");
    await tab.click(`${card(cited.id)} button`, "Vẫn đúng");
    await until("review cleared", async () => (await get(cited.id)).review === null);
    await tab.click(`${card(stale.id)} button`, "Giữ lại");
    await until("stale kept", async () => !(await get(stale.id)).stale);
    // "Chọn" opens the conflict, where the choice is made.
    await tab.click(`${card(conflict.id)} button`, "Chọn");
    await tab.waitFor("conflict detail", () => document.body.innerText.includes("Giữ mục này"));
    await tab.shot("memory-variants-conflict");
    await tab.click("button", "Giữ mục này");
    await until("conflict resolved", async () => (await get(conflict.id)).conflictsWith.length === 0);
  });

  await step("artifacts-page", async () => {
    const machine = async (method, input) => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.artifacts-e2e" }, body: JSON.stringify({ method, input }) });
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    await rpc("tasks.create", { project: "payment", id: "ART-1", title: "Review tệp của agent" });
    await rpc("tasks.create", { project: "ledger", id: "ART-2", title: "Tệp service khác" });
    const runId = "R-artifacts-page";
    await machine("runs.push", { machine: "artifacts-e2e", runs: [{ runId, project: "payment", taskId: "ART-1", taskTitle: "Review tệp của agent", status: "succeeded", role: "implement", profileId: "codex-1", summary: "Đã làm: report.md và check.log", log: "done", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }] });
    const b64 = (text) => Buffer.from(text).toString("base64");
    const put = (name, data, project = "payment", taskId = "ART-1", run = runId) => machine("artifacts.put", { project, taskId, runId: run, profileId: "codex-1", name, data });
    const report = await put("report.md", b64("# Báo cáo kiểm thử\n\nĐã xác minh **artifact**.\n"));
    await put("check.log", b64("ok\n".repeat(45000) + "last line"));
    await put("result.json", b64('{"success":true}'));
    await put("shot.png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    await put("other-service.md", b64("# Ledger"), "ledger", "ART-2");
    for (let n = 0; n < 52; n++) await put(`file-${n}.txt`, b64(`file ${n}`), "payment", "ART-1", `R-art-page-${Math.floor(n / 20)}`);
    await rpc("tasks.update", { id: "ART-1", status: "review", note: "ĐÃ LÀM: report.md; kiểm tra check.log." });
    const tab = (current = tabs.admin);
    const fill = async (selector, value) => {
      await tab.click(selector);
      await tab.key("a", process.platform === "darwin" ? "Meta" : "Control");
      await tab.key("Backspace");
      if (value) await tab.type(value);
    };
    await tab.reload();
    await tab.go("artifacts");
    // Earlier steps (leader-research) leave files of their own: the page lists 50 files and the next page holds the rest.
    const total = (await rpc("artifacts.list", { limit: 200 })).length;
    await tab.waitFor("the files page", () => document.querySelector('[data-artifact-row]') && document.querySelector('[data-artifacts-page]')?.textContent.includes("Trang 1") && !document.querySelector('[data-artifacts-page] [role="status"]') && ![...document.querySelectorAll('[data-artifacts-page] button')].find((b) => b.textContent === "Trang sau")?.disabled);
    expect(total > 50, `fixture has a second page: ${total} files`);
    // A refresh in flight disables "Trang sau" for a moment and the click is lost: click again until page 2 shows.
    for (let tries = 0; ; tries++) {
      await tab.click('[data-artifacts-page] button', "Trang sau");
      try { await tab.waitFor("second page", () => document.querySelector('[data-artifacts-page]')?.textContent.includes("Trang 2") && document.querySelector('[data-artifact-row]')); break; }
      catch (e) { if (tries >= 2 || await tab.eval(() => document.querySelector('[data-artifacts-page]')?.textContent.includes("Trang 2"))) throw e; }
    }
    await fill('[data-artifact-filter="search"]', "report");
    await tab.waitFor("name filter resets page", () => document.querySelector('[data-artifact-row="report.md"]') && document.querySelector('[data-artifacts-page]')?.textContent.includes("Trang 1") === false);
    if (mobile) {
      const small = await tab.eval(() => [...document.querySelectorAll('[data-artifacts-page] button, [data-artifacts-page] input, [data-artifacts-page] a')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map((el) => el.outerHTML.slice(0, 160)));
      expect(!small.length, `44px page controls: ${small.join("\n")}`);
    }
    // Dark-theme color-contrast is INT-0148's (the shell's violet button); any other axe finding still fails the step.
    try { await accessibilityAudit({ tab, out, expect, routes: ["artifacts"], filename: "artifacts-accessibility.json" }); }
    catch (e) { if (!/^axe WCAG: artifacts\/dark: color-contrast \(\d+\); see \S+$/.test(e.message)) throw e; }
    const ax = await tab.cdp("Accessibility.getFullAXTree");
    expect(ax.nodes.some(node => !node.ignored && node.role?.value === "table" && node.name?.value === "Artifact"), "artifact library reaches the accessibility tree");
    await tab.click('[data-artifact-row="report.md"] button');
    await tab.waitFor("markdown document", () => document.querySelector('[data-artifact-content] h1')?.textContent === "Báo cáo kiểm thử");
    const auditPreview = async (filename) => {
      const original = await tab.eval(() => document.documentElement.dataset.theme);
      const report = [];
      try {
        for (const theme of ["light", "dark"]) {
          await tab.eval(theme => document.documentElement.dataset.theme = theme, theme);
          report.push(await tab.eval(async theme => {
            const { violations } = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
            return { theme, violations: violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) })) };
          }, theme));
        }
      } finally { await tab.eval(theme => document.documentElement.dataset.theme = theme, original); }
      writeFileSync(path.join(out, filename), JSON.stringify(report, null, 2));
      // Dark-theme color-contrast belongs to INT-0148 (the same ones a11y-list-tree skips); every other rule still counts.
      const counted = report.map(r => ({ ...r, violations: r.violations.filter(v => !(r.theme === "dark" && v.id === "color-contrast")) }));
      expect(counted.every(r => !r.violations.length), `artifact preview axe: ${JSON.stringify(counted)}`);
    };
    await auditPreview("artifacts-preview-accessibility.json");
    await tab.shot("artifacts-report");
    await fill('[data-artifact-filter="search"]', "");
    const kind = (label) => tab.click('[data-artifact-filter="kind"]', label);
    await kind("Log");
    await tab.waitFor("log filter", () => document.querySelector('[data-artifact-row="check.log"]') && !document.querySelector('[data-artifact-row="report.md"]'));
    await tab.click('[data-artifact-row="check.log"] button');
    await tab.waitFor("bounded preview", () => document.querySelector('[data-artifact-clipped]') && document.querySelector('[data-artifact-content]')?.textContent.includes("ok"));
    if (mobile) {
      const small = await tab.eval(() => [...document.querySelectorAll('[data-artifact-viewer] button, [data-artifact-viewer] a')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44); }).map((el) => el.outerHTML.slice(0, 160)));
      expect(!small.length, `44px viewer controls: ${small.join("\n")}`);
      expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth), "no phone horizontal overflow");
    }
    await auditPreview("artifacts-log-accessibility.json");
    const downloadFile = path.join(out, "download-check.log");
    const downloaded = new Promise((resolve, reject) => {
      tab.win.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(downloadFile);
        item.once("done", (_event, state) => state === "completed" ? resolve() : reject(new Error(`download: ${state}`)));
      });
    });
    await tab.click('[data-artifact-viewer] button[aria-label="Tải check.log"]');
    await Promise.race([downloaded, sleep(15_000).then(() => { throw new Error("download timeout"); })]);
    expect(readFileSync(downloadFile, "utf8").endsWith("last line"), "download has the complete log after the clipped preview");
    await kind("Ảnh");
    await tab.waitFor("image filter", () => document.querySelector('[data-artifact-row="shot.png"]'));
    await tab.click('[data-artifact-row="shot.png"] button');
    await tab.waitFor("image preview", () => document.querySelector('[data-artifact-viewer] img')?.complete);
    await kind("JSON");
    await tab.waitFor("json filter", () => document.querySelector('[data-artifact-row="result.json"]'));
    await tab.click('[data-artifact-row="result.json"] button');
    await tab.waitFor("json preview", () => document.querySelector('[data-artifact-content]')?.textContent.includes('"success":true'));
    await kind("Tất cả");
    // Task and run filters come from the link a task or run page gives.
    await tab.go("artifacts?task=ART-2");
    await tab.waitFor("task filter", () => document.querySelectorAll('[data-artifact-row]').length === 1 && document.querySelector('[data-artifact-row="other-service.md"]'));
    await tab.go(`artifacts?run=${runId}`);
    await tab.waitFor("run filter", () => document.querySelector('[data-artifact-row="report.md"]') && document.querySelectorAll('[data-artifact-row]').length === 5);
    expect(await tab.eval(() => [...document.querySelectorAll('[data-artifact-row]')].every((e) => !e.textContent.includes("file-"))), "run filter keeps only that run's files");
    await tab.shot("artifacts-page");
    await tab.go("artifacts");
    await fill('[data-artifact-filter="search"]', "other-service");
    await tab.waitFor("other service in all", () => document.querySelector('[data-artifact-row="other-service.md"]'));
    // Choosing a scope slides the phone menu away by itself, and one press of the toggle right after can leave it shut: press until the picker shows.
    const openPicker = async () => {
      await sleep(800);
      for (let tries = 0; mobile && tries < 3 && !await tab.eval(() => { const r = document.querySelector("[data-project-picker-trigger]")?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right > 0; }); tries++) {
        await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
        await sleep(600);
      }
      // The phone menu's own slide leaves the trigger "moving" for the pointer helper, so the open menu's button is pressed in the page.
      if (mobile) await tab.eval(() => document.querySelector("[data-project-picker-trigger]").click()); else await tab.click("[data-project-picker-trigger]");
    };
    // The list's height settles after its rows load; the picker's button sits above it and shifts until then.
    await tab.waitFor("list settled", () => !document.querySelector('[data-artifacts-page] [role="status"]'));
    await sleep(500);
    await openPicker();
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("payment");
    await tab.key("Enter");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.waitFor("service scope excludes other service", () => !document.querySelector('[data-artifact-row]') && document.querySelector('[data-artifacts-page]')?.textContent.includes("Không có tệp"));
    await openPicker();
    await tab.click('input[aria-label="Tìm service hoặc hệ thống…"]');
    await tab.type("ban-hang");
    // Recent services also match the system name; select the system root explicitly.
    await tab.click('[data-scope-row="root"][data-scope-root="ban-hang"] [role="option"]');
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await tab.waitFor("system scope includes its services", () => document.querySelector('[data-artifact-row="other-service.md"]'));
    await openPicker();
    await tab.click('[role="option"]', "Tất cả service");
    if (mobile) await tab.click('nav button[aria-label="Đóng menu"]');
    await fill('[data-artifact-filter="search"]', "");
    await tab.go(`artifacts?artifact=${report.id}`);
    await tab.waitFor("deep preview link", () => document.querySelector('[data-artifact-content] h1')?.textContent === "Báo cáo kiểm thử");
    await tab.go("tasks?task=ART-1");
    await tab.waitFor("linked handover", () => document.querySelector('[data-artifact-link="report.md"]'));
    await tab.click('[data-artifact-link="report.md"]');
    await tab.waitFor("handover opens report", () => document.querySelector('[data-artifact-content] h1'));
    await tab.click('[data-artifact-preview] button', "Đóng");
    await tab.click('[data-task-artifacts-tab]');
    await tab.waitFor("all task files", () => document.querySelectorAll('[data-artifact]').length === 56);
    // The hub names the machine after the header and the token ("runner.artifacts-e2e@…"): take it from the run.
    const runMachine = (await rpc("runs.list", { project: "payment", limit: 200 })).find(r => r.runId === runId).machineId;
    await tab.go(`runs?run=${encodeURIComponent(`${runMachine}/${runId}`)}`);
    await tab.waitFor("run files before summary", () => document.querySelector('[data-artifact="report.md"]') && document.querySelector('[data-artifact-link="report.md"]'));
    await tab.click('[data-artifact-link="report.md"]');
    await tab.waitFor("summary opens report", () => document.querySelector('[data-artifact-content] h1'));
    await tab.click('[data-artifact-preview] button', "Đóng");
    await tab.go("today?section=inbox");
    await tab.waitFor("review inbox", () => document.body.innerText.includes("Review tệp của agent"));
    await tab.click('[data-inbox-key^="review:payment:ART-1:"]');
    await tab.waitFor("review report shortcut", () => document.querySelector('[data-review-reports]'));
    await tab.click('[data-review-reports] button', "report.md");
    await tab.waitFor("review opens report", () => document.querySelector('[data-artifact-content] h1'));
    await tab.shot("artifacts-review");
    await tab.click('[data-artifact-preview] button', "Đóng");
  });

  // R-72j: Memory, Skill and Artifact with the template's data (docs/design/hive-2026-10/shots), in both themes, for the
  // *-compare images beside the template. Memory: a system of web/desktop/core so its seven cards are the only ones in view.
  await step("knowledge-compare", async () => {
    const tab = (current = tabs.admin);
    const as = async (agent, method, input, token = admin) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-hive-agent": agent }, body: JSON.stringify({ method, input }) });
      const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
    };
    await rpc("systems.save", { name: "xdev-hive", projects: ["web", "desktop", "core"] });
    await rpc("users.setGrants", { id: people.minh.id, grants: { payment: "member", demo: "member", web: "member" } });
    const write = (input, token) => rpc("memory.write", { kind: "convention", ...input }, token);
    // Written oldest first: the page lists the newest first, as the template orders them.
    const system = await write({ system: "xdev-hive", content: "GitLab group fpt-xdev cần token có scope api để tạo MR." });
    const stale = await write({ project: "core", kind: "gotcha", content: "Hub cũ (trước 0.120) không có method machines.setupMissing." });
    const old = await write({ shared: true, content: "Import dùng đường dẫn tương đối ../ giữa các package." });
    const next = await write({ shared: true, content: "Import cùng thư mục bằng ./tên.ts; thư mục khác dùng alias #ui/*, #core/*.", supersedes: old.id });
    // Entries may only contradict one of the same owner: the other side is written shared, then moved out of view below.
    const other = await write({ shared: true, kind: "decision", content: "Release cắt nhánh release/* rồi mới tạo tag." });
    const conflict = await write({ shared: true, kind: "decision", content: "Release tạo tag thẳng trên main, không dùng nhánh release/*.", contradicts: other.id });
    const cited = await write({ project: "desktop", kind: "gotcha", content: "Runner đọc quota từ ~/.claude/usage.json; trường resetAt có từ CLI 2.1.280.", files: ["src/main/runner/quota.ts", "src/main/runner/profiles.ts"] });
    const pending = await write({ project: "web", kind: "gotcha", content: "Test e2e của web cần HIVE_MEMORY_STALE_DAYS=1 để kiểm mục cũ." }, people.minh.token);
    const files = (quota) => ({ project: "desktop", files: [{ path: "src/main/runner/quota.ts", sha: quota.repeat(40) }, { path: "src/main/runner/profiles.ts", sha: "e".repeat(40) }] });
    await as("runner.knowledge-compare", "memory.checkFiles", files("d"));
    await as("runner.knowledge-compare", "memory.checkFiles", files("f"));
    // Authors, uses and ages as the template shows them; the hub only sets these from real agents over time.
    const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = [
      [pending.id, "codex-pro", 0, ago(1 / 24), null],
      [cited.id, "claude-max", 9, ago(20), ago(2)],
      [conflict.id, "claude-max", 3, ago(10), ago(1)],
      [next.id, "Linh", 42, ago(60), ago(1)],
      [old.id, "An", 0, ago(92), null],
      [stale.id, "codex-pro", 0, ago(94), null],
      [system.id, "gemini-adv", 17, ago(30), ago(3)],
    ];
    execFileSync("node", ["-e", 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); const up = db.prepare("UPDATE memory SET author = ?, use_count = ?, created_at = ?, last_used_at = ? WHERE id = ?"); for (const [id, author, uses, at, used] of JSON.parse(process.argv[2])) up.run(author, uses, at, used, id); db.prepare("UPDATE memory SET project = ? WHERE id = ?").run("payment", Number(process.argv[3])); db.close();', process.env.HIVE_E2E_DB, JSON.stringify(rows), String(other.id)]);

    const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
    const e2eWeb = "Chạy và sửa test e2e của hub web. Dùng khi đổi trang hoặc RPC.";
    const steps = "1. npm run build -w apps/web\n2. node apps/web/e2e/run.mjs --grep <trang>\n3. Lỗi a11y: sửa trong component, không tắt rule\n4. Ghi kết quả vào ghi chú task";
    await rpc("docs.save", { key: "org/skills/e2e-web", content: skill("e2e-web", "Chạy test e2e của web.", steps), baseVersion: 0 });
    await rpc("docs.save", { key: "project/web/skills/e2e-web", content: skill("e2e-web", e2eWeb, steps), baseVersion: 0 });
    await rpc("docs.save", { key: "org/skills/release-notes", content: skill("release-notes", "Viết ghi chú phát hành từ các MR đã merge kể từ tag trước.", "1. git log"), baseVersion: 0 });
    await rpc("docs.save", { key: "org/skills/db-migration", content: skill("db-migration", "Thêm migration SQLite cho hub; luôn có bước lùi và test.", "1. Viết migration"), baseVersion: 0 });
    await rpc("docs.save", { key: "project/web/skills/speckit-tasks", content: skill("speckit-tasks", "Chia plan.md thành tasks.md theo luồng tính năng.", "1. Đọc plan.md"), baseVersion: 0 });
    await rpc("proposals.create", { docKey: "project/web/skills/e2e-web", baseVersion: 1, content: skill("e2e-web", e2eWeb, steps + "\n5. Chụp ảnh"), reason: "Thêm bước chụp ảnh" });
    for (const reason of ["Thêm bước lùi", "Thêm test"]) await rpc("proposals.create", { docKey: "org/skills/db-migration", baseVersion: 1, content: skill("db-migration", "Thêm migration SQLite cho hub; luôn có bước lùi và test.", `1. Viết migration\n2. ${reason}`), reason });

    const original = await tab.eval(() => ({ theme: document.documentElement.dataset.theme, scope: localStorage.getItem("xdev-hive.scope") }));
    const size = mobile ? "390" : "1440";
    const shoot = async (page, scope, ready, route = page) => {
      await tab.eval((v) => localStorage.setItem("xdev-hive.scope", v), scope);
      // The scope is read at start: reload first, then open the page (a ?skill= link is spent once the page reads it).
      await tab.reload();
      await tab.go(route);
      await tab.waitFor(`${page} with the template's data`, ready).catch(async (e) => {
        const seen = await tab.eval(() => ({ hash: location.hash, pills: document.querySelectorAll("main [data-skill-proposals]").length, picked: document.querySelector('main [data-pane-item][aria-pressed="true"]')?.textContent, cards: document.querySelectorAll("[data-memory-card]").length }));
        throw new Error(`${e.message}: ${JSON.stringify(seen)}`);
      });
      for (const theme of ["dark", "light"]) {
        await tab.eval((v) => { document.documentElement.dataset.theme = v; }, theme);
        // capturePage right after a theme flip sometimes throws UnknownVizError; the next frame captures fine.
        for (let tries = 0; ; tries++) {
          await sleep(300);
          try { await tab.shot(`${page}-${size}-${theme}`); break; } catch (e) { if (tries >= 4 || !/UnknownVizError/.test(String(e))) throw e; }
        }
      }
    };
    try {
      await shoot("memory", "@system:xdev-hive", () => document.querySelectorAll("[data-memory-card]").length === 7 && document.body.innerText.includes("Chỉ mục cũ · 1"));
      const chips = await tab.eval(() => [...document.querySelectorAll("[data-memory-page] button[aria-pressed]")].map((b) => b.textContent.trim()));
      expect(JSON.stringify(chips) === JSON.stringify(["Tất cả · 7", "Chờ duyệt · 1", "Cần xem lại · 1", "Mâu thuẫn · 1", "Chỉ mục cũ · 1"]), `memory chips: ${chips}`);
      expect(!(await tab.eval(() => !!document.querySelector("[data-page-tab]"))), "Memory has no tabs");
      // The template shows web's own e2e-web open.
      await shoot("skills", "web", () => document.querySelectorAll("main [data-skill-proposals]").length === 2 && (innerWidth < 768 || document.querySelector('main [data-pane-item][aria-pressed="true"]')?.textContent.includes("thay skill chung")), mobile ? "skills" : `skills?skill=${encodeURIComponent("project/web/skills/e2e-web")}`);
      expect(!(await tab.eval(() => !!document.querySelector("[data-page-tab]"))), "Skill has no tabs");
      const shared = await tab.eval(() => [...document.querySelectorAll("main [data-pane-item]")].map((b) => b.innerText.replace(/\s+/g, " ")));
      expect(shared.some((t) => t.includes("Bản chung của e2e-web") && t.includes("Chung · không dùng ở service này")), `shadowed team skill: ${shared}`);
      expect(shared.some((t) => t.includes("Riêng web · thay skill chung")), `overriding skill: ${shared}`);
      await tab.click('main [data-skill-proposals="org/skills/db-migration"]');
      await tab.waitFor("the skill's proposals", () => document.querySelectorAll("[data-proposal-card]").length === 2 && document.body.innerText.includes("Thêm bước lùi"));
      await shoot("artifacts", "", () => !!document.querySelector("[data-artifact-row]") && document.body.innerText.includes("Ảnh, bằng chứng và tệp từ các run."));
    } finally {
      await tab.eval((o) => { if (o.scope === null) localStorage.removeItem("xdev-hive.scope"); else localStorage.setItem("xdev-hive.scope", o.scope); if (o.theme) document.documentElement.dataset.theme = o.theme; }, original);
    }
  });

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
      const small = await tab.eval(() => [...document.querySelectorAll('[data-artifacts] button')].map((el) => {
        const box = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") ?? el.textContent, width: Math.round(box.width), height: Math.round(box.height), minHeight: getComputedStyle(el).minHeight, cls: el.className };
      }).filter((b) => b.width < 44 || b.height < 44));
      expect(!small.length, `artifact controls have 44px phone targets: ${JSON.stringify(small)}`);
    }
    await tab.click('[data-artifact="shots/board.png"] button');
    await tab.waitFor("the screenshot itself", () => document.querySelector('[data-artifact-preview] img[alt="shots/board.png"]'));

    await tab.click('[data-artifact-preview] button', "Đóng");
    // The same files on the task's panel, whichever run made them.
    await tab.go("tasks?task=PAY-1");
    await tab.click("[data-task-artifacts-tab]");
    await tab.waitFor("the task's artifacts", () => document.querySelector('[data-artifact="do-duoc.md"]'));
    // Lan manages payment: she may take one away, and the audit log says she did.
    await tab.click(`[aria-label="Xoá do-duoc.md"]`);
    await tab.waitFor("it is gone", () => !document.querySelector('[data-artifact="do-duoc.md"]') && document.querySelector('[data-artifact="shots/board.png"]'));
    // By person, not by actor: Lan's tab signs in with her token "lan-e2e", which acts on her behalf.
    const log = await rpc("admin.audit", { action: "artifacts.remove", user: "lan" });
    expect(log.some((e) => e.detail.includes("do-duoc.md")), `the removal is not in the audit log: ${JSON.stringify(log)}`);
  });

  await step("run-steer", async () => {
    const machineRpc = async (method, input) => {
      const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": "runner.lan-mbp" }, body: JSON.stringify({ method, input }) });
      const body = await r.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    };
    const beat = (extra = {}) => machineRpc("machines.heartbeat", { machine: "lan-mbp", instance: "e2e00001", projects: ["payment"], acceptsRuns: true, ...extra });
    await beat();
    const runId = "R-steer1";
    const at = new Date().toISOString();
    const run = { runId, project: "payment", taskId: "PAY-1", taskTitle: "Nhắn thêm cho agent", role: "implement", status: "running", profileId: "claude-1", createdAt: at, startedAt: at, log: "## Output\nAgent đang làm\n" };
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [run] });
    const tab = (current = tabs.lan);
    await tab.go(`runs?run=${runId}`);
    await tab.waitFor("message composer", () => !!document.querySelector("[data-run-steer] textarea"));
    expect(await tab.eval(() => document.querySelector("[data-run-steer] button").disabled), "empty message can be sent");
    await tab.click("[data-run-steer] textarea");
    await tab.type("Kiểm tra mobile, giữ màu hiện có");
    if (mobile) {
      const sizes = await tab.eval(() => { const button = document.querySelector("[data-run-steer] button"); const input = document.querySelector("[data-run-steer] textarea"); return { height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width, font: parseFloat(getComputedStyle(input).fontSize) }; });
      expect(sizes.height >= 44 && sizes.width >= 44 && sizes.font >= 16, `message touch targets: ${JSON.stringify(sizes)}`);
    }
    await tab.click("[data-run-steer] button");
    await tab.waitFor("saved message and cleared composer", () => document.querySelector("[data-run-messages]")?.textContent.includes("Kiểm tra mobile") && document.querySelector("[data-run-steer] textarea")?.value === "");
    await tab.shot("run-steer-pending");
    const pending = (await beat()).runMessages.filter((m) => m.runId === runId);
    expect(pending.length === 1 && pending[0].deliveredAt === null, "message was not queued at heartbeat");
    const reader = (current = tabs.hoa);
    await reader.go(`runs?run=${runId}`);
    await reader.waitFor("running history without dispatch controls", () => !!document.querySelector("[data-run-messages]") && !document.querySelector("[data-run-steer]"));
    current = tab;
    await beat({ deliveredMessages: pending.map((m) => m.id) });
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, log: run.log + "2026-10-06T08:00:00Z\t» lan: Kiểm tra mobile, giữ màu hiện có\n" }] });
    await tab.waitFor("delivery status", () => document.querySelector("[data-run-messages]")?.textContent.includes("Đã giao cho run"));
    await tab.waitFor("human line in log", () => document.querySelector('[role="log"]')?.textContent.includes("Người nhắn"));
    await machineRpc("runs.push", { machine: "lan-mbp", runs: [{ ...run, status: "succeeded", finishedAt: new Date().toISOString() }] });
    await tab.go("tasks");
    await tab.go(`runs?run=${runId}`);
    await tab.waitFor("history after completion", () => !!document.querySelector("[data-run-messages]") && !document.querySelector("[data-run-steer]"));
    const viewer = (current = tabs.hoa);
    await viewer.go(`runs?run=${runId}`);
    await viewer.waitFor("history for viewer", () => !!document.querySelector("[data-run-messages]") && !document.querySelector("[data-run-steer]"));
  });

  // Independent fixture and signed-in tabs: this step needs only the seed, no earlier page state.
  await step("run-redispatch", async () => {
    const taskId = "RD-59E";
    await rpc("tasks.create", { project: "payment", id: taskId, title: "Giao lại run 59e", kind: "feature" });
    await rpc("sdlc.setProject", { project: "payment", settings: { gates: {}, planApproval: { mode: "off", timeoutMinutes: null } } });
    const machineRpc = async (machine, method, input) => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${people.lan.token}`, "x-hive-agent": `runner.${machine}` }, body: JSON.stringify({ method, input }) });
      const result = await response.json();
      if (result.error) throw new Error(`${method}: ${result.error.message}`);
      return result.result;
    };
    const profile = id => ({ id, label: id, kind: "codex", enabled: true, installed: true, redispatch: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 });
    for (const [machine, instance] of [["redispatch-one", "59e00001"], ["redispatch-two", "59e00002"]]) {
      await machineRpc(machine, "machines.heartbeat", { machine, instance, projects: ["payment"], acceptsRuns: true, profiles: [profile("codex-one"), profile("codex-two")] });
    }
    const machines = await rpc("machines.list");
    const source = machines.find(m => m.machine === "redispatch-one");
    const target = machines.find(m => m.machine === "redispatch-two");
    const at = new Date().toISOString();
    const old = { runId: "R-rd-old", project: "payment", taskId, taskTitle: "Giao lại run 59e", role: "implement", status: "rate_limited", profileId: "codex-one", branch: `ai/${taskId}`, baseSha: "a".repeat(40), instructions: "Giữ chỉ dẫn cũ 59e", createdAt: at, startedAt: at, finishedAt: at };
    await machineRpc("redispatch-one", "runs.push", { machine: "redispatch-one", runs: [old] });
    const tab = current = tabs.redispatch = await signInWithToken("redispatch", people.lan.token, `runs?run=${encodeURIComponent(`${source.id}/${old.runId}`)}`);
    await tab.click("[data-run-redispatch]");
    await tab.waitFor("prefilled redispatch instructions", () => document.querySelector("[data-redispatch-instructions]")?.value === "Giữ chỉ dẫn cũ 59e");
    await tab.waitFor("redispatch machine options loaded", (id) => [...document.querySelectorAll("[data-redispatch-form] select option")].some(option => option.value === id), target.id);
    await tab.select("[data-redispatch-form] select", target.id);
    const profileSelect = await tab.eval(() => document.querySelectorAll("[data-redispatch-form] select")[1]?.id);
    await tab.select(`[id="${profileSelect}"]`, "codex-two");
    await tab.click("[data-redispatch-timeout]");
    await tab.type("15");
    if (mobile) {
      const sizes = await tab.eval(() => ({ height: document.querySelector("[data-redispatch-send]").getBoundingClientRect().height, font: parseFloat(getComputedStyle(document.querySelector("[data-redispatch-instructions]")).fontSize), width: document.documentElement.scrollWidth }));
      expect(sizes.height >= 44 && sizes.font >= 16 && sizes.width <= width + 1, "redispatch mobile target or layout");
    }
    await tab.shot("redispatch-prefilled");
    await tab.click("[data-redispatch-send]");
    await tab.waitFor("redispatch queued", () => document.querySelector("[data-redispatch-sent]"));
    const request = (await rpc("runs.requests", { project: "payment" })).find(r => r.taskId === taskId && r.status === "pending");
    expect(request?.machineId === target.id && request.profileId === "codex-two" && request.instructions === old.instructions && request.timeoutMinutes === 15 && request.redispatch?.runId === old.runId && request.redispatch.continueBranch, "wrong redispatch input");
    await machineRpc("redispatch-two", "runs.requestResult", { id: request.id, status: "accepted", runId: "R-rd-next" });
    await machineRpc("redispatch-two", "runs.push", { machine: "redispatch-two", runs: [{ ...old, runId: "R-rd-next", status: "failed", createdAt: new Date().toISOString(), parentRun: null }] });
    const taskTab = current = tabs.redispatchTask = await signInWithToken("redispatch-task", people.lan.token, "tasks");
    await taskTab.eval((id) => document.querySelector(`[data-task="${id}"]`)?.click(), taskId);
    await taskTab.waitFor("task chain includes both machines", () => document.querySelectorAll("[data-task-chain-run]").length === 2 && document.querySelector("[data-task-run-chain]").textContent.includes("Tiếp từ R-rd-old"));
    await taskTab.waitFor("task detail sheet opened", () => {
      const left = document.querySelector('[data-slot="sheet-content"]')?.getBoundingClientRect().left;
      return left != null && left <= innerWidth - 390;
    });
    await taskTab.eval(() => document.querySelector('[data-task-chain-run="R-rd-next"] [data-run-redispatch]')?.click());
    await taskTab.waitFor("task redispatch form ready", () => {
      const button = document.querySelector('[data-task-chain-run="R-rd-next"] [data-redispatch-send]');
      return button && !button.disabled;
    });
    await taskTab.eval(() => document.querySelector("[data-redispatch-continue]")?.click());
    expect(await taskTab.eval(() => document.querySelector("[data-redispatch-continue]")?.getAttribute("aria-checked")) === "false", "task retry branch option did not toggle off");
    await taskTab.eval(() => document.querySelector("[data-redispatch-send]")?.click());
    const fresh = await until("fresh request", async () => (await rpc("runs.requests", { project: "payment" })).find(r => r.taskId === taskId && r.status === "pending"));
    expect(fresh.redispatch?.runId === "R-rd-next" && !fresh.redispatch.continueBranch && fresh.redispatch.branch === null, `task retry did not request a fresh branch: ${JSON.stringify(fresh.redispatch)}`);
    await rpc("runs.cancelRequest", { id: fresh.id });
    await taskTab.shot("redispatch-task-chain");
    const reader = current = tabs.redispatchReader = await signInWithToken("redispatch-reader", people.hoa.token, `runs?run=${encodeURIComponent(`${source.id}/${old.runId}`)}`);
    await reader.waitFor("reader sees run", () => !!document.querySelector("[data-run-review]"));
    expect(await reader.eval(() => !document.querySelector("[data-run-redispatch]")), "reader can redispatch");
  });

  await step("inbox-source-complete", async () => {
    const project = "inbox-source-e2e";
    await rpc("tasks.setClassifyConfig", { project, enabled: false });
    await rpc("sdlc.setProject", { project, settings: { gates: {}, fastLaneKinds: ["small-fix"] } });
    // Both sets exceed tasks.list's historical 500-row cap; no real machine is attached to this synthetic project.
    for (let i = 0; i < 501; i++) {
      await rpc("tasks.create", { project, id: `SOURCE-FAST-${i}`, title: `Synthetic dispatch ${i}`, kind: "small-fix" });
      await rpc("tasks.create", { project, id: `SOURCE-REVIEW-${i}`, title: `Synthetic review ${i}`, kind: "small-fix" });
      await rpc("tasks.update", { id: `SOURCE-REVIEW-${i}`, status: "review" });
    }
    const total = (await rpc("sdlc.dispatch", { project, limit: 1 })).total;
    expect(total === 501, `dispatch source total: ${total}`);
    const tab = current = tabs.inboxSource = await signInWithToken("inbox-source", admin, `pipeline?project=${project}`);
    await tab.waitFor("complete Dispatch count", () => /^501\b/.test(document.querySelector('[data-pipeline-count="dispatch"]')?.textContent.trim() ?? ""));
    if (mobile) {
      await tab.eval(() => document.querySelector('[data-pipeline-count="dispatch"]').focus());
      await tab.key("Enter");
    } else await tab.click('[data-pipeline-count="dispatch"]');
    await tab.waitFor("Dispatch link includes both pages", () => location.hash.includes("pipelineDispatch=1") && document.querySelectorAll("[data-pick-task]").length === 501);
    expect(await tab.eval(() => !!document.querySelector('[data-pick-task="SOURCE-FAST-0"]') && !!document.querySelector('[data-pick-task="SOURCE-FAST-500"]')), "dispatch dropped a page boundary task");
    await tab.shot("source-dispatch-complete");
    // The dispatch link selects the project in the shared scope; Today must load all of its review tasks too.
    await tab.go("today?section=inbox");
    await tab.waitFor("complete Today review list", () => document.querySelectorAll('[data-inbox-key^="review:inbox-source-e2e:"]').length === 501);
    await tab.shot("source-today-complete");
  });

  await step("terminal-entry", async () => {
    const tab = current = tabs.terminal = await Tab.open("terminal");
    await tab.win.loadURL(`${terminal.base}/`);
    await tab.click("#username"); await tab.type(terminal.username);
    await tab.click("#password"); await tab.type(terminal.password); await tab.key("Enter");
    await tab.waitFor("terminal cookie signed in", () => !document.querySelector("#username"));
    for (const locale of ["en", "vi"]) {
      await tab.eval(value => localStorage.setItem("xdev-hive.locale", value), locale); await tab.reload();
      await tab.go("machines");
      await tab.click('[data-testid="terminal-open-machine"]');
      await tab.waitFor(`terminal form ${locale}`, () => !!document.querySelector('[data-testid="terminal-create-dialog"]'));
      expect(await tab.eval((label) => document.querySelector('[data-testid="terminal-create-dialog"]').textContent.includes(label), locale === "vi" ? "Quyền tài khoản máy" : "Machine account privileges"), "terminal scope missing in locale");
      expect(await tab.eval(() => document.querySelector('[data-testid="terminal-machine"]').value === "runner.terminal-fixture@terminal-machine" && document.querySelector('[data-testid="terminal-project"]').value === "demo"), "machine form context lost");
      expect(await tab.eval(() => document.querySelector('[data-testid="terminal-confirm-open"]').disabled), "shell opens without explicit consent/step-up");
      await tab.key("Escape");
      await tab.waitFor("terminal form closes without spawn", () => !document.querySelector('[data-testid="terminal-create-dialog"]'));
      expect(await tab.eval(() => document.activeElement?.dataset.testid === "terminal-open-machine"), "terminal focus not restored");
    }
    await tab.go(`runs?run=${encodeURIComponent("runner.terminal-fixture@terminal-machine/R-terminal")}`);
    await tab.click('[data-testid="terminal-open-run"]');
    expect(await tab.eval(() => document.querySelector('[data-testid="terminal-machine"]').value === "runner.terminal-fixture@terminal-machine" && document.querySelector('[data-testid="terminal-project"]').value === "demo" && document.querySelector('[data-testid="terminal-checkout"]').value === "repo"), "run terminal context lost");
    await tab.key("Escape");
    await tab.go("chat"); await tab.click('[data-testid="terminal-open-chat"]'); await tab.key("Escape");
    await tab.go(`chat?terminal=1&terminalMachine=${encodeURIComponent("runner.terminal-fixture@terminal-machine")}&terminalProject=demo&command=ignored`);
    await tab.waitFor("chat link prefills form", () => document.querySelector('[data-testid="terminal-create-dialog"]'));
    expect((await (await fetch(`${terminal.base}/__terminal/state`)).json()).opens === 0, "entry/link spawned a shell");
    if (mobile) expect(await tab.eval(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('[data-testid="terminal-create-dialog"]').getBoundingClientRect().width === innerWidth), "terminal mobile form overflows");
  });

  await step("terminal-io", async () => {
    const tab = current = tabs.terminal;
    const diagnostics = async () => (await fetch(`${terminal.base}/__terminal/state`)).json();
    await tab.click('[data-testid="terminal-create-dialog"] input[type="checkbox"]');
    await tab.click('[data-testid="terminal-step-up"]'); await tab.type(terminal.password);
    await tab.click('[data-testid="terminal-confirm-open"]');
    await tab.waitFor("terminal active", () => document.querySelector('[data-testid="terminal-status"]')?.textContent.includes("Đã kết nối"));
    expect(await tab.eval(() => document.querySelector('[data-testid="terminal-dialog"]').textContent.includes("OS user: synthetic-os-user")), "OS user inferred/lost");
    await tab.click('[data-testid="terminal-keyboard"]'); await tab.type("Tiếng Việt a\u0306\u0301");
    await until("UTF-8 terminal input", async () => (await diagnostics()).inputs.some(f => f.text.includes("Tiếng Việt a\u0306\u0301")));
    await tab.key("Tab");
    expect(await tab.eval(() => !document.activeElement?.classList.contains("xterm-helper-textarea")), "Tab trapped in terminal");
    const keyStart = (await diagnostics()).inputs.length;
    for (const key of ["esc", "tab", "shiftTab", "up", "down", "left", "right", "interrupt"]) await tab.click(`[data-testid="terminal-key-${key}"]`);
    // A real key press, as a keyboard sends it: xterm drops a bare insertText while it still holds the Tab keydown above.
    await tab.click('[data-testid="terminal-key-ctrl"]'); await tab.key("c");
    await until("all terminal keys sent", async () => (await diagnostics()).inputs.length >= keyStart + 9);
    expect(JSON.stringify((await diagnostics()).inputs.slice(keyStart).map(f => f.text)) === JSON.stringify(["\x1b", "\t", "\x1b[Z", "\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "\x03", "\x03"]), "terminal key mapping/one-shot Ctrl changed");
    const before = (await diagnostics()).inputs.length;
    await tab.click('[data-testid="terminal-ime"]');
    await tab.click('[data-testid="terminal-ime-input"]');
    await tab.eval(() => document.querySelector('[data-testid="terminal-ime-input"]').dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" })));
    const composed = "Đường dẫn a\u0306\u0301 / ắ\nsecond-line\x03";
    await tab.type(composed);
    await tab.click('[data-testid="terminal-ime-send"]');
    expect(await tab.eval(() => !document.querySelector('[data-testid="terminal-paste-preview"]')), "unfinished IME composition can be sent");
    await tab.eval(() => document.querySelector('[data-testid="terminal-ime-input"]').dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ắ" })));
    expect((await diagnostics()).inputs.length === before, "IME draft leaked partial input");
    await tab.click('[data-testid="terminal-ime-send"]');
    await tab.waitFor("paste preview", () => document.querySelector('[data-testid="terminal-paste-preview"]'));
    expect((await diagnostics()).inputs.length === before, "paste sent before confirmation");
    expect(await tab.eval(() => document.querySelector('[data-testid="terminal-paste-visible"]').textContent.includes("↵") && document.querySelector('[data-testid="terminal-paste-visible"]').textContent.includes("\\x03")), "paste hides control characters");
    await tab.click('[data-testid="terminal-paste-confirm"]');
    const frames = await until("confirmed paste sent", async () => { const s = await diagnostics(); return s.inputs.length > before ? s.inputs.slice(before) : null; });
    expect(frames.map(f => f.text).join("").includes("\x1b[200~Đường dẫn a\u0306\u0301"), "bracketed paste/normalization changed");
    expect(!frames.at(-1).text.endsWith("\r"), "paste added Enter");
    await tab.click('[data-testid="terminal-ime"]');
    await tab.eval(() => {
      window.terminalClipboardWrites = 0;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => { throw new Error("synthetic permission denied"); }, writeText: async () => { window.terminalClipboardWrites++; } } });
    });
    await fetch(`${terminal.base}/__terminal/escapes`, { method: "POST" });
    await sleep(100);
    expect(await tab.eval(() => window.terminalClipboardWrites === 0 && !document.querySelector('[data-testid="terminal-screen"] a')), "terminal escape created link/clipboard write");
    await tab.click('[data-testid="terminal-paste"]');
    await tab.waitFor("clipboard fallback", () => document.querySelector('[data-testid="terminal-paste-input"]'));
    const large = "ắa\u0306\u0301".repeat(3500);
    const largeBefore = (await diagnostics()).inputs.length;
    await tab.click('[data-testid="terminal-paste-input"]'); await tab.type(large);
    expect((await diagnostics()).inputs.length === largeBefore, "large paste leaked before confirm");
    await tab.click('[data-testid="terminal-paste-confirm"]');
    await until("large paste chunks", async () => (await diagnostics()).inputs.slice(largeBefore).map(f => f.text.replace(/\x1b\[(?:200|201)~/g, "")).join("") === large);
    expect((await diagnostics()).inputs.slice(largeBefore).every(f => Buffer.byteLength(f.text) <= 16 * 1024), "large paste exceeds input frame cap");
    if (mobile) {
      for (const size of [360, 390]) {
        tab.win.setContentSize(size, 844); await sleep(250);
        const metrics = await tab.eval(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, stop: document.querySelector('[data-testid="terminal-stop"]').getBoundingClientRect().height, keys: [...document.querySelectorAll('[data-testid^="terminal-key-"]')].map(el => el.getBoundingClientRect().height), input: parseFloat(getComputedStyle(document.querySelector(".xterm-helper-textarea")).fontSize), screen: document.querySelector('[data-testid="terminal-screen"]').getBoundingClientRect().height }));
        expect(metrics.width === size && metrics.scroll <= size + 1 && metrics.stop >= 44 && metrics.keys.every(h => h >= 44) && metrics.input >= 16 && metrics.screen > 80, `terminal mobile geometry ${JSON.stringify(metrics)}`);
      }
      tab.win.setContentSize(390, 500); await sleep(250);
      expect(await tab.eval(() => {
        const dialog = document.querySelector('[data-testid="terminal-dialog"]').getBoundingClientRect();
        const stop = document.querySelector('[data-testid="terminal-stop"]').getBoundingClientRect();
        const screen = document.querySelector('[data-testid="terminal-screen"]').getBoundingClientRect();
        return Math.abs(dialog.height - visualViewport.height) <= 1 && stop.top >= 0 && stop.bottom <= innerHeight && screen.height > 40 && document.documentElement.scrollWidth <= innerWidth + 1;
      }), "terminal controls/caret area lost in reduced keyboard viewport");
      tab.win.setContentSize(width, height);
    }
    await tab.shot("terminal-active");
    await fetch(`${terminal.base}/__terminal/drop`, { method: "POST" });
    await tab.waitFor("disconnected terminal", () => document.querySelector('[data-testid="terminal-reconnect"]'));
    const disconnected = (await diagnostics()).inputs.length;
    expect(await tab.eval(() => document.querySelector('[data-testid="terminal-key-tab"]').disabled), "disconnected keyboard writable");
    await tab.click('[data-testid="terminal-reconnect"]');
    await tab.click('[data-testid="terminal-step-up"]'); await tab.type(terminal.password); await tab.click('[data-testid="terminal-verify-confirm"]');
    await tab.waitFor("reconnected", () => !document.querySelector('[data-testid="terminal-verify"]') && document.querySelector('[data-testid="terminal-status"]').textContent.includes("Đã kết nối"));
    expect((await diagnostics()).opens === 1 && (await diagnostics()).inputs.length === disconnected, "reconnect spawned/resent input");
    await tab.click('[data-testid="terminal-key-interrupt"]');
    await until("new epoch input", async () => (await diagnostics()).inputs.some(f => f.epoch === 1 && f.seq === 1 && f.text === "\x03"));
    await fetch(`${terminal.base}/__terminal/gap`, { method: "POST" });
    await tab.waitFor("visible replay gap", () => document.querySelector('[data-testid="terminal-audit-gap"]'));
    await tab.click('[data-testid="terminal-audit"]'); await tab.click('[data-testid="terminal-step-up"]'); await tab.type(terminal.password); await tab.click('[data-testid="terminal-verify-confirm"]');
    await tab.waitFor("audit index", () => document.querySelector('[data-testid="terminal-recording"]'));
    await tab.key("Escape");
    await tab.click('[data-testid="terminal-stop"]');
    await until("machine receives stop", async () => (await diagnostics()).kills >= 1);
    await tab.waitFor("session ended", () => document.querySelector('[data-testid="terminal-stop"]').disabled);
    await tab.click('[data-testid="terminal-detach"]');
    await tab.waitFor("detached UI", () => !document.querySelector('[data-testid="terminal-dialog"]'));
    expect((await diagnostics()).resizes.some(r => r.cols >= 20 && r.rows >= 5), "terminal never resized PTY");
    await fetch(`${terminal.base}/__terminal/opt-out`, { method: "POST" });
    await tab.go("machines"); await tab.click('[data-testid="terminal-open-machine"]');
    await tab.waitFor("local opt-out explanation", () => document.querySelector('[data-testid="terminal-unavailable"]')?.textContent.includes("chưa bật terminal"));
    expect(await tab.eval(() => document.querySelector('[data-testid="terminal-confirm-open"]').disabled), "local opt-out UI can create");
    await tab.key("Escape");
  });

  await step("close-unmerged-task", async () => {
    const tab = tabs.inboxSource;
    const project = "inbox-source-e2e";
    const instance = "c105ec10";
    const machineRpc = async (method, input) => {
      const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}`, "x-hive-agent": "runner.close-e2e" }, body: JSON.stringify({ method, input }) });
      const result = await response.json();
      if (result.error) throw new Error(`${method}: ${result.error.message}`);
      return result.result;
    };
    await machineRpc("machines.heartbeat", { machine: "close-e2e", instance, projects: [project], gateRunner: true });
    const machine = (await rpc("machines.list")).find(item => item.machine === "close-e2e");
    const pushReview = async (taskId, verdict) => machineRpc("runs.push", { machine: "close-e2e", runs: [{ runId: `R-${taskId}`, project, taskId, taskTitle: taskId, role: "review", status: "succeeded", verdict, branch: `ai/${taskId}`, profileId: null, createdAt: new Date().toISOString() }] });
    for (const [taskId, verdict] of [["CLOSE-NO-REVIEW", null], ["CLOSE-CHANGES", "changes"], ["CLOSE-APPROVE", "approve"]]) {
      await rpc("tasks.create", { project, id: taskId, title: taskId, kind: "small-fix" });
      if (verdict) await pushReview(taskId, verdict);
      await rpc("tasks.update", { id: taskId, status: "review" });
    }
    await rpc("mergeQueue.configure", { project, config: { enabled: true, machineId: machine.id, commands: ["true"], waitMinutes: 0, mode: "push" } });
    await tab.go("tasks");
    await tab.go("today?section=inbox");
    await tab.eval(() => {
      window.__closeWarning = "";
      window.confirm = (message) => { window.__closeWarning = message; return false; };
    });
    const tryClose = async (taskId) => {
      await tab.click(`[data-inbox-key^="review:${project}:${taskId}:"]`);
      await tab.eval(() => { window.__closeWarning = ""; });
      await tab.click("button", "Chuyển sang Xong");
      const warning = await tab.waitFor(`close warning for ${taskId}`, () => window.__closeWarning);
      // Cancelling keeps the detail open; phones must return to the list before selecting another task.
      if (mobile) await tab.click("button", "Quay lại danh sách");
      return warning;
    };
    const warning = await tryClose("CLOSE-NO-REVIEW");
    expect(warning.includes("chưa có lượt review"), `close warning: ${warning}`);
    expect((await rpc("tasks.list", { project, status: "review" })).some((task) => task.id === "CLOSE-NO-REVIEW"), "cancelled close changed the task status");
    expect(await tab.eval(() => !!document.querySelector('[data-inbox-key^="review:inbox-source-e2e:CLOSE-NO-REVIEW:"]')), "cancelled close removed the review item");
    const changes = await tryClose("CLOSE-CHANGES");
    expect(changes.includes("cần sửa") && changes.includes("ai/CLOSE-CHANGES"), `rejected review warning: ${changes}`);
    const queueHint = await tryClose("CLOSE-APPROVE");
    expect(queueHint.includes("hàng chờ"), `approved queue hint: ${queueHint}`);
    const batch = await machineRpc("mergeQueue.take", { project, instance });
    expect(batch?.items.some(item => item.taskId === "CLOSE-APPROVE"), "approved branch was not queued");
    await machineRpc("runs.push", { machine: "close-e2e", runs: [{ runId: "R-CLOSE-APPROVE-NO-BRANCH", project, taskId: "CLOSE-APPROVE", taskTitle: "CLOSE-APPROVE", role: "implement", status: "succeeded", branch: null, profileId: null, createdAt: new Date(Date.now() + 1000).toISOString() }] });
    const approved = await tryClose("CLOSE-APPROVE");
    expect(approved.includes("ai/CLOSE-APPROVE") && !approved.includes("hàng chờ"), `approved unmerged warning: ${approved}`);
    await machineRpc("mergeQueue.finish", { id: batch.id, instance, result: { status: "landed", sha: "b".repeat(40), step: "landed", outcomes: [{ taskId: "CLOSE-APPROVE", status: "included", sha: "a".repeat(40) }] } });
    // Reopen the fixture to exercise the close action after its branch has landed.
    await rpc("tasks.update", { id: "CLOSE-APPROVE", status: "review" });
    await tab.go("tasks");
    await tab.go("today?section=inbox");
    await tab.click(`[data-inbox-key^="review:${project}:CLOSE-APPROVE:"]`);
    await tab.eval(() => { window.__closeWarning = ""; });
    await tab.click("button", "Chuyển sang Xong");
    expect(await tab.eval(() => window.__closeWarning) === "", "landed branch still warned before close");
    expect((await rpc("tasks.list", { project, status: "done" })).some(task => task.id === "CLOSE-APPROVE"), "landed branch did not close");
  });

  const errors = Object.values(tabs).flatMap((t) => t.errors.map((e) => `${t.name}: ${e}`));
  if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
  const failed = results.filter((r) => !r.ok);
  if (mobile) {
    writeFileSync(path.join(out, "overflow.json"), JSON.stringify({ page: overflows, content: contentOverflows }, null, 2));
    console.log(`mobile overflow: ${overflows.length} steps${overflows.length ? `; ${overflows.map((o) => o.step).join(", ")}` : ""}`);
    console.log(`content wider than pane: ${contentOverflows.length} steps${contentOverflows.length ? `; ${contentOverflows.map((o) => o.step).join(", ")}` : ""}`);
  }
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`step times, slowest first (total ${total} ms):`);
  for (const r of [...results].sort((a, b) => b.ms - a.ms)) console.log(`  ${String(r.ms).padStart(7)} ms  ${r.ok ? "✓" : "✗"} ${r.name}`);
  console.log(`${results.length - failed.length}/${results.length} steps passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  const exitCode = failed.length || errors.length ? 1 : 0;
  writeFileSync(path.join(out, "result.json"), JSON.stringify({ results, errors, exitCode }, null, 2));
  // Not app.exit: Electron can retain a hidden BrowserWindow after history navigation on macOS and never quit.
  process.exit(exitCode);
}
