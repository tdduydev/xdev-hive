import { expect, type Page, test } from "@playwright/test";
import { deliverySettingsFixture, FAKE_TOKEN, JENKINS_MAIN_ID } from "./delivery-settings-fixture.ts";
import { inOrg } from "./reviews-fixture.ts";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

async function pickRowAction(page: Page, name: string, item: string) {
  await page.getByRole("button", { name: `Thao tác khác cho kết nối ${name}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("quản trị thêm Jenkins; người tạo là người theo dõi và chưa có token", async ({ page }) => {
  const fixture = deliverySettingsFixture({ scenario: "empty" });
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/ci-connections");
  await expect(page.getByRole("heading", { name: "Kết nối CI", exact: true })).toBeVisible();
  await expect(page.getByText("Chưa có kết nối Jenkins", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Thêm Jenkins", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Thêm kết nối Jenkins" });
  await dialog.getByLabel("Tên kết nối").fill("Jenkins công ty");
  await dialog.getByLabel("Địa chỉ").fill("http://jenkins.example.com");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  // Địa chỉ không phải https bị chặn ngay ở form, không gọi hub.
  await expect(dialog).toBeVisible();
  expect(fixture.state.calls.filter((c) => c.path === "ciConnections/create")).toHaveLength(0);

  await dialog.getByLabel("Địa chỉ").fill("https://jenkins.example.com");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();
  const created = row(page, "Jenkins công ty");
  await expect(created).toContainText("https://jenkins.example.com");
  await expect(created).toContainText("Trần Đức Duy");
  await expect(created.getByText("Chưa có token để đọc Jenkins", { exact: true })).toBeVisible();
  await expect(created.getByText("Chưa đọc lần nào", { exact: true })).toBeVisible();
});

test("Kiểm Jenkins, đổi người theo dõi và xoá kết nối", async ({ page }) => {
  const fixture = deliverySettingsFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/ci-connections");
  const old = row(page, "Jenkins cũ");
  await expect(old.getByText("Không đọc được Jenkins", { exact: true })).toBeVisible();
  await expect(old).toContainText("Jenkins không nhận token của người theo dõi.");
  await expect(old.getByText("Chưa có token để đọc Jenkins", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Kiểm Jenkins công ty", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đọc được Jenkins." })).toContainText("Phiên bản 2.462.3");

  await pickRowAction(page, "Jenkins cũ", "Đổi người theo dõi…");
  const watcher = page.getByRole("dialog", { name: "Đổi người theo dõi của Jenkins cũ" });
  await watcher.getByLabel("Người theo dõi").selectOption("u-lan");
  await watcher.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(watcher.getByRole("alert")).toContainText("Người này chưa có token Jenkins");
  await watcher.getByLabel("Người theo dõi").selectOption("u-ha");
  await watcher.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(watcher).toBeHidden();
  await expect(old).toContainText("Phạm Hà");
  await expect(old.getByText("Chưa có token để đọc Jenkins", { exact: true })).toBeHidden();
  expect(fixture.state.calls.findLast((c) => c.path === "ciConnections/setWatcher")?.input).toMatchObject({
    userId: "u-ha",
  });

  await pickRowAction(page, "Jenkins cũ", "Xoá…");
  const remove = page.getByRole("dialog", { name: "Xoá kết nối Jenkins cũ?" });
  await expect(remove).toContainText("Không hoàn tác được.");
  await remove.getByRole("button", { name: "Xoá kết nối", exact: true }).click();
  await expect(row(page, "Jenkins cũ")).toHaveCount(0);
  await expect(row(page, "Jenkins công ty").first()).toBeVisible();
});

test("Jenkins từ chối token: báo lỗi tại dòng", async ({ page }) => {
  const fixture = deliverySettingsFixture({ testOk: false });
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/ci-connections");
  await page.getByRole("button", { name: "Kiểm Jenkins công ty", exact: true }).click();
  const result = page.getByRole("status").filter({ hasText: "Jenkins không nhận token." });
  await expect(result.getByText("Chưa dùng được", { exact: true })).toBeVisible();
});

test("thêm Argo CD và Kubernetes; token chỉ ghi, CA riêng, sửa giữ token cũ", async ({ page }) => {
  const fixture = deliverySettingsFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/ci-connections");
  await expect(row(page, "K8s dev").getByText("CA riêng", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Thêm Argo CD hoặc Kubernetes", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Thêm kết nối Argo CD hoặc Kubernetes" });
  await dialog.getByLabel("Loại", { exact: true }).selectOption("kubernetes");
  await dialog.getByLabel("Tên kết nối").fill("K8s prod");
  await dialog.getByLabel("Địa chỉ").fill("https://k8s-prod.example.com:6443");
  const token = dialog.getByLabel("Token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("short");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog.getByText("Token quá ngắn.")).toBeVisible();
  await token.fill(FAKE_TOKEN);
  await dialog.getByLabel("Chứng chỉ CA", { exact: false }).fill("không phải PEM");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog.getByText("CA phải ở dạng PEM", { exact: false })).toBeVisible();
  await dialog
    .getByLabel("Chứng chỉ CA", { exact: false })
    .fill("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "K8s prod").getByText("CA riêng", { exact: true })).toBeVisible();
  // Giao diện không bao giờ in lại token vừa gửi.
  await expect(page.getByText(FAKE_TOKEN, { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "Kiểm K8s prod", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Phiên bản v1.31.2" })).toBeVisible();

  await pickRowAction(page, "Argo CD dev", "Sửa…");
  const edit = page.getByRole("dialog", { name: "Sửa kết nối" });
  await expect(edit.getByLabel("Token", { exact: true })).toHaveValue("");
  await edit.getByLabel("Tên kết nối").fill("Argo CD staging");
  await edit.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row(page, "Argo CD staging")).toBeVisible();
  const update = fixture.state.calls.find((c) => c.path === "infraConnections/update")?.input as Record<
    string,
    unknown
  >;
  expect(update).toMatchObject({ name: "Argo CD staging" });
  expect(update).not.toHaveProperty("token");

  await pickRowAction(page, "K8s prod", "Xoá…");
  await page
    .getByRole("dialog", { name: "Xoá kết nối K8s prod?" })
    .getByRole("button", { name: "Xoá kết nối" })
    .click();
  await expect(row(page, "K8s prod")).toHaveCount(0);
});

test("người không có quyền quản lý chỉ xem danh sách", async ({ page }) => {
  const fixture = deliverySettingsFixture();
  await inOrg(page, "member", fixture.rpc, ["ci.view"]);
  await page.goto("/admin/ci-connections");
  await expect(page.getByText("Bạn xem được danh sách", { exact: false })).toBeVisible();
  await expect(row(page, "Jenkins công ty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm Jenkins" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Kiểm Jenkins công ty" })).toHaveCount(0);
});

test("token Jenkins cá nhân: thêm, kiểm, thay và xoá; token không hiện lại", async ({ page }) => {
  const fixture = deliverySettingsFixture();
  await inOrg(page, "member", fixture.rpc);
  await page.goto("/settings/jenkins-tokens");
  await expect(page.getByRole("heading", { name: "Token Jenkins", exact: true })).toBeVisible();
  const mine = row(page, "Jenkins công ty");
  await expect(mine).toContainText("duy");
  await expect(mine.getByText("Chưa kiểm", { exact: true })).toBeVisible();
  const other = row(page, "Jenkins cũ");
  await expect(other.getByText("Chưa có token", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Thêm token cho Jenkins cũ", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Thêm token Jenkins cho Jenkins cũ" });
  const secret = add.getByLabel("API token", { exact: true });
  await expect(secret).toHaveAttribute("type", "password");
  await add.getByLabel("User Jenkins", { exact: true }).fill("lan.tran");
  await secret.fill(FAKE_TOKEN);
  await add.getByRole("button", { name: "Lưu token", exact: true }).click();
  await expect(add).toBeHidden();
  await expect(other).toContainText("lan.tran");
  await expect(page.getByText(FAKE_TOKEN, { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "Kiểm token Jenkins cũ", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đăng nhập là lan.tran" })).toBeVisible();
  await expect(other.getByText("Token dùng được", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Thay token cho Jenkins công ty", exact: true }).click();
  const replace = page.getByRole("dialog", { name: "Thay token Jenkins cho Jenkins công ty" });
  // Ô token để trống: hub không trả lại giá trị cũ.
  await expect(replace.getByLabel("API token", { exact: true })).toHaveValue("");
  await expect(replace.getByLabel("User Jenkins", { exact: true })).toHaveValue("duy");
  await replace.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(replace).toBeHidden();

  await page.getByRole("button", { name: "Xoá token Jenkins cũ", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Xoá token Jenkins cho Jenkins cũ?" })
    .getByRole("button", { name: "Xoá", exact: true })
    .click();
  await expect(other.getByText("Chưa có token", { exact: true })).toBeVisible();
  expect(fixture.state.tokens.has(JENKINS_MAIN_ID)).toBe(true);
});

test("tổ chức chưa có Jenkins: trang token hướng người dùng nhờ quản trị", async ({ page }) => {
  const fixture = deliverySettingsFixture({ scenario: "empty" });
  await inOrg(page, "member", fixture.rpc);
  await page.goto("/settings/jenkins-tokens");
  await expect(page.getByText("Tổ chức chưa có kết nối Jenkins", { exact: true })).toBeVisible();
});

test("menu người dùng dẫn tới Token Jenkins", async ({ page }) => {
  const fixture = deliverySettingsFixture();
  await inOrg(page, "member", fixture.rpc);
  await page.goto("/");
  await page.getByRole("button", { name: /^Tài khoản:/ }).click();
  await page.getByRole("menuitem", { name: "Token Jenkins" }).click();
  await expect(page).toHaveURL(/\/settings\/jenkins-tokens$/);
  await expect(page.getByRole("heading", { name: "Token Jenkins", exact: true })).toBeVisible();
});

test("360 px, sáng/tối và bàn phím", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const fixture = deliverySettingsFixture();
  await inOrg(page, "admin", fixture.rpc);
  await page.goto("/admin/ci-connections");
  await expect(row(page, "Jenkins công ty")).toBeVisible();
  // Bảng cuộn trong khung của nó, trang không tràn ngang.
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  const test = page.getByRole("button", { name: "Kiểm Jenkins công ty", exact: true });
  await test.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Đọc được Jenkins." })).toBeVisible();
  await page.getByRole("button", { name: "Thao tác khác cho kết nối Jenkins công ty" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Sửa kết nối Jenkins" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Tên kết nối")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.goto("/settings/jenkins-tokens");
  await expect(row(page, "Jenkins công ty")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
