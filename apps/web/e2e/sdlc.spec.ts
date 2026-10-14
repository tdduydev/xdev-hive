import { expect, type Page, test } from "@playwright/test";
import { SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";
import { inOrg, type Role } from "./reviews-fixture.ts";
import { sdlcFixture } from "./sdlc-fixture.ts";

async function setup(page: Page, opts: { role?: Role; readOnly?: boolean } = {}) {
  const sdlc = sdlcFixture({ canWrite: !opts.readOnly });
  const role = opts.role ?? "member";
  const mine = opts.readOnly
    ? SYSTEM_ROLE_PERMISSIONS[role].filter((p) => p !== "sdlc.write")
    : [...SYSTEM_ROLE_PERMISSIONS[role]];
  const hub = await inOrg(page, role, sdlc.rpc, mine);
  return { ...sdlc, hub };
}

const board = (page: Page) => page.getByRole("region", { name: "Bảng hạng mục theo giai đoạn" });

test("menu AI SDLC có số câu hỏi chờ; bảng mở chi tiết và tab nằm trên đường dẫn", async ({ page }) => {
  await setup(page);
  await page.goto("/sdlc");
  await expect(page.getByRole("heading", { name: "Hạng mục", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Câu hỏi chờ tôi/ })).toContainText("2 câu hỏi đang chờ bạn trả lời");

  await page
    .getByRole("link", { name: /Hoàn tiền một phần/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/sdlc\/payment-api\/12$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hoàn tiền một phần");

  const tabs = page.getByRole("tablist", { name: "Các mục của hạng mục" });
  await tabs.getByRole("tab", { name: /Câu hỏi/ }).click();
  await expect(page).toHaveURL(/\/sdlc\/payment-api\/12\/questions$/);
  await expect(page.getByText("Hoàn tiền có cần duyệt của kế toán không?").first()).toBeVisible();

  // Mở thẳng đường dẫn có tab giữ đúng tab; quay lại Tổng quan bỏ đoạn tab.
  await page.goto("/sdlc/payment-api/12/questions");
  await expect(tabs.getByRole("tab", { name: /Câu hỏi/ })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Tổng quan" }).click();
  await expect(page).toHaveURL(/\/sdlc\/payment-api\/12$/);
});

test("câu hỏi chờ tôi: dùng đề xuất gửi ngay, câu còn lại chọn lựa chọn rồi gửi", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/sdlc/questions");
  await expect(page.getByRole("heading", { name: "Câu hỏi chờ tôi", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Dùng đề xuất" }).first().click();
  await expect.poll(() => state.answered).toEqual([{ id: expect.any(String), useRecommended: true }]);

  await page.getByRole("radio", { name: "Không giới hạn" }).check();
  await page.getByRole("button", { name: "Gửi câu trả lời (1/1)" }).click();
  await expect.poll(() => state.answered.length).toBe(2);
  expect(state.answered[1]).toMatchObject({ answer: "Không giới hạn" });
  await expect(page.getByText("Không có câu hỏi nào đang chờ bạn.")).toBeVisible();
});

test("tạo hạng mục là một liên kết của bảng", async ({ page }) => {
  await setup(page);
  await page.goto("/sdlc");
  await page.getByRole("link", { name: "Tạo hạng mục" }).first().click();
  await expect(page).toHaveURL(/\/sdlc\/new$/);
  await expect(page.getByRole("heading", { name: "Tạo hạng mục", level: 1 })).toBeVisible();
});

test("người chỉ đọc thấy bảng và chi tiết nhưng không tạo hay trả lời được", async ({ page }) => {
  const { hub } = await setup(page, { readOnly: true });
  await page.goto("/sdlc");
  await expect(board(page).getByText("Hoàn tiền một phần")).toBeVisible();
  await expect(page.getByRole("link", { name: "Tạo hạng mục" })).toHaveCount(0);
  await page.goto("/sdlc/payment-api/12/questions");
  await expect(page.getByText("Hoàn tiền có cần duyệt của kế toán không?").first()).toBeVisible();
  // Ô trả lời vẫn hiện để người chỉ đọc xem được lựa chọn, nhưng bị khoá.
  await expect(page.getByRole("button", { name: /Gửi câu trả lời/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Dùng đề xuất" }).first()).toBeDisabled();
  expect(hub.rpcCalls.some((c) => c.path === "sdlc/items/get")).toBe(true);
  expect(hub.rpcCalls.every((c) => c.path !== "sdlc/questions/answer")).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`AI SDLC ở 360 px, giao diện ${scheme}: không tràn ngang`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setup(page);
    await page.setViewportSize({ width: 360, height: 800 });
    for (const [name, path] of [
      ["board", "/sdlc"],
      ["item", `/sdlc/payment-api/12`],
      ["questions", "/sdlc/questions"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`sdlc-${name}-360-${scheme}.png`), fullPage: true });
    }
  });
}
