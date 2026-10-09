import axe from "axe-core";
import { writeFileSync } from "node:fs";
import path from "node:path";

const pages = ["today", "tasks", "runs", "artifacts", "docs", "skills", "memory", "machines?tab=fleet", "settings?tab=policy", "admin?tab=users"];

export async function runContrast({ tab, expect }) {
  // The status and the action's disabled styling must both reflect the completed poll before measuring.
  await tab.waitFor("settled run action", () => {
    const action = document.querySelector("main [data-run-roles-open]");
    return !action || !action.disabled && Number(getComputedStyle(action).opacity) === 1;
  });
  await tab.win.webContents.executeJavaScript(axe.source);
  const violations = await tab.eval(async () => {
    const { violations } = await window.axe.run(document.querySelector("main"), { runOnly: { type: "rule", values: ["color-contrast"] } });
    return violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  });
  expect(!violations.length, `selected run contrast: ${JSON.stringify(violations)}`);
}

// Keep axe in the Electron test process; production bundles never import it.
export async function accessibilityAudit({ tab, out, expect, routes = pages, filename = "accessibility.json" }) {
  await tab.win.webContents.executeJavaScript(axe.source);
  const report = [];
  const original = await tab.eval(() => ({ theme: document.documentElement.dataset.theme, scheme: document.documentElement.style.colorScheme }));
  try {
    for (const theme of ["light", "dark"]) {
      await tab.eval(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
      }, theme);
      for (const route of routes) {
        await tab.go(route);
        await tab.waitFor("loaded audit page", () => !!document.querySelector("main") && !document.querySelector('main [aria-busy="true"]'));
        const result = await tab.eval(async () => {
          const { violations, incomplete } = await window.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
          });
          const summarize = issues => issues.map(({ id, impact, nodes }) => ({
            id, impact, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
          }));
          return { viewport: [innerWidth, innerHeight], violations: summarize(violations), incomplete: summarize(incomplete) };
        });
        report.push({ route, theme, ...result });
        writeFileSync(path.join(out, filename), JSON.stringify(report, null, 2));
      }
    }
  } finally {
    await tab.eval(({ theme, scheme }) => {
      if (theme) document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = scheme;
    }, original);
  }
  // The cosmic primary (#7B61FF) in dark is the owner's chosen colour: white on it is 4.2:1, the one contrast exception.
  const cosmic = (theme, node) => theme === "dark" && node.failureSummary.includes("foreground color: #ffffff, background color: #7b61ff");
  const violations = report.flatMap(({ route, theme, violations }) => violations
    .map(v => ({ ...v, nodes: v.nodes.filter(n => !cosmic(theme, n)) })).filter(v => v.nodes.length)
    .map(v => `${route}/${theme}: ${v.id} (${v.nodes.length})`));
  expect(!violations.length, `axe WCAG: ${violations.join(", ")}; see ${filename}`);
}

