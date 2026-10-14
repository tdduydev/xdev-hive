import { expect, type Page, test } from "@playwright/test";
import { SDLC_PHASE_KINDS, type SdlcMetrics, SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";
import { fail, ok } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";
import { PAYMENT, sdlcFixture } from "./sdlc-fixture.ts";

const HOURS: Partial<Record<(typeof SDLC_PHASE_KINDS)[number], [number, number]>> = {
  intake: [2, 5],
  requirements: [30, 70],
  design: [14, 40],
  decomposition: [3, 9],
  implementation: [22, 60],
  verification: [6, 18],
};

const metrics = (items: number): SdlcMetrics => ({
  from: "2026-09-14T03:42:00.000Z",
  to: "2026-10-14T03:42:00.000Z",
  items,
  leadTimeHours: SDLC_PHASE_KINDS.map((kind) => {
    const h = HOURS[kind];
    return { kind, duration: h ? { p50: h[0], p90: h[1], count: 8 } : { p50: null, p90: null, count: 0 } };
  }),
  gateWaitHours: { p50: 5.5, p90: 26, count: 18 },
  returnRate: 0.25,
  questionsPerItem: 1.5,
  coverage: { requirements: 24, planned: 92, done: 75, verified: 60 },
  convergeRounds: 1.4,
  codeReviewRoundsPerPr: 1.2,
  costUsdPerItem: 7.8,
  autoApproval: [
    { modeRef: "speckit", projectKey: null, autoRate: 0.4, revokeRate: 0.05 },
    { modeRef: "speckit", projectKey: PAYMENT.key, autoRate: 0.3, revokeRate: null },
  ],
});

async function setup(page: Page, opts: { items?: number; fail?: boolean } = {}) {
  const sdlc = sdlcFixture();
  const inputs: { from: string; to: string; projectId?: string; modeRef?: string }[] = [];
  // Web tự thử lại lỗi 5xx vài lần trước khi hiện lỗi, nên hub giả lỗi tới khi test tắt cờ.
  const hub = { failing: opts.fail ?? false };
  await inOrg(
    page,
    "member",
    {
      ...sdlc.rpc,
      "sdlc/metrics": (input) => {
        inputs.push(input as (typeof inputs)[number]);
        if (hub.failing) {
          return fail("INTERNAL_SERVER_ERROR", 500, "Hub không tính được chỉ số.");
        }
        return ok(metrics(opts.items ?? 12));
      },
    },
    [...SYSTEM_ROLE_PERMISSIONS.member],
  );
  return { inputs, hub };
}

const span = (i: { from: string; to: string }) => (Date.parse(i.to) - Date.parse(i.from)) / 86_400_000;

test("menu Chỉ số mở trang; lead time có nút thắt, thẻ chỉ số và tự duyệt; lọc gửi lại truy vấn", async ({ page }) => {
  const { inputs } = await setup(page);
  await page.goto("/sdlc");
  await page.getByRole("link", { name: "Chỉ số", exact: true }).click();
  await expect(page).toHaveURL(/\/sdlc\/metrics$/);
  await expect(page.getByRole("heading", { name: "Chỉ số AI SDLC", level: 1 })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Yêu cầu · p50" })).toHaveAttribute("aria-valuetext", "1,3 ngày");
  await expect(page.getByRole("listitem").filter({ hasText: "Nút thắt" })).toContainText("Yêu cầu");
  await expect(page.getByRole("listitem").filter({ hasText: "Tỉ lệ trả lại" })).toContainText("25%");
  await expect(page.getByRole("row").filter({ hasText: "Cả chế độ" })).toContainText("40%");
  expect(span(inputs.at(-1) ?? { from: "", to: "" })).toBe(30);

  await page.getByRole("button", { name: "7 ngày" }).click();
  await expect.poll(() => span(inputs.at(-1) ?? { from: "", to: "" })).toBe(7);
  await page.getByLabel("Dự án", { exact: true }).selectOption(PAYMENT.id);
  await expect.poll(() => inputs.at(-1)?.projectId).toBe(PAYMENT.id);

  await page.getByText("Xem bảng số liệu").click();
  await expect(page.getByRole("columnheader", { name: "p90" })).toBeVisible();
});

test("từ chỉ số mở bảng hạng mục lọc sẵn theo dự án và chế độ", async ({ page }) => {
  await setup(page);
  // Truy vấn bảng có thể đi bằng GET (input trên URL) hoặc POST, nên gom cả hai để kiểm bộ lọc tới hub.
  const boards: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/rpc/sdlc/board")) boards.push(`${decodeURIComponent(req.url())} ${req.postData() ?? ""}`);
  });
  await page.goto("/sdlc/metrics");
  await page.getByLabel("Dự án", { exact: true }).selectOption(PAYMENT.id);
  await page.getByLabel("Chế độ", { exact: true }).selectOption("bugfix");
  await expect(page.getByText(/không lọc theo khoảng thời gian/)).toBeVisible();
  await page.getByRole("link", { name: "Mở bảng hạng mục với bộ lọc này" }).click();
  await expect(page).toHaveURL(new RegExp(`/sdlc\\?project=${PAYMENT.id}&mode=bugfix$`));
  await expect(page.getByLabel("Dự án", { exact: true })).toHaveValue(PAYMENT.id);
  await expect(page.getByLabel("Chế độ", { exact: true })).toHaveValue("bugfix");
  await expect.poll(() => boards.at(-1) ?? "").toContain('"modeRef":"bugfix"');
});

test("chưa có dữ liệu mời chọn 90 ngày; lỗi hub có nút thử lại", async ({ page }) => {
  const { inputs, hub } = await setup(page, { items: 0, fail: true });
  await page.goto("/sdlc/metrics");
  await expect(page.getByText("Không tải được dữ liệu.")).toBeVisible({ timeout: 15_000 });
  hub.failing = false;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByText("Chưa đủ dữ liệu để tính chỉ số.")).toBeVisible();
  await page.getByRole("button", { name: "Chọn 90 ngày" }).click();
  await expect.poll(() => span(inputs.at(-1) ?? { from: "", to: "" })).toBe(90);
});

for (const scheme of ["light", "dark"] as const) {
  test(`chỉ số 360 px, ${scheme}`, async ({ page }, testInfo) => {
    await setup(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/sdlc/metrics");
    await expect(page.getByText("Lead time theo giai đoạn")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`sdlc-metrics-360-${scheme}.png`), fullPage: true });
  });
}
