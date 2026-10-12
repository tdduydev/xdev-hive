import { expect, test } from "@playwright/test";
import { fakeHub } from "./fake-hub.ts";

// Vite proxies /mcp to the hub; serve its SPA entry for the consent document in this fake-hub suite.
test.beforeEach(async ({ page }) => {
  await page.route("**/mcp/consent?**", async (route) => {
    const response = await route.fetch({ url: new URL("/login", route.request().url()).href });
    await route.fulfill({ response });
  });
});

for (const accept of [true, false]) {
  test(`MCP: ${accept ? "cho phép" : "từ chối"} gửi đúng câu trả lời rồi chuyển hướng`, async ({ page }) => {
    const hub = await fakeHub(page, {
      signedIn: true,
      auth: {
        "/oauth2/consent": () => ({ status: 200, json: { redirect: true, url: "https://cli.example.test/callback" } }),
      },
    });
    await page.route("https://cli.example.test/**", (route) => route.fulfill({ body: "CLI" }));
    await page.goto("/mcp/consent?client_id=cli-client&scope=openid%20email%20custom_scope");
    await expect(page.getByText("Biết bạn là ai trên hub")).toBeVisible();
    await expect(page.getByText("custom_scope", { exact: true })).toBeVisible();
    await expect(page.getByText("Xem tên và ảnh đại diện")).toHaveCount(0);
    await page.getByRole("button", { name: accept ? "Cho phép" : "Từ chối", exact: true }).click();
    await expect(page).toHaveURL("https://cli.example.test/callback");
    expect(hub.authCalls).toEqual([{ path: "/oauth2/consent", body: { accept } }]);
  });
}

test("MCP: lỗi yêu cầu, đổi VI/EN và thử lại được", async ({ page }) => {
  const hub = await fakeHub(page, {
    signedIn: true,
    auth: { "/oauth2/consent": () => ({ status: 400, json: { message: "Expired" } }) },
  });
  await page.goto(
    "/mcp/consent?client_id=https%3A%2F%2Fcli.example.test%2Fclient&scope=openid%20profile%20email%20offline_access",
  );
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool to use the hub?" })).toBeVisible();
  await expect(page.getByText("Client ID:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not send your response");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  expect(hub.authCalls.map((call) => call.body)).toEqual([{ accept: true }, { accept: false }]);
});

for (const theme of ["light", "dark"] as const) {
  test(`MCP: ${theme}, 360px và bàn phím`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 360, height: 800 });
    await fakeHub(page, { signedIn: true });
    await page.goto("/mcp/consent?client_id=cli-client&scope=openid%20profile%20email%20offline_access");
    await expect(page.getByRole("heading")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "VI", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "EN", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading")).toHaveText("Allow this tool to use the hub?");
    await page.screenshot({ path: testInfo.outputPath(`mcp-${theme}.png`), fullPage: true });
  });
}