export async function keyboardMenu({ tab, mobile, expect, out }) {
  await tab.go("today");
  await tab.reload();
  const hidden = [];
  for (let i = 0; i < 22; i++) {
    await tab.key("Tab");
    const focus = await tab.eval(() => {
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 60), offscreen: r.right <= 0 || r.left >= innerWidth };
    });
    if (focus.offscreen) hidden.push(focus.name);
  }
  expect(!hidden.length, `Tab focused offscreen menu controls: ${hidden.join(", ")}`);
  if (mobile) {
    await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    const describeFocus = () => {
      const el = document.activeElement;
      return { inMenu: !!el.closest("nav"), name: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 80) };
    };
    await tab.waitFor("focus enters phone menu", () => !!document.activeElement.closest("nav"));
    await tab.waitFor("phone menu finishes opening", () => document.querySelector('#hive-navigation').getBoundingClientRect().left >= -1);
    const opened = await tab.eval(describeFocus);
    await tab.shot("phone-drawer");
    expect(opened.inMenu, `drawer opened without menu focus: ${JSON.stringify(opened)}`);
    expect(await tab.eval(() => document.querySelector("main").closest("[inert]") !== null), "drawer background must be inert");
    await tab.eval(() => document.querySelector('button[aria-controls="hive-navigation"]').focus());
    expect((await tab.eval(describeFocus)).inMenu, "inert background must reject programmatic focus");
    await tab.key("Tab");
    const tabbed = await tab.eval(describeFocus);
    expect(tabbed.inMenu, `Tab escaped phone menu: ${JSON.stringify(tabbed)}`);
    if (out) writeFileSync(path.join(out, "menu-focus.json"), JSON.stringify({ opened, tabbed }, null, 2));
    const originalTheme = await tab.eval(() => document.documentElement.dataset.theme);
    const audit = [];
    await tab.win.webContents.executeJavaScript(axe.source);
    try {
      for (const theme of ["light", "dark"]) {
        await tab.eval(theme => document.documentElement.dataset.theme = theme, theme);
        audit.push(await tab.eval(async theme => {
          const { violations, incomplete } = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
          const summarize = issues => issues.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
          return { theme, violations: summarize(violations), incomplete: summarize(incomplete) };
        }, theme));
      }
    } finally {
      await tab.eval(theme => document.documentElement.dataset.theme = theme, originalTheme);
    }
    if (out) writeFileSync(path.join(out, "drawer-accessibility.json"), JSON.stringify(audit, null, 2));
    expect(audit.every(r => !r.violations.length), `drawer axe: ${JSON.stringify(audit)}`);
    await tab.click("[data-project-picker-trigger]");
    await tab.waitFor("nested scope picker opens", () => !!document.querySelector('[data-slot="popover-content"]'));
    await tab.key("Escape");
    expect(await tab.eval(() => !!document.querySelector('[data-slot="sheet-content"]')), "Escape in scope picker must leave drawer open");
    await checkModal({ tab, selector: '[data-slot="sheet-content"]', expect });
    await tab.waitFor("focus returned to menu trigger", () => document.querySelector('button[aria-label="Ẩn hoặc hiện thanh bên"]') === document.activeElement);
    expect(await tab.eval(() => document.querySelector('button[aria-label="Ẩn hoặc hiện thanh bên"]') === document.activeElement), "Escape should close menu and return focus to its trigger");
    expect(await tab.eval(() => !document.querySelector("#hive-navigation")), "closed phone menu should leave the focus and accessibility trees");
    expect(await tab.eval(() => !document.querySelector("main").closest("[inert]")), "closing drawer must release the background");
    await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    await tab.click('#hive-navigation a[href="#/tasks"]');
    await tab.waitFor("menu navigation closes drawer", () => location.hash === "#/tasks" && !document.querySelector('[data-slot="sheet-content"]'));
    await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    await tab.click('button[aria-label="Đóng menu"]');
    await tab.waitFor("close button returns focus", () => !document.querySelector('[data-slot="sheet-content"]') && document.activeElement?.getAttribute("aria-controls") === "hive-navigation");
    await tab.click('button[aria-label="Ẩn hoặc hiện thanh bên"]');
    const outside = await tab.eval(() => ({ x: innerWidth - 5, y: innerHeight / 2 }));
    await clickPoint(tab, outside);
    await tab.waitFor("scrim returns focus", () => !document.querySelector('[data-slot="sheet-content"]') && document.activeElement?.getAttribute("aria-controls") === "hive-navigation");
  } else {
    await tab.eval(() => document.querySelector('#hive-navigation a[href="#/tasks"]').focus());
    await tab.key("Enter");
    await tab.waitFor("keyboard menu navigation", () => location.hash === "#/tasks");
  }
}

