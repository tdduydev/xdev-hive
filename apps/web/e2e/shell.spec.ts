import { expect, test } from "@playwright/test";
import { fakeHub, USER } from "./fake-hub.ts";

test("đã đăng nhập: mở /dang-nhap thì vào /, thấy khung app như mockup", async ({ page }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto("/dang-nhap");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: `Chào ${USER.name}` })).toBeVisible();
  await expect(page.getByText("Chưa thuộc tổ chức nào")).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Điều hướng chính" });
  for (const [label, milestone] of [
    ["Việc", "M3"],
    ["Dự án", "M2"],
    ["Máy", "M3"],
    ["Tri thức", "M4"],
  ] as const) {
    // Mục chưa có màn: mờ, không bấm được, kèm nhãn mốc.
    await expect(nav.locator("[aria-disabled=true]").filter({ hasText: label })).toContainText(milestone);
  }
  await expect(nav.getByText("Quản trị", { exact: true })).toBeVisible();
  // Chưa thuộc tổ chức nào nên mục quản trị cũng mờ.
  for (const label of ["Đội và hệ thống", "Thành viên", "Đăng nhập", "Cài đặt tổ chức"]) {
    await expect(nav.locator("[aria-disabled=true]").filter({ hasText: label })).toBeVisible();
  }
  await expect(nav.locator("[aria-disabled=true]").filter({ hasText: "Đăng nhập" })).toHaveAttribute(
    "title",
    "Cần thuộc một tổ chức",
  );

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
  await expect(page).toHaveURL("/dang-nhap");
  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  expect(hub.authCalls.map((c) => c.path)).toEqual(["/sign-out"]);
});

for (const [scheme, canvas, surface] of [
  ["light", "rgb(250, 249, 252)", "rgb(255, 255, 255)"],
  ["dark", "rgb(14, 14, 17)", "rgb(29, 28, 32)"],
] as const) {
  test(`màu theo chế độ ${scheme} của hệ điều hành, đúng token mockup`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await fakeHub(page);
    await page.goto("/dang-nhap");
    const card = page.getByRole("heading", { name: "Đăng nhập" }).locator("..");
    await expect(page.locator("body")).toHaveCSS("background-color", canvas);
    await expect(card).toHaveCSS("background-color", surface);
    await expect(page.getByRole("button", { name: "Tiếp tục với SSO" })).toHaveCSS(
      "background-color",
      "rgb(123, 97, 255)",
    );
  });
}
