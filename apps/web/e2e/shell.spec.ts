import { expect, test } from "@playwright/test";
import { fakeHub, USER } from "./fake-hub.ts";

test("đã đăng nhập: mở /login thì vào /, thấy khung app như mockup", async ({ page }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto("/login");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: `Chào ${USER.name}` })).toBeVisible();
  await expect(page.getByText("Chưa thuộc tổ chức nào")).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  await expect(nav.getByText("Làm việc hằng ngày", { exact: true })).toBeVisible();
  await expect(nav.getByText("Dự án và quản trị", { exact: true })).toBeVisible();
  // Chưa thuộc tổ chức nào: mọi mục mờ, không bấm được, nói rõ vì sao.
  for (const label of [
    "Bảng việc",
    "Lượt chạy",
    "Máy",
    "Dự án",
    "Thành viên",
    "Đội và hệ thống",
    "Thông báo",
    "Chi phí và token",
    "Cài đặt đăng nhập",
  ]) {
    const entry = nav.locator("[aria-disabled=true]").filter({ hasText: label });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("title", "Cần thuộc một tổ chức");
  }
  await expect(nav.getByRole("link")).toHaveCount(0);

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

// Giá trị theo docs/design-system/tokens.json: canvas, surface, accent, on-accent.
for (const [scheme, canvas, surface, accent, onAccent] of [
  ["light", "rgb(246, 248, 252)", "rgb(255, 255, 255)", "rgb(0, 76, 255)", "rgb(255, 255, 255)"],
  ["dark", "rgb(12, 23, 41)", "rgb(20, 39, 69)", "rgb(63, 169, 255)", "rgb(11, 23, 48)"],
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
