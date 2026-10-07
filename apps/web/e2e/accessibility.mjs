import axe from "axe-core";
import { writeFileSync } from "node:fs";
import path from "node:path";

const pages = ["today", "tasks", "runs", "docs", "skills", "memory", "machines?tab=fleet", "settings?tab=policy", "admin?tab=users"];

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
export async function accessibilityAudit({ tab, out, expect }) {
  await tab.win.webContents.executeJavaScript(axe.source);
  const report = [];
  const original = await tab.eval(() => ({ theme: document.documentElement.dataset.theme, scheme: document.documentElement.style.colorScheme }));
  try {
    for (const theme of ["light", "dark"]) {
      await tab.eval(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
      }, theme);
      for (const route of pages) {
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
        writeFileSync(path.join(out, "accessibility.json"), JSON.stringify(report, null, 2));
      }
    }
  } finally {
    await tab.eval(({ theme, scheme }) => {
      if (theme) document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = scheme;
    }, original);
  }
  const violations = report.flatMap(({ route, theme, violations }) => violations.map(v => `${route}/${theme}: ${v.id} (${v.nodes.length})`));
  expect(!violations.length, `axe WCAG: ${violations.join(", ")}; see accessibility.json`);
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
    const opened = await tab.eval(describeFocus);
    await tab.key("Tab");
    const tabbed = await tab.eval(describeFocus);
    // Opening the custom drawer is an audit observation until it gains a shared modal focus policy.
    if (out) writeFileSync(path.join(out, "menu-focus.json"), JSON.stringify({ opened, tabbed }, null, 2));
    await tab.key("Escape");
    expect(await tab.eval(() => document.querySelector('button[aria-label="Ẩn hoặc hiện thanh bên"]') === document.activeElement), "Escape should close menu and return focus to its trigger");
    expect(await tab.eval(() => document.querySelector("nav")?.inert), "closed phone menu should be inert");
  } else {
    await tab.eval(() => document.querySelector('nav a[href="#/tasks"]').focus());
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
