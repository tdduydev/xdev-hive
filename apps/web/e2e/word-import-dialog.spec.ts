import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { wordImportFailure, wordImportScenario } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";
import { WORD_IMPORT_ID, type WordImportOptions } from "./word-import-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const docx = (name: string, text = name) => ({
  name,
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: Buffer.from(text),
});

async function openDocs(page: Page, options: WordImportOptions = {}) {
  const fixture = wordImportScenario(options);
  await inOrg(page, "admin", fixture.rpc);
  await fixture.install(page);
  await page.goto("/knowledge/docs");
  return fixture;
}

const openDialog = async (page: Page) => {
  await page.getByRole("button", { name: "Nhập Word", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nhập Word", exact: true });
  await expect(dialog).toBeVisible();
  // Nhà đã tải xong thì ô thư mục đích mới hiện.
  await expect(dialog.getByLabel("Thư mục đích")).toBeVisible();
  return dialog;
};

const upload = (dialog: ReturnType<Page["getByRole"]>) => dialog.getByRole("button", { name: /^Tải lên/ });

test("nút Nhập Word nằm cạnh Tài liệu mới, ẩn khi hub không có pandoc", async ({ page }) => {
  await openDocs(page);
  const open = page.getByRole("button", { name: "Nhập Word", exact: true });
  await expect(open).toBeVisible();
  await expect(page.getByRole("button", { name: "Tài liệu mới", exact: true })).toBeVisible();
  const [a, b] = await Promise.all([
    open.boundingBox(),
    page.getByRole("button", { name: "Tài liệu mới" }).boundingBox(),
  ]);
  expect(a && b && Math.abs(a.y - b.y) < 4).toBe(true);
});

test("hub báo wordImport false thì ẩn nút", async ({ page }) => {
  const fixture = await openDocs(page, { health: { wordImport: false } });
  await expect(page.getByRole("button", { name: "Tài liệu mới", exact: true })).toBeVisible();
  await expect.poll(() => fixture.state.healthCalls).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Nhập Word" })).toHaveCount(0);
});

test("chọn file, bỏ file không phải Word, tải lên kèm nhà, thư mục, nhãn mật rồi mở trang lượt nhập", async ({
  page,
}) => {
  const fixture = await openDocs(page);
  const dialog = await openDialog(page);
  // Kho tổ chức đứng đầu, mặc định mật (cài đặt của nhà) và thư mục đích là gốc nhà.
  await expect(dialog.getByLabel("Nhà tài liệu")).toHaveValue(fixture.orgHome.id);
  await expect(dialog.getByRole("switch", { name: "Tài liệu mật" })).toBeChecked();
  await expect(upload(dialog)).toBeDisabled();

  await dialog.getByLabel("Nhà tài liệu").selectOption({ label: "Dự án Payment API" });
  await expect(dialog.getByLabel("Thư mục đích")).toHaveValue("docs/");
  await expect(dialog.getByRole("switch", { name: "Tài liệu mật" })).not.toBeChecked();
  await dialog.getByLabel("Thư mục đích").fill("docs/srs/OPD");

  await dialog
    .getByLabel("File Word", { exact: true })
    .setInputFiles([
      docx("SRS-OPD v1.0.docx"),
      docx("quy-trinh.odt"),
      { name: "ghi-chu.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") },
      docx("~$SRS-OPD v1.0.docx"),
    ]);
  await expect(dialog.getByText("Bỏ qua 1 file không phải Word", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Bỏ qua 1 file tạm của Word", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("2 file");
  await dialog.getByRole("button", { name: "Bỏ quy-trinh.odt" }).click();
  await expect(dialog.getByRole("status")).toContainText("1 file");
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("quy-trinh.odt")]);
  await expect(dialog.getByRole("status")).toContainText("2 file");

  await dialog.getByRole("switch", { name: "Tài liệu mật" }).click();
  await upload(dialog).click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/docs/word-imports/${WORD_IMPORT_ID}$`));
  await expect(page.getByRole("heading", { name: "Lượt nhập Word" })).toBeVisible();

  expect(fixture.state.uploads).toHaveLength(1);
  const sent = fixture.state.uploads[0];
  expect(sent?.org).toBe("0a0a0a0a-0000-4000-8000-00000000000a");
  expect(sent?.fields).toMatchObject({
    homeId: [fixture.projectHome.id],
    mode: ["create"],
    targetDir: ["docs/srs/OPD/"],
    confidential: ["true"],
    relativePaths: ["", ""],
  });
  expect(sent?.fields.lastModified).toHaveLength(2);
  expect(sent?.files.map((file) => file.name)).toEqual(["SRS-OPD v1.0.docx", "quy-trinh.odt"]);
});

test("chọn thư mục giữ thư mục con trong relativePaths", async ({ page }) => {
  const fixture = await openDocs(page);
  const dir = await mkdtemp(join(tmpdir(), "word-import-"));
  try {
    await mkdir(join(dir, "SRS", "OPD"), { recursive: true });
    await writeFile(join(dir, "SRS", "a.docx"), "a");
    await writeFile(join(dir, "SRS", "OPD", "b.docx"), "b");
    await writeFile(join(dir, "SRS", "ghi-chu.txt"), "c");
    const dialog = await openDialog(page);
    await dialog.getByLabel("Thư mục Word", { exact: true }).setInputFiles(join(dir, "SRS"));
    await expect(dialog.getByRole("status")).toContainText("2 file");
    await expect(dialog.getByText("Bỏ qua 1 file không phải Word", { exact: false })).toBeVisible();
    await upload(dialog).click();
    await expect(page).toHaveURL(/word-imports\//);
    expect(fixture.state.uploads[0]?.fields.relativePaths?.sort()).toEqual(["SRS", "SRS/OPD"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kéo thả file vào vùng chọn", async ({ page }) => {
  const fixture = await openDocs(page);
  const dialog = await openDialog(page);
  const zone = dialog.getByRole("region", { name: "Chọn file Word" });
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "keo-tha.docx"));
    transfer.items.add(new File(["x"], "bo-qua.png"));
    return transfer;
  });
  await zone.dispatchEvent("drop", { dataTransfer: data });
  await expect(dialog.getByRole("status")).toContainText("1 file");
  await expect(dialog.getByText("keo-tha.docx")).toBeVisible();
  await upload(dialog).click();
  await expect(page).toHaveURL(/word-imports\//);
  expect(fixture.state.uploads[0]?.files.map((file) => file.name)).toEqual(["keo-tha.docx"]);
});

test(".doc bị tắt khi hub chưa có LibreOffice", async ({ page }) => {
  await openDocs(page, { health: { wordImportDoc: false } });
  const dialog = await openDialog(page);
  await expect(dialog.getByText(".docx, .odt ·", { exact: false })).toBeVisible();
  await dialog
    .getByLabel("File Word", { exact: true })
    .setInputFiles([{ name: "cu.doc", mimeType: "application/msword", buffer: Buffer.from("x") }]);
  await expect(dialog.getByText("hub chưa cài LibreOffice", { exact: false })).toBeVisible();
  await expect(upload(dialog)).toBeDisabled();
});

test("chặn sớm quá 100 file và file quá 50 MB, bỏ bớt thì tải lên được", async ({ page }) => {
  const fixture = await openDocs(page);
  const dialog = await openDialog(page);
  await dialog
    .getByLabel("File Word", { exact: true })
    .setInputFiles(Array.from({ length: 101 }, (_, i) => docx(`f${String(i).padStart(3, "0")}.docx`)));
  await expect(dialog.getByText("Quá 100 file một lượt (đang chọn 101)", { exact: false })).toBeVisible();
  await expect(upload(dialog)).toBeDisabled();
  await dialog.getByRole("button", { name: "Bỏ f100.docx" }).click();
  await expect(dialog.getByText("Quá 100 file", { exact: false })).toHaveCount(0);
  await expect(upload(dialog)).toBeEnabled();

  await dialog.getByRole("button", { name: "Bỏ chọn hết" }).click();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="File Word"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new ArrayBuffer(51 * 1024 * 1024)], "to.docx"));
    if (!input) throw new Error("không có ô chọn file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(dialog.getByText("to.docx (51 MB) vượt 50 MB một file", { exact: false })).toBeVisible();
  await expect(upload(dialog)).toBeDisabled();
  await dialog.getByRole("button", { name: "Bỏ to.docx" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(fixture.state.uploads).toHaveLength(0);
});

test("thư mục đích: gợi ý từ cây tài liệu, chặn thư mục ngoài gốc nhà", async ({ page }) => {
  await openDocs(page);
  const dialog = await openDialog(page);
  await dialog.getByLabel("Nhà tài liệu").selectOption({ label: "Dự án Payment API" });
  const options = await dialog
    .locator("datalist option")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(options).toEqual(
    expect.arrayContaining(["docs/", "docs/srs/", "docs/srs/OPD/", "docs/srs/IPD/", "docs/guide/"]),
  );
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("a.docx")]);
  await dialog.getByLabel("Thư mục đích").fill("khac/");
  await expect(dialog.getByText("phải nằm trong docs/", { exact: false })).toBeVisible();
  await expect(upload(dialog)).toBeDisabled();
  await dialog.getByLabel("Thư mục đích").fill("docs/../x");
  await expect(dialog.getByText("không hợp lệ", { exact: false })).toBeVisible();
  await dialog.getByLabel("Thư mục đích").fill("docs/srs");
  await expect(upload(dialog)).toBeEnabled();
});

test("hub từ chối: hiện câu có cách sửa, giữ hộp thoại và file đã chọn", async ({ page }) => {
  const fixture = await openDocs(page, { fail: wordImportFailure("WORD_IMPORT_PASSWORD") });
  const dialog = await openDialog(page);
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("khoa.docx")]);
  await upload(dialog).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "File có mật khẩu" })).toBeVisible();
  await expect(dialog.getByText("khoa.docx")).toBeVisible();
  await expect(upload(dialog)).toBeEnabled();
  expect(fixture.state.uploads).toHaveLength(1);
  await expect(page).toHaveURL(/\/knowledge\/docs$/);
});

test("huỷ giữa lúc tải lên", async ({ page }) => {
  const fixture = await openDocs(page, { hold: true });
  const dialog = await openDialog(page);
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("cham.docx")]);
  await upload(dialog).click();
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đóng", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Huỷ tải lên" }).click();
  await expect(dialog.getByText("Đã huỷ tải lên.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  fixture.state.release();
  await expect(page).toHaveURL(/\/knowledge\/docs$/);
});

test("cài đặt dự án: Nhập Word cạnh Nhập từ repo, nhà cố định theo dự án", async ({ page }) => {
  const fixture = await openDocs(page);
  await page.goto("/projects/payment-api/settings#docs");
  const status = page.getByRole("group", { name: "Trạng thái đồng bộ", exact: true });
  await expect(status.getByRole("link", { name: "Nhập từ repo" })).toBeVisible();
  await status.getByRole("button", { name: "Nhập Word", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nhập Word", exact: true });
  await expect(dialog.getByText("Dự án Payment API", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Nhà tài liệu")).toHaveCount(0);
  await expect(dialog.getByLabel("Thư mục đích")).toHaveValue("docs/");
  await dialog.getByLabel("File Word", { exact: true }).setInputFiles([docx("a.docx")]);
  await upload(dialog).click();
  await expect(page).toHaveURL(/word-imports\//);
  expect(fixture.state.uploads[0]?.fields.homeId).toEqual([fixture.projectHome.id]);
});

test("cài đặt dự án: hub không có pandoc thì không có nút và chỉ cách bật", async ({ page }) => {
  await openDocs(page, { health: { wordImport: false } });
  await page.goto("/projects/payment-api/settings#docs");
  const status = page.getByRole("group", { name: "Trạng thái đồng bộ", exact: true });
  await expect(status.getByText("cài pandoc", { exact: false })).toBeVisible();
  await expect(status.getByText("docs/self-hosting.md", { exact: false })).toBeVisible();
  await expect(status.getByRole("button", { name: "Nhập Word" })).toHaveCount(0);
});

test("công tắc Tài liệu mật khi nhập Word: lưu ở dự án và ở kho tổ chức", async ({ page }) => {
  const fixture = await openDocs(page);
  await page.goto("/projects/payment-api/settings#docs");
  const form = page.getByRole("group", { name: "Tài liệu", exact: true });
  const toggle = form.getByRole("switch", { name: "Tài liệu mật khi nhập Word" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await form.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(form.getByText("Đã lưu", { exact: true })).toBeVisible();
  expect(fixture.settings.state.project.settings.docs.wordImportConfidential).toBe(true);

  await page.goto("/knowledge/skills");
  const card = page.getByRole("group", { name: "Kho tài liệu tổ chức", exact: true });
  const orgToggle = card.getByRole("switch", { name: "Tài liệu mật khi nhập Word" });
  await expect(orgToggle).toBeChecked();
  await orgToggle.click();
  await card.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(card.getByText("Đã lưu", { exact: true })).toBeVisible();
  expect(fixture.settings.state.configured.at(-1)).toMatchObject({ wordImportConfidential: false });
});

test("360 px, sáng/tối, bàn phím: hộp thoại không tràn ngang, thao tác không cần chuột", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const fixture = await openDocs(page);
  const dialog = await openDialog(page);
  await dialog
    .getByLabel("File Word", { exact: true })
    .setInputFiles([docx("mot-ten-file-rat-dai-mot-ten-file-rat-dai-mot-ten-file-rat-dai-mot-ten-file-rat-dai.docx")]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await dialog.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  }
  // Bàn phím: nút chọn file, chọn thư mục và tải lên đều tới được bằng Tab, tải lên bằng Enter.
  await dialog.getByRole("button", { name: "Chọn file", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Chọn thư mục", exact: true })).toBeFocused();
  await upload(dialog).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/word-imports\//);
  expect(fixture.state.uploads).toHaveLength(1);
});

test("Escape đóng hộp thoại khi chưa tải lên", async ({ page }) => {
  await openDocs(page);
  const dialog = await openDialog(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Nhập Word", exact: true })).toBeFocused();
});
