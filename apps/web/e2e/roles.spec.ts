import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, rolesFixture } from "./fake-hub.ts";

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";

async function setup(page: Page, role: "owner" | "admin" | "member" = "admin", mine?: string[]) {
  const fixture = rolesFixture(mine ? { mine } : {});
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role, emailDomain: null, createdAt: "2026-10-01T00:00:00.000Z" },
          ],
          canCreateOrg: false,
        }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      ...fixture.rpc,
    },
  });
  return { ...fixture, hub };
}

test("vai trò hệ thống chỉ xem: cây quyền khoá, có nút nhân bản", async ({ page }) => {
  await setup(page);
  await page.goto("/admin/roles");
  await expect(page.getByRole("heading", { name: "Vai trò và quyền", level: 1 })).toBeVisible();
  await page
    .getByRole("button", { name: /Thành viên/ })
    .first()
    .click();
  await expect(page.getByText("Vai trò hệ thống không sửa được.", { exact: false })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Xem việc" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Lưu vai trò" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nhân bản" })).toBeVisible();
});

test("vai trò tự tạo: bật một nhánh, quyền nhạy cảm phải xác nhận, lưu đúng danh sách quyền", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: /Kiểm toán/ }).click();
  await expect(page.getByRole("heading", { name: "Kiểm toán", level: 2 })).toBeVisible();
  // Nhánh Theo dõi đã có đủ 4 quyền con; nhánh Chi phí đang một phần.
  const costs = page.getByRole("checkbox", { name: "Chi phí", exact: true });
  expect(await costs.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
  await costs.check();
  await expect(page.getByRole("checkbox", { name: "Đặt ngân sách" })).toBeChecked();
  // Nhánh Merge chứa quyền nhạy cảm: hỏi trước khi bật.
  await page.getByRole("checkbox", { name: "Merge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Merge bỏ qua hàng")).toBeVisible();
  await dialog.getByRole("button", { name: "Bật quyền" }).click();
  await expect(page.getByRole("checkbox", { name: "Merge bỏ qua hàng" })).toBeChecked();
  await page.getByRole("button", { name: "Lưu vai trò" }).click();
  await expect(page.getByText("Đã lưu vai trò.")).toBeVisible();
  const update = state.calls.find((c) => c.path === "roles/update")?.input as { permissions: string[] };
  expect(update.permissions).toEqual([
    "merge.enqueue",
    "merge.force",
    "members.read",
    "costs.read",
    "costs.budget",
    "audit.read",
    "audit.export",
  ]);
});

test("tìm quyền và chỉ hiện quyền đang bật", async ({ page }) => {
  await setup(page);
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: /Kiểm toán/ }).click();
  await page.getByLabel("Chỉ hiện quyền đang bật").check();
  await expect(page.getByRole("checkbox", { name: "Xem việc" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).toBeVisible();
  await page.getByLabel("Chỉ hiện quyền đang bật").uncheck();
  await page.getByRole("textbox", { name: "Tìm quyền…" }).fill("sandbox");
  await expect(page.getByRole("checkbox", { name: "Sửa allowlist và image" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).toHaveCount(0);
});

test("tạo vai trò từ vai trò hệ thống rồi gán cho đội; xoá vai trò còn gán bị từ chối", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: /Chỉ xem/ }).click();
  await page.getByRole("button", { name: "Nhân bản" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên vai trò").fill("Người duyệt merge");
  await expect(dialog.getByLabel("Bắt đầu từ")).toHaveValue("team-viewer");
  await dialog.getByRole("button", { name: "Tạo vai trò" }).click();
  await expect(page.getByRole("heading", { name: "Người duyệt merge", level: 2 })).toBeVisible();
  expect(state.calls.find((c) => c.path === "roles/create")?.input).toMatchObject({
    name: "Người duyệt merge",
    scope: "team",
    copyOf: "team-viewer",
  });
  // Vai trò phạm vi đội chỉ gán được cho đội.
  await expect(page.getByLabel("Thêm người")).toHaveCount(0);
  await page.getByLabel("Thêm đội").selectOption({ label: "Thanh toán" });
  await page.getByRole("button", { name: "Gán" }).click();
  await expect(page.getByText("Đội: Thanh toán")).toBeVisible();
  await page.getByRole("button", { name: "Xoá vai trò" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xoá vai trò" }).click();
  await expect(page.getByText(/đang gán cho 1 người hoặc đội/)).toBeVisible();
});

test("người không có quyền sửa vai trò chỉ xem được", async ({ page }) => {
  await setup(page, "member", ["tasks.read"]);
  await page.goto("/admin/roles");
  await expect(page.getByText("Bạn chỉ xem được vai trò", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vai trò mới" })).toHaveCount(0);
  await page.getByRole("button", { name: /Kiểm toán/ }).click();
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).toBeDisabled();
});

test("vai trò tự tạo có audit.read thấy mục Nhật ký trong menu Quản trị dù là thành viên", async ({ page }) => {
  await setup(page, "member", ["tasks.read", "audit.read"]);
  await page.goto("/admin/members");
  const admin = page.getByRole("navigation", { name: "Điều hướng quản trị" });
  await expect(admin.getByRole("link", { name: "Nhật ký" })).toHaveCount(1);
  await expect(admin.getByRole("link", { name: "Vai trò và quyền" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`vai trò: tiếng Anh, 360px ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
    await setup(page);
    await page.goto("/admin/roles");
    await expect(page.getByRole("heading", { name: "Roles & permissions", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /Kiểm toán/ }).click();
    await expect(page.getByRole("checkbox", { name: "View audit log" })).toBeChecked();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `test-results/roles-${scheme}.png`, fullPage: true });
  });
}
