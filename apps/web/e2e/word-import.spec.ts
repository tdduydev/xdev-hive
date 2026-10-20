import { expect, type Page, test } from "@playwright/test";
import { inOrg } from "./reviews-fixture.ts";
import { WORD_IMPORT_ID, type WordImportPageOptions, wordImportPageScenario } from "./word-import-fixture.ts";

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
const SAMPLES = ["SRS-OPD v1.0.docx", "SRS-IPD v1.1.docx", "Quy-trinh-vien-phi.docx"];
const importUrl = `/knowledge/docs/word-imports/${WORD_IMPORT_ID}`;

async function setup(page: Page, options: WordImportPageOptions = {}) {
  const fixture = wordImportPageScenario(options);
  await inOrg(page, "admin", fixture.rpc);
  await fixture.install(page);
  return fixture;
}

async function openImport(page: Page, options: WordImportPageOptions = {}) {
  const fixture = await setup(page, options);
  await page.goto(importUrl);
  return fixture;
}

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

test("chọn 3 file mẫu, xem trước, đổi tên, tạo rồi mở tài liệu thấy bảng sửa được và ảnh", async ({ page }) => {
  const fixture = await setup(page, { slowGets: 2 });
  await page.goto("/knowledge/docs");
  await page.getByRole("button", { name: "Nhập Word", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nhập Word", exact: true });
  await expect(dialog.getByLabel("Thư mục đích")).toBeVisible();
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles(SAMPLES.map(docx));
  await expect(dialog.getByRole("status")).toContainText("3 file");
  await dialog.getByRole("button", { name: /^Tải lên/ }).click();
  await expect(page).toHaveURL(new RegExp(`${importUrl}$`));

  // Hub còn đang chuyển thì trang hỏi lại mỗi 2 giây và nút tạo chưa bấm được.
  await expect(page.getByText("Hub đang chuyển các file Word…")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Tạo \d+ tài liệu$/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tạo 3 tài liệu" })).toBeEnabled({ timeout: 10_000 });
  expect(fixture.calls.gets).toBeGreaterThanOrEqual(3);

  // Bảng file: tên gốc, đường dẫn, phiên bản, trạng thái, số cảnh báo.
  await expect(page.getByRole("row")).toHaveCount(4);
  const opd = row(page, "SRS-OPD v1.0.docx");
  await expect(opd).toContainText("docs/srs/OPD/srs-opd.md");
  await expect(opd).toContainText("1.0");
  await expect(opd).toContainText("Sẵn sàng");
  await expect(row(page, "SRS-IPD v1.1.docx").getByRole("cell").nth(5)).toHaveText("1");

  // Xem trước chỉ đọc có bảng và ảnh; cảnh báo hiện theo mã.
  await page.getByRole("button", { name: "Xem SRS-IPD v1.1.docx" }).click();
  const panel = page.getByRole("dialog", { name: "SRS-IPD v1.1.docx" });
  await expect(panel.getByRole("note")).toContainText("Có bảng lồng trong bảng");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Xem SRS-OPD v1.0.docx" }).click();
  const preview = page.getByRole("dialog", { name: "SRS-OPD v1.0.docx" });
  await expect(preview.getByRole("table")).toContainText("Đăng ký khám");
  const image = preview.getByRole("img", { name: "Sơ đồ tiếp đón" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  expect(await image.getAttribute("src")).toContain(`/files/`);
  expect(await image.getAttribute("src")).toContain("org=0a0a0a0a-0000-4000-8000-00000000000a");

  // Công tắc "Giữ phần trước tiêu đề đầu tiên" gửi keepFront và tải lại nội dung đã chuyển lại.
  await preview.getByRole("switch", { name: "Giữ phần trước tiêu đề đầu tiên" }).click();
  await expect(preview.getByText("Trang bìa", { exact: true })).toBeVisible();
  expect(fixture.calls.update).toContainEqual({ fileId: "20202020-0000-4000-8000-0000000000c1", keepFront: true });
  await page.keyboard.press("Escape");

  // Đổi tên tại chỗ: đường dẫn phải là .md.
  await page.getByRole("button", { name: "Đổi tên SRS-OPD v1.0.docx" }).click();
  const path = page.getByRole("textbox", { name: "Đường dẫn tài liệu của SRS-OPD v1.0.docx" });
  await path.fill("docs/srs/OPD/srs-opd.docx");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đường dẫn tài liệu phải kết thúc bằng .md.")).toBeVisible();
  await path.fill("docs/srs/OPD/srs-opd-v1.md");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(opd).toContainText("docs/srs/OPD/srs-opd-v1.md");

  await page.getByRole("button", { name: "Tạo 3 tài liệu" }).click();
  const report = page.getByRole("region", { name: "Kết quả" });
  await expect(report).toContainText("Đã tạo 3 tài liệu");
  await expect(page.getByRole("button", { name: /^Tạo \d+ tài liệu$/ })).toHaveCount(0);

  // Mở tài liệu từ báo cáo: bảng sửa được và ảnh đã phân giải.
  await report.getByRole("link", { name: "SRS OPD" }).click();
  await expect(page).toHaveURL(/\/knowledge\/docs\/org%2Fsrs-opd-v1\/edit$/);
  const editor = page.getByRole("textbox", { name: "Nội dung tài liệu" });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  const table = editor.getByRole("table");
  await expect(table).toBeVisible();
  const cell = table.getByRole("cell", { name: "Đăng ký khám" });
  await cell.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (đã sửa)");
  await expect(cell).toHaveText("Đăng ký khám (đã sửa)");
  const doc = page.getByRole("img", { name: "Sơ đồ tiếp đón" });
  await expect(doc).toBeVisible();
  await expect.poll(() => doc.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

test("lọc theo trạng thái và trạng thái rỗng", async ({ page }) => {
  await openImport(page, { secret: true });
  await expect(page.getByRole("row")).toHaveCount(4);
  const filters = page.getByRole("group", { name: "Lọc theo trạng thái" });
  await filters.getByRole("button", { name: /^Có bí mật/ }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(row(page, "Quy-trinh-vien-phi.docx")).toContainText("Có bí mật");
  await filters.getByRole("button", { name: /^Sẵn sàng/ }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(filters.getByRole("button", { name: /^Lỗi/ })).toHaveCount(0);
});

test("file có bí mật: chỉ hiện loại và dòng, người manage được nhập tiếp", async ({ page }) => {
  const fixture = await openImport(page, { secret: true });
  await expect(page.getByRole("button", { name: "Tạo 2 tài liệu" })).toBeEnabled();
  await page.getByRole("button", { name: "Xem Quy-trinh-vien-phi.docx" }).click();
  const panel = page.getByRole("dialog", { name: "Quy-trinh-vien-phi.docx" });
  await expect(panel).toContainText("dòng 12 (mật khẩu hoặc token)");
  await panel.getByRole("button", { name: "Không phải bí mật, vẫn nhập" }).click();
  expect(fixture.calls.commit).toEqual([
    { importId: WORD_IMPORT_ID, fileIds: ["20202020-0000-4000-8000-0000000000c3"], acknowledgeSecrets: true },
  ]);
  // Ngăn bên là hộp thoại modal nên bảng phía sau ẩn khỏi cây trợ năng tới khi đóng.
  await page.keyboard.press("Escape");
  await expect(row(page, "Quy-trinh-vien-phi.docx")).toContainText("Đã tạo");
});

test("quyền chỉ đề xuất: nút Gửi duyệt và không có nút bỏ qua bí mật", async ({ page }) => {
  await openImport(page, { access: "propose", secret: true });
  await expect(page.getByText("sẽ được gửi duyệt thay vì tạo ngay")).toBeVisible();
  await page.getByRole("button", { name: "Xem Quy-trinh-vien-phi.docx" }).click();
  await expect(page.getByRole("button", { name: "Không phải bí mật, vẫn nhập" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Gửi duyệt 2 tài liệu" }).click();
  await expect(page.getByRole("region", { name: "Kết quả" })).toContainText("Đã gửi duyệt 2 tài liệu");
});

test("đường dẫn đã có tài liệu: chặn tạo, có Đổi tên và Cập nhật từ Word chưa bấm được", async ({ page }) => {
  await openImport(page, { exists: true });
  const opd = row(page, "SRS-OPD v1.0.docx");
  await expect(opd).toContainText("Đã có");
  await expect(page.getByRole("button", { name: /^Tạo \d+ tài liệu$/ })).toBeDisabled();
  await expect(opd.getByRole("button", { name: "Cập nhật từ Word" })).toBeDisabled();
  await opd.getByRole("button", { name: "Đổi tên", exact: true }).click();
  await page.getByRole("textbox", { name: /Đường dẫn tài liệu của/ }).fill("docs/srs/OPD/srs-opd-moi.md");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByRole("button", { name: "Tạo 3 tài liệu" })).toBeEnabled();
});

test("một file lỗi khi tạo: báo cáo có lý do tiếng Việt, các file khác vẫn tạo", async ({ page }) => {
  await openImport(page, { failOnCommit: true });
  await page.getByRole("button", { name: "Tạo 3 tài liệu" }).click();
  const report = page.getByRole("region", { name: "Kết quả" });
  await expect(report).toContainText("Đã tạo 2 tài liệu");
  await expect(report).toContainText("Không tạo được 1 file");
  await expect(report).toContainText("SRS-IPD v1.1.docx");
  await expect(report).toContainText("Đường dẫn này đã có tài liệu.");
});

test("huỷ lượt nhập", async ({ page }) => {
  const fixture = await openImport(page);
  await page.getByRole("button", { name: "Huỷ lượt nhập" }).click();
  await expect.poll(() => fixture.calls.cancel).toBe(1);
  await expect(page.getByRole("button", { name: "Huỷ lượt nhập" })).toHaveCount(0);
  await expect(row(page, "SRS-OPD v1.0.docx")).toContainText("Đã huỷ");
});

test("gắn với file Word từ trang soạn: khác biệt từng khối, lấy bản chuyển làm gốc", async ({ page }) => {
  const fixture = await setup(page, { mode: "link" });
  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  await page.getByRole("button", { name: "Gắn với file Word" }).click();
  const dialog = page.getByRole("dialog", { name: "Gắn với file Word" });
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("SRS-OPD v1.0.docx")]);
  await dialog.getByRole("button", { name: /^Tải lên/ }).click();
  await expect(page).toHaveURL(new RegExp(`${importUrl}$`));
  expect(fixture.state.uploads[0]?.fields).toMatchObject({ mode: ["link"], docKey: ["org/srs-0"] });

  await expect(page.getByRole("heading", { name: "Gắn tài liệu với file Word" })).toBeVisible();
  const diff = page.getByRole("region", { name: "Khác biệt từng khối" });
  await expect(diff).toContainText("Mô tả cũ.");
  await expect(diff).toContainText("Sơ đồ tiếp đón");
  await page.getByRole("button", { name: "Lấy bản chuyển làm gốc" }).click();
  await expect(page.getByText("Đã lấy bản chuyển làm gốc.")).toBeVisible();
  expect(fixture.calls.confirmLink).toBe(1);
});

test("gắn: huỷ giữ nguyên tài liệu", async ({ page }) => {
  const fixture = await openImport(page, { mode: "link" });
  await page.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(page.getByText("Đã huỷ. Tài liệu giữ nguyên")).toBeVisible();
  expect(fixture.calls.cancel).toBe(1);
  expect(fixture.calls.confirmLink).toBe(0);
});

test("gắn: nội dung khớp thì không cần xác nhận", async ({ page }) => {
  await openImport(page, { mode: "link", linkMatches: true });
  await expect(page.getByRole("button", { name: "Lấy bản chuyển làm gốc" })).toHaveCount(0);
  await expect(page.getByText("Đang gắn tài liệu…")).toBeVisible();
});

test("trang soạn không hiện nút gắn khi hub không có pandoc", async ({ page }) => {
  await setup(page, { health: { wordImport: false } });
  await page.goto("/knowledge/docs/org%2Fsrs-0/edit");
  await expect(page.getByText("Đang soạn", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gắn với file Word" })).toHaveCount(0);
});

test("360px: bảng cuộn trong khung, trang không cuộn ngang", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openImport(page);
  await expect(page.getByRole("button", { name: "Tạo 3 tài liệu" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("tối: trang vẫn đọc được", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openImport(page);
  await expect(page.getByRole("button", { name: "Tạo 3 tài liệu" })).toBeVisible();
  await expect(row(page, "SRS-OPD v1.0.docx").getByText("Sẵn sàng")).toBeVisible();
});
