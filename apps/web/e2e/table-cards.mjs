// R-42c: page width alone misses clipped tables inside the shell, so also check rows and the main pane.
export async function tableCardsChecks({ tab, rpc, step, expect }) {
  const baseline = process.env.HIVE_E2E_TABLE_CARDS === "before";
  await rpc("webhooks.save", { name: `Mobile webhook ${"x".repeat(60)}`, kind: "slack", url: "https://hooks.slack.com/services/mobile/cards/example", events: ["run.failed", "alert.opened"], projects: ["payment"], locale: "vi", enabled: false });
  const { admin } = JSON.parse(process.env.HIVE_E2E_SEED);
  const upload = await fetch(`${process.env.HIVE_E2E_BASE}/api/releases/upload?version=0.999.0&channel=stable&platform=mac&arch=arm64&kind=zip&name=mobile-fixture.zip`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/octet-stream" }, body: "e2e mobile release fixture" });
  expect(upload.ok, "could not seed a release card");
  await rpc("releases.setRollout", { target: "0.999.0" });
  await rpc("tasks.create", { id: "MOBILE-CARD", project: "payment", title: `Mobile table ${"long-title-".repeat(20)}` });
  await tab.eval(() => localStorage.setItem("hive-tasks-view", "list"));
  await tab.reload();
  // Roadmap 49b: most of these are tabs now; each is opened at its own address (the step keeps the page's old name).
  const pages = [
    ["tasks", "tasks"],
    ["batches", "runs?tab=batches"],
    ["machines", "machines"],
    ["queue", "machines?tab=queue"],
    ["costs", "machines?tab=costs"],
    ["alerts", "admin?tab=alerts"],
    ["audit", "admin?tab=audit"],
    ["users", "admin?tab=users"],
    ["tokens", "tokens"],
    ["webhooks", "admin?tab=webhooks"],
    ["versions", "admin?tab=versions"],
    ["hub", "admin?tab=hub"],
  ];
  for (const [route, address] of pages) {
    await step(`table-cards-${route}`, async () => {
      await tab.go(address);
      await tab.waitFor(route, (address) => location.hash === `#/${address}` && document.querySelector("main"), address);
      // Put the table in the handoff image, including on Task where the create form sits above it.
      await tab.eval(() => {
        const table = document.querySelector('main [data-slot="table"], main [data-card-row]');
        table?.scrollIntoView({ block: "start", behavior: "instant" });
      });
      if (baseline) return;
      const layout = await tab.eval(() => {
        const main = document.querySelector("main");
        const rows = [...document.querySelectorAll('main [data-responsive-table] tbody > tr, main [data-card-row]')];
        const badRows = rows.filter((row) => {
          const r = row.getBoundingClientRect();
          return r.width && (r.left < -1 || r.right > innerWidth + 1 || row.scrollWidth > row.clientWidth + 1);
        });
        const labels = [...document.querySelectorAll('main [data-responsive-table] [data-card-label]')].filter((el) => el.getBoundingClientRect().width > 0);
        return { width: innerWidth, page: document.documentElement.scrollWidth, pane: main?.clientWidth, content: main?.scrollWidth, badRows: badRows.length, rows: rows.length, labels: labels.length };
      });
      expect(layout.page <= layout.width + 1 && layout.content <= layout.pane + 1, `${route} overflows: ${JSON.stringify(layout)}`);
      expect(!layout.badRows, `${route}: clipped or overflowing cards: ${JSON.stringify(layout)}`);
      if (["tasks", "batches", "tokens"].includes(route)) {
        expect(layout.rows > 0 && layout.labels > 0, `${route}: no labelled cards: ${JSON.stringify(layout)}`);
      }
      if (route === "tasks") {
        const task = await tab.eval(() => [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes("MOBILE-CARD"))?.innerText);
        expect(task?.includes("Phụ thuộc") && task?.includes("Cập nhật"), `Task metadata missing: ${task}`);
      }
      if (route === "audit") {
        // AdminTable: no card layout, the table scrolls in its own frame; sorting is a header button.
        await tab.click(".cx-ops-sort");
        await tab.waitFor("mobile sorting", () => document.querySelector('[role="columnheader"][aria-sort="ascending"]'));
      }
    });
  }
  if (!baseline) await step("table-cards-breakpoint", async () => {
    await tab.go("tasks");
    let display;
    try {
      tab.win.setContentSize(768, 844);
      await tab.waitFor("768px viewport", () => innerWidth === 768);
      display = await tab.eval(() => ({ table: getComputedStyle(document.querySelector('[data-slot="table"]')).display, row: getComputedStyle(document.querySelector('tbody tr')).display }));
    } finally {
      tab.win.setContentSize(390, 844);
      await tab.waitFor("390px viewport restored", () => innerWidth === 390);
    }
    expect(display.table === "table" && display.row === "table-row", `768px must retain the table: ${JSON.stringify(display)}`);
    const row = await tab.eval(() => getComputedStyle(document.querySelector('tbody tr')).display);
    expect(row === "flex", `390px must show cards: ${row}`);
    await tab.eval(() => {
      const main = document.querySelector("main");
      const row = document.querySelectorAll('main tbody tr')[1];
      if (main && row) main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await tab.shot("tasks-list-cards");
  });
}
