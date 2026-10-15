import { expect, type Page, test } from "@playwright/test";
import { DUP_KEY, docsyncImportScenario } from "./docsync-import-fixture.ts";
import { inOrg } from "./reviews-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const tree = (page: Page) => page.getByRole("list", { name: "Cây file trong repo" });
const scan = async (page: Page) => {
  await page.goto("/knowledge/docs/import");
  await page.getByRole("button", { name: "Quét repo", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Chọn cả thư mục docs", exact: true })).toBeVisible();
};

test("quét, chọn theo thư mục, giải quyết trùng key, nhập và xem báo cáo", async ({ page }) => {
  const fixture = docsyncImportScenario();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/knowledge/docs/import");
  await page.getByRole("textbox", { name: "Mẫu lấy", exact: true }).fill("docs/**\nspecs/**\nREADME.md");
  await page.getByRole("button", { name: "Quét repo", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Chọn cả thư mục docs", exact: true })).toBeVisible();
  expect(fixture.state.scans).toEqual([
    expect.objectContaining({ include: ["docs/**", "specs/**", "README.md"], exclude: ["**/node_modules/**"] }),
  ]);

  // Mặc định chọn mọi file nhập được: docs/a.md, docs/guide/b.md, specs/x.md, docs/slides.pdf.
  await expect(page.getByText("Đã chọn 4/6 file")).toBeVisible();
  await page.getByRole("button", { name: "Mở thư mục docs/guide", exact: true }).click();
  await expect(tree(page).getByText("dòng 12 (GitHub token)")).toBeVisible();
  await expect(tree(page).getByText("Trùng key với tài liệu có sẵn.")).toBeVisible();
  await expect(tree(page).getByText("File quá lớn, chỉ lưu bản đính kèm.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Chọn docs/guide/secret.md" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Chọn docs/guide/dup.md" })).toBeDisabled();

  await page.getByRole("checkbox", { name: "Chọn cả thư mục specs", exact: true }).click();
  await expect(page.getByText("Đã chọn 3/6 file")).toBeVisible();

  await page.getByLabel(`Trùng key ${DUP_KEY}`).selectOption("rename");
  await page.getByLabel("Key mới cho docs/guide/dup.md").fill("project/payment-api/guide/dup-hub");
  await expect(page.getByText("Đã chọn 4/6 file")).toBeVisible();

  await page.getByRole("button", { name: "Nhập 4 file", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("region", { name: "Báo cáo nhập" })).toBeVisible();
  expect(fixture.state.started?.paths.sort()).toEqual([
    "docs/a.md",
    "docs/guide/b.md",
    "docs/guide/dup.md",
    "docs/slides.pdf",
  ]);
  expect(fixture.state.started?.resolutions).toEqual([
    { path: "docs/guide/dup.md", action: "rename", key: "project/payment-api/guide/dup-hub" },
  ]);
  const report = page.getByRole("region", { name: "Báo cáo nhập" });
  await expect(report.getByText("Đã nhập", { exact: true }).locator("xpath=following-sibling::dd")).toHaveText("4");
  await expect(tree(page).getByText("Đã có").first()).toBeVisible();
});

test("file bí mật: hộp xác nhận nói rõ lịch sử git, không lộ giá trị, ghi nhận từng file", async ({ page }) => {
  const fixture = docsyncImportScenario();
  await inOrg(page, "admin", fixture.rpc);
  await scan(page);
  await page.getByRole("button", { name: "Mở thư mục docs/guide", exact: true }).click();
  await page.getByRole("button", { name: "Không phải bí mật, vẫn nhập" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("lịch sử git", { exact: false })).toBeVisible();
  await expect(dialog.getByText("dòng 12 (GitHub token)", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.confirmed).toEqual([]);
  await page.getByRole("button", { name: "Không phải bí mật, vẫn nhập" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Không phải bí mật, vẫn nhập" }).click();
  await expect(page.getByText("Đã xếp nhập lại file này.")).toBeVisible();
  expect(fixture.state.confirmed).toEqual(["docs/guide/secret.md"]);
});

test("huỷ giữa chừng và xếp lại bản quét", async ({ page }) => {
  const fixture = docsyncImportScenario({ many: true });
  await inOrg(page, "admin", fixture.rpc);
  await scan(page);
  // 250 file ở nhiều trang: nút nhập chỉ bật khi đã tải đủ.
  await expect(page.getByText("Đã chọn 254/256 file")).toBeVisible();
  await page.getByRole("button", { name: "Nhập 254 file", exact: true }).click();
  await page.getByRole("button", { name: "Huỷ lần nhập", exact: true }).click();
  await expect(page.getByRole("region", { name: "Báo cáo nhập" })).toContainText("đã huỷ giữa chừng");
  expect(fixture.state.cancelled).toBe(true);
});

test("360 px, sáng/tối: không tràn ngang, thao tác bằng bàn phím", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const fixture = docsyncImportScenario();
  await inOrg(page, "admin", fixture.rpc);
  await scan(page);
  await page.getByRole("checkbox", { name: "Chọn cả thư mục docs", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Đã chọn 1/6 file")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
