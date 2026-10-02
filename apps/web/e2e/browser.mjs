// The browser half of `npm run e2e` (see run.mjs). Electron stands in for Chromium, so nothing past `npm ci` is needed.
// Input goes through the DevTools protocol (the mouse at an element's centre, typed text, keys), as a person's
// would: Radix menus and the Tiptap editor react to real events, not to element.click().
// Each step checks what the hub now holds through its RPC, not only what the page shows.
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";

const base = process.env.HIVE_E2E_BASE;
const out = process.env.HIVE_E2E_OUT;
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
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { partition: `e2e-${name}` } });
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
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      selector,
      text ?? null,
      within ?? null,
    );
  }

  async click(selector, text, within) {
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
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}: ${err.message}`);
    await current?.shot(`${id}-${name}-FAIL`).catch(() => undefined);
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
    await tab.waitFor("the admin's Tổng quan", () => document.querySelector("h1")?.textContent.includes("Tổng quan"));
  });

  await step("login-password", async () => {
    const tab = (current = tabs.hoa = await Tab.open("hoa"));
    await tab.click("#username");
    await tab.type("hoa");
    await tab.click("#password");
    await tab.type(people.hoa.password);
    await tab.key("Enter");
    await tab.waitFor("Hoa signed in", () => !document.querySelector("#username") && document.body.innerText.includes("@hoa"));
  });

  await step("reviewer-approves-a-guide-not-context", async () => {
    const tab = (current = tabs.hoa);
    await tab.go("proposals");
    await tab.waitFor("the guide's proposal", () => document.body.innerText.includes("Thêm bước cài"));
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
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await tab.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await tab.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await tab.find('[role="dialog"]');
    await tab.select('[role="dialog"] select[aria-label="Quyền trên demo"]', "reviewer");
    await tab.click('[role="dialog"] button', "Lưu quyền");
    await tab.waitFor("the dialog to close", () => !document.querySelector('[role="dialog"]'));
    const minh = (await rpc("users.list", {})).find((u) => u.username === "minh");
    expect(JSON.stringify(minh.grants.demo) === '"reviewer"', `Minh on demo: ${JSON.stringify(minh.grants.demo)}`);
  });

  await step("docs-rich-editor", async () => {
    const tab = (current = tabs.admin);
    await tab.go(`admin/docs?doc=${encodeURIComponent("project/demo/huong-dan")}`);
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
    await tab.click('[role="radio"]', "Markdown");
    await tab.click('textarea[aria-label^="Nội dung"]');
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
    await tab.click('[aria-label="Bật gói claude-1"]');
    await tab.waitFor("the change waiting on the page", () => document.body.innerText.includes("chờ máy áp dụng"));
    await until("the change at Lan's heartbeat", async () => (await beat(before)).profileChanges?.find((c) => c.profileId === "claude-1" && c.enabled === false && c.requestedBy === "lan"));
    // The machine saved it and reports claude-1 off: nothing left to send, the page shows the switch off.
    const after = await beat([profile("claude-1", false, 10), profile("claude-2", true, 20)]);
    expect(after.profileChanges.length === 0, `still sent: ${JSON.stringify(after.profileChanges)}`);
    await tab.reload();
    await tab.go("machines");
    await tab.waitFor("claude-1 off, nothing waiting", () => document.querySelector('[aria-label="Bật gói claude-1"]')?.getAttribute("aria-checked") === "false" && !document.body.innerText.includes("chờ máy áp dụng"));
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
          { dir: "002-hoan-tien", branch: "ai/PAY-2", commit: "def5678", files: { spec: "# Feature Specification: Hoàn tiền", plan: null, tasks: null } },
        ],
      },
      people.lan.token,
    );
    expect(pushed.stored === 2, `specs.push: ${JSON.stringify(pushed)}`);
    const tab = (current = tabs.hoa);
    await tab.go("specs?project=payment&dir=001-thanh-toan-qr&branch=");
    await tab.waitFor("both features, with their stages", () => {
      const text = document.body.innerText;
      return text.includes("Thanh toán QR") && text.includes("Hoàn tiền") && text.includes("Đang làm") && text.includes("Viết spec") && text.includes("ai/PAY-2");
    });
    await tab.click('[role="tab"]', "Spec");
    await tab.waitFor("spec.md", () => document.body.innerText.includes("Người dùng quét mã"));
    await tab.click('[role="tab"]', "Tasks");
    await tab.waitFor("the tasks of tasks.md", () => document.body.innerText.includes("Trang quét mã") && document.body.innerText.includes("1/2"));
  });

  // Roadmap 20c and 20d: Lan (lead of payment) imports tasks.md into board tasks, then has an agent plan the refund
  // feature, which lives on PAY-2's branch: a run of PAY-2 with the plan step's instructions.
  await step("spec-import-and-run", async () => {
    await rpc("tasks.create", { id: "PAY-2", project: "payment", title: "Hoàn tiền" });
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
    await tab.go("specs?project=payment&dir=002-hoan-tien&branch=ai%2FPAY-2");
    await tab.click("button", "Lập kế hoạch");
    await tab.click("textarea");
    await tab.type("Dùng VNPay.");
    await tab.click("button", "Lập kế hoạch");
    const req = await until("the plan run of PAY-2", async () => (await rpc("runs.requests", { project: "payment" })).find((r) => r.taskId === "PAY-2"));
    expect(req.instructions.includes("speckit-plan") && req.instructions.includes("Dùng VNPay.") && req.instructions.includes("specs/002-hoan-tien"), `instructions: ${req.instructions}`);
  });

  // Roadmap 27a: a project's row only tightens the hub's default; the machines get it at their heartbeat.
  await step("agent-policy", async () => {
    const tab = (current = tabs.admin);
    await tab.go("admin/policy");
    await tab.waitFor("payment's row", () => [...document.querySelectorAll("tr")].some((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ"]')));
    await tab.eval(() => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ"]'));
      const select = row.querySelector('select[aria-label="Mức tự chủ"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "read");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const { x, y } = await tab.waitFor("payment's save button", () => {
      const row = [...document.querySelectorAll("tr")].find((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ"]'));
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
      const row = [...document.querySelectorAll("tr")].find((r) => r.cells[0]?.textContent.trim() === "payment" && r.querySelector('select[aria-label="Mức tự chủ"]'));
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
    await tab.type("rtk");
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
    const saved = await until("rtk in the catalog", async () => (await rpc("tools.list", {})).find((t) => t.id === "rtk"));
    expect(saved.kind === "mcp" && saved.package?.version === "0.4.1" && saved.mcp?.args.includes("{package}"), `rtk: ${JSON.stringify(saved)}`);
    await tab.click('[data-tool="rtk"] button[data-tool-remove]');
    await tab.click('[data-tool="rtk"] button[data-tool-remove-confirm]');
    await until("rtk gone", async () => !(await rpc("tools.list", {})).some((t) => t.id === "rtk"));
    const seeds = await rpc("tools.list", {});
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
    await tab.go("admin/costs");
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
    await tab.go("admin/costs");
    await tab.waitFor("the full cap on the card", () => document.body.innerText.includes("Đã hết trần"));
    await tab.shot(`${String(n).padStart(2, "0")}-budget-full`);
    // Leave the hub as the other steps expect it.
    await rpc("budgets.set", { budgets: [] });
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

  // Roadmap 19d: a task of one service waits for another service's (demo waits for payment's), named with its project.
  await step("cross-service-task", async () => {
    const task = await rpc("tasks.create", { id: "DEMO-2", project: "demo", title: "Trang đơn hàng", dependsOn: ["PAY-1"] });
    expect(task.depProjects?.["PAY-1"] === "payment", `DEMO-2: ${JSON.stringify(task)}`);
    const tab = (current = tabs.lan);
    await tab.go("tasks?task=DEMO-2");
    await tab.waitFor("DEMO-2 waiting for payment/PAY-1", () => document.body.innerText.includes("Trang đơn hàng") && document.body.innerText.includes("payment/PAY-1"));
  });

  const errors = Object.values(tabs).flatMap((t) => t.errors.map((e) => `${t.name}: ${e}`));
  if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} steps passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  app.exit(failed.length || errors.length ? 1 : 0);
}
