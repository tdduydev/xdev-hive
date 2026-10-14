import { expect, test } from "@playwright/test";
import { fakeHub, ok, USER } from "./fake-hub.ts";

test("đã đăng nhập: mở /login thì vào /, thấy khung app như mockup", async ({ page }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto("/login");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: `Chào ${USER.name}` })).toBeVisible();
  await expect(page.getByText("Chưa thuộc tổ chức nào")).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  for (const group of ["Công việc", "Kiến thức"]) {
    await expect(nav.getByRole("button", { name: group })).toBeVisible();
  }
  // Nhóm quản trị không còn ở sidebar chính: chỉ một mục "Quản trị" dẫn vào menu riêng.
  await expect(nav.getByRole("button", { name: "Người và quyền" })).toHaveCount(0);
  // Chưa thuộc tổ chức nào: mọi mục mờ, không bấm được, nói rõ vì sao.
  for (const label of ["Bảng việc", "Lượt chạy", "Tài liệu", "Quản trị"]) {
    const entry = nav.locator("[aria-disabled=true]").filter({ hasText: label });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("title", "Cần thuộc một tổ chức");
  }
  // Chỉ Tổng quan mở được: đó là nơi hướng dẫn nhận lời mời.
  await expect(nav.getByRole("link")).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "Tổng quan" })).toHaveAttribute("href", "/");

  const aside = page.locator("aside");
  await expect(aside.getByText(USER.name)).toBeVisible();
  await expect(aside.getByText(USER.email)).toBeVisible();
  await expect(aside.getByText("TD", { exact: true })).toBeVisible();

  await aside.getByRole("button", { name: /Chưa có tổ chức/ }).click();
  await expect(page.getByRole("menu")).toContainText("Chưa thuộc tổ chức nào");
});

test("đăng xuất thì về trang đăng nhập", async ({ page }) => {
  const hub = await fakeHub(page, {
    signedIn: true,
    auth: {
      "/sign-out": (_, h) => {
        h.signedIn = false;
        return { status: 200, json: { success: true } };
      },
    },
  });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  expect(hub.authCalls.map((c) => c.path)).toEqual(["/sign-out"]);
});

// Giá trị theo docs/design-system/tokens.json: background, card, primary, primary-foreground.
for (const [scheme, canvas, surface, accent, onAccent] of [
  ["light", "rgb(248, 250, 252)", "rgb(255, 255, 255)", "rgb(29, 78, 216)", "rgb(255, 255, 255)"],
  ["dark", "rgb(15, 23, 42)", "rgb(27, 35, 54)", "rgb(96, 165, 250)", "rgb(15, 23, 42)"],
] as const) {
  test(`màu theo chế độ ${scheme} của hệ điều hành, đúng token mockup`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await fakeHub(page);
    await page.goto("/login");
    const card = page.getByRole("heading", { name: "Đăng nhập" }).locator("..");
    await expect(page.locator("body")).toHaveCSS("background-color", canvas);
    await expect(card).toHaveCSS("background-color", surface);
    const sso = page.getByRole("button", { name: "Tiếp tục với SSO" });
    await expect(sso).toHaveCSS("background-color", accent);
    await expect(sso).toHaveCSS("color", onAccent);
    // Logo đúng theme: chỉ ảnh của theme hiện tại hiện ra.
    await expect(page.locator(`img[src="/xdev-hive-${scheme}.svg"]`)).toBeVisible();
  });
}

test("chọn giao diện tối được lưu qua lần tải lại; theo hệ thống thì đi theo hệ điều hành", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await fakeHub(page, { signedIn: true });
  await page.goto("/");
  const html = page.locator("html");
  const pick = async (name: string) => {
    await page.getByRole("button", { name: "Giao diện" }).click();
    await page.getByRole("menuitemradio", { name }).click();
  };
  await expect(html).not.toHaveClass(/\bdark\b/);
  await pick("Tối");
  await expect(html).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: "Giao diện" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Tối" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await pick("Theo hệ thống");
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/\bdark\b/);
});

