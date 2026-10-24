import { expect, test } from "@playwright/test";
import { fakeHub } from "./fake-hub.ts";

for (const theme of ["light", "dark"] as const) {
  test(`Status: 404, ${theme}, 360px và đổi ngôn ngữ`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 360, height: 800 });
    await fakeHub(page, { signedIn: true });
    await page.goto("/missing-screen");
    await expect(page.getByRole("heading", { name: "Không tìm thấy trang" })).toBeVisible();
    await expect(page.getByText("404", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`404-${theme}.png`), fullPage: true });
    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page).toHaveURL("/");
  });

  test(`Status: lỗi hub, ${theme} và thử lại`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 360, height: 800 });
    await fakeHub(page, { signedIn: true });
    await page.route("**/rpc/me/get**", (route) => route.abort("connectionrefused"));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Không kết nối được hub" })).toBeVisible();
    await expect(page.getByText("503", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`503-${theme}.png`), fullPage: true });
    await page.unroute("**/rpc/me/get**");
    await page.getByRole("button", { name: "Thử lại" }).click();
    await expect(page.getByRole("heading", { name: "Không kết nối được hub" })).toBeHidden();
  });
}

test("Status: lỗi không do mạng thì không báo mất kết nối hub", async ({ page }) => {
  await fakeHub(page, { signedIn: true });
  await page.route("**/rpc/me/get**", (route) =>
    route.fulfill({
      status: 403,
      json: { json: { defined: true, code: "FORBIDDEN", status: 403, message: "Không có quyền." } },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Màn hình gặp lỗi" })).toBeVisible();
  await expect(page.getByText("503", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Không kết nối được hub" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
});

test("Status: đang tải khi hub chưa trả lời, rồi mở trang", async ({ page }, testInfo) => {
  await fakeHub(page, { signedIn: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/me/get**", async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toHaveText("Đang tải…");
  await expect(page.getByRole("status")).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Loading…");
  await page.screenshot({ path: testInfo.outputPath("pending-light.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("pending-dark.png"), fullPage: true });
  release();
  await expect(page.getByText("Loading…", { exact: true })).toBeHidden();
});