async function checkModal({ tab, selector, expect }) {
  await tab.waitFor("focus inside overlay", selector => document.querySelector(selector)?.contains(document.activeElement), selector);
  const name = await tab.eval(selector => {
    const el = document.querySelector(selector);
    return (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent).join(" ").trim();
  }, selector);
  expect(!!name, "overlay must have an accessible name");
  for (const mods of [[], ["Shift"]]) {
    // Test both wrap boundaries through real Tab events, even for long task forms.
    await tab.eval((selector, reverse) => {
      const controls = [...document.querySelector(selector).querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
        .filter(el => !el.disabled && el.tabIndex >= 0 && el.getBoundingClientRect().height > 0);
      (reverse ? controls[0] : controls.at(-1)).focus();
    }, selector, mods.length > 0);
    await tab.key("Tab", ...mods);
    expect(await tab.eval(selector => document.querySelector(selector).contains(document.activeElement), selector), `Tab escaped ${selector}`);
  }
  await tab.key("Escape");
  await tab.waitFor("overlay closed", selector => !document.querySelector(selector), selector);
}

export async function keyboardOverlays({ tab, expect }) {
  await tab.go("tasks");
  await tab.click('[data-task-view="kanban"]');
  await tab.click('[data-column="todo"] [data-task]');
  await checkModal({ tab, selector: '[data-slot="sheet-content"]', expect });
  expect(await tab.eval(() => document.activeElement?.matches('[data-task]')), "Sheet should return focus to the task card");
  await tab.click("[data-new-work-open]");
  await checkModal({ tab, selector: '[data-slot="dialog-content"]', expect });
  expect(await tab.eval(() => document.activeElement?.matches('[data-new-work-open]')), "dialog should return focus to New work");
}

export async function keyboardTable({ tab, expect }) {
  await tab.go("tasks");
  await tab.click('[data-task-view="list"]');
  const found = await tab.eval(() => {
    const row = document.querySelector('main tbody tr td:first-child button:not([role="checkbox"])');
    if (!row) return false;
    row.focus();
    return document.activeElement === row;
  });
  expect(found, "task table must expose keyboard-operable task buttons");
  await tab.key("Enter");
  await tab.waitFor("table row opens Sheet", () => !!document.querySelector('[data-slot="sheet-content"]'));
  await tab.key("Escape");
}

async function clickPoint(tab, { x, y }) {
  await tab.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await tab.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await tab.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function dataTableAccessibility({ tab, mobile, expect }) {
  // Enough local fixtures to exercise pagination, selection and the empty table independently.
  const headers = { "content-type": "application/json", authorization: `Bearer ${JSON.parse(process.env.HIVE_E2E_SEED).admin}` };
  for (let i = 0; i < 27; i++) {
    const response = await fetch(`${process.env.HIVE_E2E_BASE}/api/rpc`, { method: "POST", headers: { ...headers, "x-hive-agent": `runner.a11y-table-${i}` }, body: JSON.stringify({ method: "machines.heartbeat", input: { machine: `a11y-table-${String(i).padStart(2, "0")}`, instance: `a110${String(i).padStart(4, "0")}`, version: "0.142.0", projects: ["payment"] } }) });
    expect(response.ok && !(await response.json()).error, "could not seed local machine fixture");
  }
  await tab.go("machines?tab=fleet");
  await tab.waitFor("fleet table populated", () => document.querySelectorAll('[data-card-body] [data-card-row]').length >= 27);
  const structure = await tab.eval(() => {
    const table = document.querySelector('[data-card-body]');
    const rows = [...table.querySelectorAll('[role="row"]')];
    const counts = rows.map(row => row.querySelectorAll(':scope > [role="cell"], :scope > [role="columnheader"]').length);
    return { role: table.getAttribute("role"), cols: +table.getAttribute("aria-colcount"), counts, badSort: table.querySelectorAll('button[aria-sort]').length };
  });
  expect(structure.role === "table" && structure.counts.every(n => n === structure.cols) && !structure.badSort, `DataTable structure: ${JSON.stringify(structure)}`);
  const ax = await tab.cdp("Accessibility.getFullAXTree");
  expect(ax.nodes.some(n => !n.ignored && n.role?.value === "table") && ax.nodes.filter(n => !n.ignored && n.role?.value === "columnheader").length >= structure.cols, "fleet table and headers must reach the accessibility tree");
  if (mobile) {
    await tab.select('select[aria-label="Sắp xếp"]', "machine");
  } else {
    await tab.eval(() => document.querySelector('[role="columnheader"] button:not([role="checkbox"])').focus());
    await tab.key("Enter");
  }
  expect(await tab.eval(() => document.querySelector('[role="columnheader"][aria-sort="ascending"]') !== null), "sort state belongs to the column header");
  // Select the page-size control explicitly: the filter selects come first in the toolbar.
  const perPage = await tab.eval(() => {
    const selects = [...document.querySelectorAll('[data-responsive-table] select')];
    const select = selects.find(el => [...el.options].map(o => o.value).join(",") === "25,50,100,200");
    if (!select) return false;
    select.value = "25";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  expect(perPage, "page-size control missing");
  await tab.click('button[aria-label="Trang sau"]');
  expect(await tab.eval(() => +document.querySelector('[data-card-row]').getAttribute("aria-rowindex") === 27), "paginated row indices must include the header and preceding page");
  await tab.click('[data-card-row] [role="checkbox"]');
  expect(await tab.eval(() => document.querySelector('[data-card-row] [role="checkbox"]').getAttribute("aria-checked") === "true"), "row selection should toggle independently");
  await tab.eval(() => document.querySelector('[data-card-row]').focus());
  await tab.key("Enter");
  await tab.waitFor("Enter opens fleet detail", () => document.querySelector('[data-slot="dialog-content"]'));
  await tab.key("Escape");
  await tab.waitFor("fleet detail closed", () => !document.querySelector('[data-slot="dialog-content"]'));
  await tab.click('[data-responsive-table] input');
  await tab.type("no-such-a11y-machine");
  await tab.waitFor("empty table", () => !document.querySelector('[data-card-row]'));
  expect(await tab.eval(() => !!document.querySelector('[role="table"] [role="row"] [role="cell"][aria-colspan]')), "empty state must preserve table structure");
  await tab.click("button", "Xoá");
  await tab.waitFor("cleared table search", () => document.querySelector('[data-card-row]'));
}

export async function memoryAccessibility({ tab, mobile, expect, out }) {
  await tab.go("memory");
  const checkbox = 'main li [role="checkbox"]';
  await tab.waitFor("pending memory choices", selector => document.querySelector(selector), checkbox);
  const initialHash = await tab.eval(() => location.hash);
  await tab.eval(selector => document.querySelector(selector).focus(), checkbox);
  const initial = await tab.eval(selector => document.querySelector(selector).getAttribute("aria-checked"), checkbox);
  await tab.key(" ");
  expect(await tab.eval(selector => document.querySelector(selector).getAttribute("aria-checked") !== "false", checkbox), "Space must select the memory checkbox");
  await tab.key(" ");
  expect(await tab.eval((selector, initial) => document.querySelector(selector).getAttribute("aria-checked") === initial, checkbox, initial), "Space must clear the memory checkbox");
  const target = await tab.eval(selector => {
    const box = document.querySelector(selector);
    box.scrollIntoView({ block: "center" });
    const r = box.getBoundingClientRect();
    const pseudo = getComputedStyle(box, "::before");
    return { width: r.width, height: r.height, x: r.x + r.width / 2, y: r.y + r.height / 2, pseudoWidth: parseFloat(pseudo.width), pseudoHeight: parseFloat(pseudo.height) };
  }, checkbox);
  expect(target.width >= 24 && target.height >= 24, `desktop memory checkbox size: ${JSON.stringify(target)}`);
  if (mobile) {
    expect(target.pseudoWidth >= 44 && target.pseudoHeight >= 44, `phone memory tap area: ${JSON.stringify(target)}`);
    const hits = [];
    for (const [dx, dy] of [[-21, -21], [21, -21], [-21, 21], [21, 21], [-21, 0], [21, 0], [0, -21], [0, 21]]) {
      // Selection reveals the bulk toolbar, moving the list; measure the current hit area for every tap.
      const center = await tab.eval(selector => {
        const box = document.querySelector(selector);
        box.scrollIntoView({ block: "center" });
        const r = box.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, checkbox);
      const point = { x: center.x + dx, y: center.y + dy };
      const hit = await tab.eval((selector, point) => document.elementFromPoint(point.x, point.y)?.closest('[role="checkbox"]') === document.querySelector(selector), checkbox, point);
      expect(hit, `44px memory hit area misses ${JSON.stringify(point)}`);
      const before = await tab.eval(selector => document.querySelector(selector).getAttribute("aria-checked"), checkbox);
      await clickPoint(tab, point);
      await tab.waitFor("tap toggles checkbox", (selector, before) => document.querySelector(selector).getAttribute("aria-checked") !== before, checkbox, before);
      expect(await tab.eval(() => location.hash) === initialHash, "checkbox tap must not open the detail pane");
      hits.push({ ...point, hit });
    }
    writeFileSync(path.join(out, "memory-hit-test.json"), JSON.stringify({ target, hits }, null, 2));
  }
  expect(await tab.eval(() => !document.querySelector('main [role="option"] [role="checkbox"]')), "memory checkbox must be outside option semantics");
  await tab.shot("memory-controls");
  await tab.eval(selector => document.querySelector(selector).closest('li').querySelector('button:not([role="checkbox"])').focus(), checkbox);
  await tab.key("Enter");
  await tab.waitFor("memory detail opens from keyboard", () => !!document.querySelector('main li button[aria-current="true"]'));
  if (mobile) {
    expect(await tab.eval(() => new URLSearchParams(location.hash.split("?")[1]).has("memory")), "memory open action must navigate to its detail");
    await tab.click("button", "Quay lại danh sách");
  }
}