test("chọn ngôn ngữ EN được lưu và đặt lang của trang", async ({ page }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto("/");
  const group = page.getByRole("group", { name: "Ngôn ngữ" });
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await group.getByRole("button", { name: "EN" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("group", { name: "Language" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Work" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "VI" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
});

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
async function inOrg(page: import("@playwright/test").Page, unread = 0) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            {
              id: ORG_ID,
              slug: "acme",
              name: "Acme",
              role: "admin",
              emailDomain: null,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          canCreateOrg: false,
        }),
      "inbox/unreadCount": () => ok({ count: unread }),
      "tasks/list": () => ok([]),
      "runs/latest": () => ok([]),
      "projects/list": () => ok([]),
    },
  });
}

test("sidebar: nhóm của màn đang mở tự mở; mở hay đóng nhóm thì nhớ qua lần tải lại", async ({ page }) => {
  await inOrg(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  const work = nav.getByRole("button", { name: "Công việc" });
  await expect(work).toHaveAttribute("aria-expanded", "false");
  await work.click();
  await expect(nav.getByRole("link", { name: "Lượt chạy" })).toBeVisible();
  await page.reload();
  await expect(nav.getByRole("button", { name: "Công việc" })).toHaveAttribute("aria-expanded", "true");
});

test("menu Quản trị: một mục ở sidebar chính mở menu thứ hai; ← quay lại trang trước; hẹp thì thành ô chọn", async ({
  page,
}) => {
  await inOrg(page);
  await page.route("**/rpc/runs/search**", (route) =>
    route.fulfill({ json: { json: { items: [], nextCursor: null } } }),
  );
  await page.goto("/runs");
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  await nav.getByRole("link", { name: "Quản trị" }).click();
  await expect(page).toHaveURL("/admin/members");
  await expect(nav.getByRole("link", { name: "Quản trị" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("navigation", { name: "Đường dẫn" })).toContainText("Quản trị");

  const admin = page.getByRole("navigation", { name: "Điều hướng quản trị" });
  for (const group of ["Người và quyền", "Dự án và hạ tầng", "Quản trị agent", "Theo dõi"]) {
    await expect(admin.getByRole("heading", { name: group })).toBeVisible();
  }
  await expect(admin.getByRole("link", { name: "Thành viên" })).toHaveAttribute("aria-current", "page");
  // Mục chỉ quản trị dùng thấy được với quản trị tổ chức.
  await expect(admin.getByRole("link", { name: "Nhật ký" })).toHaveAttribute("href", "/admin/audit");
  await admin.getByRole("link", { name: "Dự án", exact: true }).click();
  await expect(page).toHaveURL("/projects");
  await expect(admin.getByRole("link", { name: "Dự án", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Quay lại trang trước khi vào Quản trị" }).click();
  await expect(page).toHaveURL("/runs");
  await expect(page.getByRole("navigation", { name: "Điều hướng quản trị" })).toHaveCount(0);

  // Dưới 1024 px menu thứ hai thành ô chọn trang, vẫn đủ nhóm.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/admin/members");
  await expect(page.getByRole("navigation", { name: "Điều hướng quản trị" })).toBeHidden();
  const pick = page.getByRole("combobox", { name: "Chọn trang quản trị" });
  await expect(pick).toHaveValue("members");
  await pick.selectOption({ label: "Nhật ký" });
  await expect(page).toHaveURL("/admin/audit");
});

test("⌘K mở bảng lệnh, gõ tên màn rồi Enter thì đi tới màn đó; đường dẫn ở thanh trên đổi theo", async ({ page }) => {
  await inOrg(page);
  await page.route("**/rpc/runs/search**", (route) =>
    route.fulfill({ json: { json: { items: [], nextCursor: null } } }),
  );
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Đường dẫn" })).toContainText("Tổng quan");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Đi tới" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("Lượt chạy");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runs/);
  await expect(page.getByRole("navigation", { name: "Đường dẫn" })).toContainText("Lượt chạy");
});

test("chuông có chấm khi còn thông báo chưa đọc và mở màn Thông báo", async ({ page }) => {
  await inOrg(page, 3);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Thông báo, 3 chưa đọc" })).toHaveAttribute("href", "/notifications");
});
