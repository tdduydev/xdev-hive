import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

const at = "2026-10-01T03:00:00.000Z";
const ORG = { id: "0a0a0a0a-0000-4000-8000-00000000000a", slug: "acme-dev", name: "Acme Software xDev", role: "owner" };

const rpc: Record<string, RpcHandler> = {
  "orgs/mine": () => ok({ orgs: [{ ...ORG, emailDomain: null, createdAt: at }], canCreateOrg: false }),
  "orgMembers/list": () =>
    ok([
      {
        userId: USER.id,
        name: USER.name,
        email: USER.email,
        image: null,
        role: "owner",
        status: "active",
        joinedAt: at,
        providers: [],
        lastSeenAt: at,
        teams: [],
      },
    ]),
};

const signOutOk = (_: unknown, hub: { signedIn: boolean }) => {
  hub.signedIn = false;
  return { status: 200, json: { success: true } };
};

async function openUserMenu(page: Page) {
  // Thanh trên, không phải chân sidebar: sidebar có thể đang thu gọn hoặc đóng.
  await page.getByRole("button", { name: `Tài khoản: ${USER.name}` }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toContainText(USER.email);
  return menu;
}

test("menu người dùng ở thanh trên có Đăng xuất trên mọi trang: trang chủ và trang quản trị", async ({ page }) => {
  await fakeHub(page, { signedIn: true, rpc });
  for (const path of ["/", "/admin/members"]) {
    await page.goto(path);
    const menu = await openUserMenu(page);
    await expect(menu.getByRole("menuitem", { name: "Đăng xuất" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
});

test("Đăng xuất từ trang quản trị: gọi sign-out, về trang đăng nhập, vào lại trang bảo vệ thì bị đưa về đăng nhập", async ({
  page,
}) => {
  const hub = await fakeHub(page, { signedIn: true, rpc, auth: { "/sign-out": signOutOk } });
  await page.goto("/admin/members");
  const menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: "Đăng xuất" }).click();

  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  expect(hub.authCalls.map((c) => c.path)).toEqual(["/sign-out"]);

  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fadmin%2Fmembers$/);
  await expect(page.getByRole("heading", { name: "Đăng nhập" })).toBeVisible();
  // Nút Quay lại trình duyệt cũng không đưa về trang cũ khi phiên đã mất.
  await page.goBack();
  await page.goto("/");
  await expect(page).toHaveURL("/login");
});

test("Đăng xuất lỗi: báo lỗi trong menu, ở lại trang, bấm lại được", async ({ page }) => {
  let attempts = 0;
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc,
    auth: {
      "/sign-out": (body, h) => {
        attempts += 1;
        return attempts === 1 ? { status: 500, json: { message: "Lỗi hub" } } : signOutOk(body, h);
      },
    },
  });
  await page.goto("/");
  const menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: "Đăng xuất" }).click();
  await expect(menu.getByRole("alert")).toHaveText("Không đăng xuất được. Thử lại.");
  await expect(page).toHaveURL("/");

  await menu.getByRole("menuitem", { name: "Đăng xuất" }).click();
  await expect(page).toHaveURL("/login");
  expect(hub.authCalls.map((c) => c.path)).toEqual(["/sign-out", "/sign-out"]);
});
