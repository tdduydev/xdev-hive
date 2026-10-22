import { expect, type Page, test } from "@playwright/test";
import { inOrg } from "./reviews-fixture.ts";
import {
  WORD_CONFLICT_ID,
  WORD_IMPORT_ID,
  type WordImportPageOptions,
  wordImportPageScenario,
} from "./word-import-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const docx = (name: string) => ({
  name,
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: Buffer.from(name),
});
const importUrl = `/knowledge/docs/word-imports/${WORD_IMPORT_ID}`;

async function setup(page: Page, options: WordImportPageOptions) {
  const fixture = wordImportPageScenario(options);
  await inOrg(page, "admin", fixture.rpc);
  await fixture.install(page);
  return fixture;
}

/** Từ trang soạn: "Cập nhật từ Word" mở hộp thoại một file, tải lên rồi sang trang lượt nhập. */
async function updateFromEditor(page: Page, options: WordImportPageOptions) {
  const fixture = await setup(page, { ...options, mode: "update" });
  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  await page.getByRole("button", { name: "Cập nhật từ Word" }).click();
  const dialog = page.getByRole("dialog", { name: "Cập nhật từ Word" });
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("SRS-OPD v1.1.docx")]);
  await dialog.getByRole("button", { name: /^Tải lên/ }).click();
  await expect(page).toHaveURL(new RegExp(`${importUrl}$`));
  expect(fixture.state.uploads[0]?.fields).toMatchObject({ mode: ["update"], docKey: ["org/srs-0"] });
  return fixture;
}

test("cập nhật từ Word hợp sạch thì lưu phiên bản mới", async ({ page }) => {
  const fixture = await updateFromEditor(page, { outcome: "clean" });
  await expect(page.getByRole("heading", { name: "Cập nhật tài liệu từ Word" })).toBeVisible();
  await expect(page.getByText("Hợp sạch. Bản Word mới hợp được")).toBeVisible();
  await page.getByRole("button", { name: "Cập nhật tài liệu" }).click();
  await expect(page.getByText("Hợp sạch. Đã lưu phiên bản 3 của tài liệu.")).toBeVisible();
  expect(fixture.calls.commit).toHaveLength(1);
});

test("cập nhật có chỗ chồng nhau thì dẫn tới trang xung đột có nhãn Word", async ({ page }) => {
  await updateFromEditor(page, { outcome: "overlap" });
  await expect(page.getByText("Có chỗ chồng nhau").first()).toBeVisible();
  await page.getByRole("button", { name: "Cập nhật tài liệu" }).click();
  await expect(page.getByText("1 chỗ chồng nhau")).toBeVisible();
  await page.getByRole("link", { name: "Giải quyết xung đột" }).click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/docs/conflicts/${WORD_CONFLICT_ID}$`));
  await expect(page.getByRole("button", { name: "Giữ bản Word" })).toBeVisible();
  await expect(page.getByText("Hub và file Word cùng sửa 1 chỗ")).toBeVisible();
  await expect(page.getByText("Giữ bản repo")).toHaveCount(0);
});

test("cập nhật trùng lần nhập trước thì báo không có gì thay đổi", async ({ page }) => {
  await updateFromEditor(page, { outcome: "unchanged" });
  await expect(page.getByText("Không có gì thay đổi so với lần nhập Word trước.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cập nhật tài liệu" })).toHaveCount(0);
});

test("người chỉ có quyền đề xuất gửi duyệt, người duyệt chọn nhiều file để duyệt", async ({ page }) => {
  const fixture = await setup(page, { access: "propose" });
  await page.goto(importUrl);
  await expect(page.getByRole("button", { name: "Duyệt các file đã chọn" })).toHaveCount(0);
  await page.getByRole("button", { name: "Gửi duyệt 3 tài liệu" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Đã gửi duyệt" })).toHaveCount(3);

  fixture.setAccess("manage");
  await page.reload();
  const approve = page.getByRole("button", { name: "Duyệt các file đã chọn" });
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: "Chọn SRS-OPD v1.0.docx để duyệt" }).check();
  await page.getByRole("checkbox", { name: "Chọn SRS-IPD v1.1.docx để duyệt" }).check();
  await approve.click();
  await expect.poll(() => fixture.calls.approve.length).toBe(1);
  expect((fixture.calls.approve[0] as { fileIds: string[] }).fileIds).toHaveLength(2);
  await expect(page.getByRole("row").filter({ hasText: "Đã gửi duyệt" })).toHaveCount(1);
});
