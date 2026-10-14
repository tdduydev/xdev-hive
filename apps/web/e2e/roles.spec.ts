import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, rolesFixture } from "./fake-hub.ts";

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const AUDITOR = "7e7e7e7e-0000-4000-8000-000000000001";

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

const section = (page: Page, name: string) => page.getByRole("group", { name, exact: true });

test("danh sách vai trò: bấm dòng mở trang vai trò hệ thống chỉ xem, có nút nhân bản", async ({ page }) => {
  await setup(page);
  await page.goto("/admin/roles");
  await expect(page.getByRole("heading", { name: "Vai trò và quyền", level: 1 })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(9);
  await page.getByRole("row").filter({ hasText: "Làm việc trong các đội mình thuộc." }).click();
  await expect(page).toHaveURL(/\/admin\/roles\/member$/);
  await expect(page.getByRole("heading", { name: "Thành viên", level: 1 })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Vai trò hệ thống không sửa được.");
  await expect(page.getByRole("checkbox", { name: "Xem việc" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Lưu", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nhân bản" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vùng nguy hiểm" })).toHaveCount(0);
  // Tab Người lấy từ danh sách thành viên và nằm trong URL.
  await page.getByRole("tab", { name: /Người có vai trò này/ }).click();
  await expect(page).toHaveURL(/tab=nguoi/);
  await expect(page.getByText("lan@acme.vn")).toBeVisible();
  await page.getByRole("link", { name: "Vai trò và quyền" }).first().click();
  await expect(page).toHaveURL(/\/admin\/roles$/);
});

test("vai trò tự tạo: bật một nhánh, quyền nhạy cảm phải xác nhận, mỗi nhóm lưu riêng", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: "Mở dòng Kiểm toán" }).click();
  await expect(page.getByRole("heading", { name: "Kiểm toán", level: 1 })).toBeVisible();
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

  // Lưu nhóm Theo dõi trước: nhóm Dự án đang sửa dở không bị gửi theo.
  const ops = section(page, "Theo dõi");
  await ops.getByRole("button", { name: "Lưu" }).click();
  await expect(ops.getByText("Đã lưu.", { exact: false })).toBeVisible();
  const updates = () =>
    state.calls.filter((c) => c.path === "roles/update").map((c) => (c.input as { permissions: string[] }).permissions);
  expect(updates()[0]).toEqual(["members.read", "costs.read", "costs.budget", "audit.read", "audit.export"]);
  await expect(page.getByRole("checkbox", { name: "Merge bỏ qua hàng" })).toBeChecked();

  const projects = section(page, "Dự án và hạ tầng");
  await expect(projects.getByText("Có thay đổi chưa lưu")).toBeVisible();
  await projects.getByRole("button", { name: "Lưu" }).click();
  await expect(projects.getByText("Đã lưu.", { exact: false })).toBeVisible();
  expect(updates()[1]).toEqual([
    "merge.enqueue",
    "merge.force",
    "members.read",
    "costs.read",
    "costs.budget",
    "audit.read",
    "audit.export",
  ]);
});

test("Huỷ trả lại một nhóm; rời trang còn nhóm chưa lưu thì hỏi lại", async ({ page }) => {
  await setup(page);
  await page.goto(`/admin/roles/${AUDITOR}`);
  await page.getByRole("checkbox", { name: "Đặt ngân sách" }).check();
  await page.getByRole("checkbox", { name: "Xem việc" }).check();
  await section(page, "Theo dõi").getByRole("button", { name: "Huỷ" }).click();
  await expect(page.getByRole("checkbox", { name: "Đặt ngân sách" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Xem việc" })).toBeChecked();
  await page.getByRole("link", { name: "Vai trò và quyền" }).first().click();
  const leave = page.getByRole("dialog", { name: "Rời trang khi còn thay đổi chưa lưu?" });
  await leave.getByRole("button", { name: "Rời trang" }).click();
  await expect(page).toHaveURL(/\/admin\/roles$/);
});

test("tìm quyền và chỉ hiện quyền đang bật", async ({ page }) => {
  await setup(page);
  await page.goto(`/admin/roles/${AUDITOR}`);
  await page.getByLabel("Chỉ hiện quyền đang bật").check();
  await expect(page.getByRole("checkbox", { name: "Xem việc" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).toBeVisible();
  await page.getByLabel("Chỉ hiện quyền đang bật").uncheck();
  await page.getByRole("textbox", { name: "Tìm quyền…" }).fill("sandbox");
  await expect(page.getByRole("checkbox", { name: "Sửa allowlist và image" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Tìm quyền…" }).fill("không-có-quyền-này");
  await expect(page.getByRole("heading", { name: "Không có quyền nào khớp" })).toBeVisible();
  await page.getByRole("button", { name: "Xoá bộ lọc" }).click();
  await expect(page.getByRole("checkbox", { name: "Xem việc" })).toBeVisible();
});

test("tạo vai trò từ vai trò hệ thống, gán cho đội, gỡ có xác nhận; xoá vai trò còn gán bị từ chối", async ({
  page,
}) => {
  const { state } = await setup(page);
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: "Thao tác khác cho Chỉ xem" }).click();
  await page.getByRole("menuitem", { name: "Nhân bản" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên vai trò").fill("Người duyệt merge");
  await expect(dialog.getByLabel("Bắt đầu từ")).toHaveValue("team-viewer");
  await dialog.getByRole("button", { name: "Tạo vai trò" }).click();
  await expect(page.getByRole("heading", { name: "Người duyệt merge", level: 1 })).toBeVisible();
  expect(state.calls.find((c) => c.path === "roles/create")?.input).toMatchObject({
    name: "Người duyệt merge",
    scope: "team",
    copyOf: "team-viewer",
  });

  await page.getByRole("tab", { name: /Người có vai trò này/ }).click();
  await expect(page.getByRole("heading", { name: "Chưa gán cho ai" })).toBeVisible();
  await page.getByRole("button", { name: "Gán vai trò" }).click();
  const assign = page.getByRole("dialog");
  // Vai trò phạm vi đội chỉ gán được cho đội.
  await expect(assign.getByRole("button", { name: "Người", exact: true })).toHaveCount(0);
  await assign.getByLabel("Đội").selectOption({ label: "Thanh toán" });
  await assign.getByRole("button", { name: "Gán", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Thanh toán" })).toBeVisible();

  await page.getByRole("tab", { name: "Quyền" }).click();
  await page.getByRole("button", { name: "Xoá vai trò" }).click();
  const remove = page.getByRole("dialog", { name: "Xoá vai trò Người duyệt merge?" });
  await remove.getByRole("button", { name: "Xoá vai trò" }).click();
  await expect(remove.getByText(/đang gán cho 1 người hoặc đội/)).toBeVisible();
  await remove.getByRole("button", { name: "Huỷ" }).click();

  await page.getByRole("tab", { name: /Người có vai trò này/ }).click();
  await page.getByRole("button", { name: "Gỡ vai trò khỏi Thanh toán" }).click();
  await page
    .getByRole("dialog", { name: "Gỡ vai trò Người duyệt merge khỏi Thanh toán?" })
    .getByRole("button", { name: "Gỡ" })
    .click();
  await expect(page.getByRole("heading", { name: "Chưa gán cho ai" })).toBeVisible();
  await page.getByRole("tab", { name: "Quyền" }).click();
  await page.getByRole("button", { name: "Xoá vai trò" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xoá vai trò" }).click();
  await expect(page).toHaveURL(/\/admin\/roles$/);
  await expect(page.getByRole("button", { name: "Mở dòng Người duyệt merge" })).toHaveCount(0);
});

test("vai trò tổ chức gán được cho người", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto(`/admin/roles/${AUDITOR}?tab=nguoi`);
  await expect(page.getByText("lan@acme.vn")).toBeVisible();
  await page.getByRole("button", { name: "Gán vai trò" }).click();
  const assign = page.getByRole("dialog");
  await expect(assign.getByRole("button", { name: "Người", exact: true })).toHaveAttribute("aria-pressed", "true");
  await assign.getByLabel("Người", { exact: true }).selectOption({ label: "Phạm Hà · ha@acme.vn" });
  await assign.getByRole("button", { name: "Gán", exact: true }).click();
  await expect(page.getByText("ha@acme.vn")).toBeVisible();
  expect(state.calls.find((c) => c.path === "roles/assign")?.input).toMatchObject({ kind: "member", userId: "u-ha" });
});

test("người không có quyền sửa vai trò chỉ xem được", async ({ page }) => {
  await setup(page, "member", ["tasks.read"]);
  await page.goto("/admin/roles");
  await expect(page.getByRole("note")).toContainText("Bạn chỉ xem được vai trò");
  await expect(page.getByRole("button", { name: "Vai trò mới" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Thao tác khác cho/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Mở dòng Kiểm toán" }).click();
  await expect(page.getByRole("checkbox", { name: "Xem nhật ký" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sửa tên" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Vùng nguy hiểm" })).toHaveCount(0);
});

test("vai trò không còn thì báo và có link về danh sách", async ({ page }) => {
  await setup(page);
  await page.goto("/admin/roles/7e7e7e7e-0000-4000-8000-0000000000ff");
  await expect(page.getByText("Không tìm thấy vai trò này.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Về danh sách vai trò" }).click();
  await expect(page).toHaveURL(/\/admin\/roles$/);
});

test("vai trò tự tạo có audit.read thấy mục Nhật ký trong menu Quản trị dù là thành viên", async ({ page }) => {
  await setup(page, "member", ["tasks.read", "audit.read"]);
  await page.goto("/admin/members");
  const admin = page.getByRole("navigation", { name: "Điều hướng quản trị" });
  await expect(admin.getByRole("link", { name: "Nhật ký" })).toHaveCount(1);
  await expect(admin.getByRole("link", { name: "Vai trò và quyền" })).toHaveCount(0);
});

for (const width of [1440, 1100, 360] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`vai trò: ${width}px ${scheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      // 360 px chạy tiếng Anh vì nhãn dài hơn, dễ tràn hơn.
      if (width === 360) await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
      await setup(page);
      await page.goto("/admin/roles");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("row")).toHaveCount(9);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(await overflow()).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`roles-list-${width}-${scheme}.png`), fullPage: true });
      await page.goto(`/admin/roles/${AUDITOR}`);
      await expect(
        page.getByRole("checkbox", { name: width === 360 ? "View audit log" : "Xem nhật ký" }),
      ).toBeChecked();
      expect(await overflow()).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`roles-detail-${width}-${scheme}.png`), fullPage: true });
      await page.goto(`/admin/roles/${AUDITOR}?tab=nguoi`);
      await expect(page.getByText("lan@acme.vn")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`roles-people-${width}-${scheme}.png`) });
    });
  }
}
