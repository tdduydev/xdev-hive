import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { inOrg } from "./reviews-fixture.ts";
import {
  WORD_ORIGINAL_BYTES,
  WORD_ORIGINAL_NAME,
  type WordHistoryOptions,
  wordImportHistoryScenario,
} from "./word-import-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";

async function setup(page: Page, options: WordHistoryOptions = {}) {
  const fixture = wordImportHistoryScenario(options);
  await inOrg(page, "admin", fixture.rpc);
  await fixture.install(page);
  return fixture;
}

const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test("tài liệu nhập từ Word hiện nhãn có tên file, ngày, người nhập và tải được file gốc", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  const label = page.getByText("Nhập từ Word", { exact: true });
  await expect(label).toBeVisible();
  const line = page.locator("p", { has: label });
  await expect(line).toContainText(WORD_ORIGINAL_NAME);
  await expect(line).toContainText("Quản trị");
  await expect(line.locator("time")).toHaveAttribute("datetime", "2026-10-19T03:00:00.000Z");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tải file Word gốc" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(WORD_ORIGINAL_NAME);
  const path = await file.path();
  expect((await readFile(path)).equals(WORD_ORIGINAL_BYTES)).toBe(true);
  // Hub chọn tổ chức theo header; thiếu nó là 400 dù đã đăng nhập.
  expect(fixture.history.originals).toEqual([ORG_ID]);
});

test("tải file gốc lỗi thì báo lỗi của hub và cho thử lại", async ({ page }) => {
  await setup(page, { originalFails: true });
  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  const button = page.getByRole("button", { name: "Tải file Word gốc" });
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "Không tìm thấy file Word gốc." })).toBeVisible();
  await expect(button).toBeEnabled();
});

test("tài liệu không nhập từ Word thì không hiện nhãn và nút tải", async ({ page }) => {
  await setup(page);
  await page.goto("/knowledge/docs/org%2Fsrs-1/edit");
  // Chờ editor dựng xong rồi mới khẳng định vắng mặt, để không đúng chỉ vì trang chưa tải.
  await expect(page.getByRole("button", { name: "Gắn với file Word" })).toBeVisible();
  await expect(page.getByText("Nhập từ Word", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tải file Word gốc" })).toHaveCount(0);
});

test("trang Tài liệu có link tới danh sách lượt nhập; danh sách nêu trạng thái và số file", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/knowledge/docs");
  await page.getByRole("link", { name: "Lượt nhập Word" }).click();
  await expect(page).toHaveURL(/\/knowledge\/docs\/word-imports$/);
  await expect(page.getByRole("heading", { name: "Các lượt nhập Word" })).toBeVisible();

  await expect(page.getByRole("row")).toHaveCount(4);
  const created = row(page, "docs/srs/");
  await expect(created).toContainText("Tạo tài liệu mới");
  await expect(created).toContainText("Quản trị");
  await expect(created).toContainText("Hoàn tất");
  await expect(created).toContainText("3 đã tạo");
  const update = row(page, "org/srs-0");
  await expect(update).toContainText("Cập nhật tài liệu");
  await expect(update).toContainText("Chờ xác nhận");
  await expect(update).toContainText("1 sẵn sàng");
  const failed = row(page, "Thư mục gốc");
  await expect(failed).toContainText("Lỗi");
  await expect(failed).toContainText("1 lỗi");
  await expect(failed).toContainText("1 có bí mật");
  // Người nhập không có tên (tài khoản đã xoá) vẫn có chỗ đứng thay vì ô trống.
  await expect(failed.getByRole("cell").nth(1)).toHaveText("—");
  expect(fixture.history.listCalls[0]).toMatchObject({ homeId: fixture.orgHome.id });

  // Link của dòng mở trang lượt nhập.
  await created.getByRole("link", { name: "Tạo tài liệu mới" }).click();
  await expect(page).toHaveURL(/\/knowledge\/docs\/word-imports\/20202020-0000-4000-8000-0000000000b1$/);
});

test("lọc theo trạng thái và đổi nơi lưu; trạng thái rỗng nói điều sẽ hiện", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/knowledge/docs/word-imports");
  await expect(page.getByRole("row")).toHaveCount(4);

  await page.getByLabel("Trạng thái").selectOption("failed");
  await expect(page.getByRole("row")).toHaveCount(2);
  expect(fixture.history.listCalls.at(-1)).toMatchObject({ state: "failed" });
  await page.getByLabel("Trạng thái").selectOption("cancelled");
  await expect(page.getByRole("heading", { name: "Không có lượt nhập nào ở trạng thái này" })).toBeVisible();
  await page.getByLabel("Trạng thái").selectOption("");

  // Nhà dự án chưa có lượt nào.
  const home = page.getByLabel("Nơi lưu");
  const options = await home.locator("option").allTextContents();
  const project = options.find((text) => text.startsWith("Dự án"));
  if (!project) throw new Error("Thiếu nhà dự án trong danh sách nơi lưu.");
  await home.selectOption({ label: project });
  await expect(page.getByRole("heading", { name: "Chưa có lượt nhập Word nào" })).toBeVisible();
  await expect(page.getByText("Bấm “Nhập Word” ở trang Tài liệu")).toBeVisible();
});

test("danh sách lỗi thì báo lỗi và cho thử lại", async ({ page }) => {
  const fixture = await setup(page, { listFails: true });
  await page.goto("/knowledge/docs/word-imports");
  const failure = page.getByRole("alert");
  await expect(failure).toBeVisible();
  fixture.healList();
  await failure.getByRole("button", { name: "Tải lại" }).click();
  await expect(page.getByRole("row")).toHaveCount(4);
});

test("hub không nhận Word thì không có link và trang nói rõ lý do", async ({ page }) => {
  await setup(page, { health: { wordImport: false, wordImportDoc: false } });
  await page.goto("/knowledge/docs");
  await expect(page.getByLabel("Tìm theo nghĩa")).toBeVisible();
  await expect(page.getByRole("link", { name: "Lượt nhập Word" })).toHaveCount(0);
  await page.goto("/knowledge/docs/word-imports");
  await expect(page.getByRole("heading", { name: "Hub chưa nhận file Word" })).toBeVisible();
});

test("360px: danh sách và nhãn không làm trang cuộn ngang", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await setup(page);
  await page.goto("/knowledge/docs/word-imports");
  await expect(page.getByRole("row")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  await expect(page.getByRole("button", { name: "Tải file Word gốc" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test("bàn phím: tới link dòng và nút tải file gốc bằng Tab, kích hoạt bằng Enter", async ({ page }) => {
  await setup(page);
  await page.goto("/knowledge/docs/word-imports");
  await expect(page.getByRole("row")).toHaveCount(4);
  const link = row(page, "docs/srs/").getByRole("link", { name: "Tạo tài liệu mới" });
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/knowledge\/docs\/word-imports\/20202020-0000-4000-8000-0000000000b1$/);

  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  const button = page.getByRole("button", { name: "Tải file Word gốc" });
  await button.focus();
  await expect(button).toBeFocused();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toBe(WORD_ORIGINAL_NAME);
});
