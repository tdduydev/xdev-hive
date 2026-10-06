import { writeFileSync } from "node:fs";
import path from "node:path";

// Include the pages behind tabs and account links, not only the sidebar's default pages.
const routes = [
  "today", "chat", "graph", "features", "tasks", "runs", "runs?tab=batches",
  ...["docs", "skills", "memory"].flatMap(page => [page, `${page}?tab=pending`]),
  "pipeline", ...["policy", "tools", "context", "leader", "members", "systems"].map(tab => `settings?tab=${tab}`),
  ...["map", "quota", "fleet", "queue", "costs"].map(tab => `machines?tab=${tab}`),
  ...["ops", "users", "tools", "budgets", "alerts", "audit", "webhooks", "versions", "hub"].map(tab => `admin?tab=${tab}`),
  "tokens", "read?doc=project%2Fdemo%2Fhuong-dan",
];

export async function mobileAudit({ tab, out, step, expect, pages = routes, reportName = "mobile-audit.json" }) {
  const report = [];
  for (const route of pages) {
    await step(`mobile-audit-${route.replaceAll(/[?=]/g, "-")}`, async () => {
      await tab.go(route);
      await tab.waitFor("the requested page", r => location.hash === `#/${r}` && !!document.querySelector("main"), route);
      // Let lazy pages and their first queries settle before measuring controls.
      await tab.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await tab.waitFor("loaded content", () => !document.querySelector('main [aria-busy="true"]'));
      // Establish keyboard modality before focusing a field, rather than testing a mouse focus state.
      await tab.key("Tab");
      const focus = await tab.eval(() => {
        const el = [...document.querySelectorAll('main input, main textarea, main select, main button, main summary')]
          .find(el => !el.disabled && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
        if (!el) return null;
        el.focus();
        const style = getComputedStyle(el);
        return document.activeElement === el && (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none" || style.boxShadow !== "none");
      });
      const audit = await tab.eval(() => {
        const visible = el => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && !el.closest('[aria-hidden="true"], [inert]');
        };
        const name = el => el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim() || [...(el.labels || [])].map(label => label.textContent).join(" ").trim() || el.getAttribute("title") || (el.matches("button, a, summary, [role]") ? el.textContent.trim() : "");
        const describe = el => ({ tag: el.tagName, slot: el.dataset.slot, name: name(el).slice(0, 100) });
        const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]')].filter(visible);
        const controls = [...document.querySelectorAll('button, nav a, [data-slot="button"], [role="button"], [role="option"], [role="treeitem"], summary')].filter(visible);
        const smallTargets = controls.filter(el => {
          const r = el.getBoundingClientRect();
          // Checkbox/switch drawings stay compact; their reserved pseudo-element is the tap target.
          const hit = getComputedStyle(el, "::before");
          const hitWidth = hit.content !== "none" ? parseFloat(hit.width) || 0 : 0;
          const hitHeight = hit.content !== "none" ? parseFloat(hit.height) || 0 : 0;
          return Math.max(r.width, hitWidth) < 43.9 || Math.max(r.height, hitHeight) < 43.9;
        }).map(describe);
        const main = document.querySelector("main");
        return {
          route: location.hash, viewport: [innerWidth, innerHeight],
          overflow: document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1,
          smallInputs: inputs.filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(describe),
          smallTargets,
          unnamed: [...inputs, ...controls].filter(el => !name(el)).map(describe),
          motion: [...document.querySelectorAll("main *")].filter(visible).filter(el => getComputedStyle(el).animationName !== "none" && getComputedStyle(el).animationDuration.split(",").some(s => parseFloat(s) > 0.001)).map(describe),
        };
      });
      audit.focus = focus;
      report.push(audit);
      // Write after every page so a later navigation failure cannot lose earlier findings.
      writeFileSync(path.join(out, reportName), JSON.stringify(report, null, 2));
      expect(!audit.overflow && !audit.smallInputs.length && !audit.smallTargets.length && !audit.unnamed.length && !audit.motion.length && audit.focus !== false,
        `phone accessibility: ${JSON.stringify(audit)}`);
    });
  }
  await tab.cdp("Emulation.setEmulatedMedia", { features: [] });
}
