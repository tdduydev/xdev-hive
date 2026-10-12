import { expect, type Page, test } from "@playwright/test";
import { fakeHub, mcpAdminFixture, ok } from "./fake-hub.ts";

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
async function setup(page: Page, role: "owner" | "admin" | "member" = "admin") {
  const fixture = mcpAdminFixture(role);
  await page.addInitScript((id) => {
    localStorage.setItem("hive.org", id);
  }, ORG_ID);
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

for (const role of ["owner", "admin"] as const) {
  test(`MCP ${role}: toggle a tool, create a token once, copy, extend and revoke`, async ({ page }) => {
    const { state, hub } = await setup(page, role);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (value: string) => {
            (window as unknown as { copied: string }).copied = value;
          },
        },
      });
    });
    await page.goto("/admin/mcp");
    const toggle = page.getByRole("switch", { name: "Trạng thái doc_get" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(state.tools[0]?.enabled).toBe(true);
    await page.getByRole("tab", { name: /Token MCP/ }).click();
    await page.getByRole("button", { name: "Tạo token", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Client", { exact: true }).selectOption("codex");
    await dialog.getByLabel("Thời hạn", { exact: true }).selectOption("90");
    await dialog.getByRole("button", { name: "Tạo token", exact: true }).click();
    await expect(dialog.getByLabel("Token", { exact: true })).toHaveValue(state.rawToken);
    await expect(dialog.getByText(/Token chỉ hiện một lần/)).toBeVisible();
    await dialog.getByRole("button", { name: "Chép token" }).click();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(state.rawToken);
    await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByLabel("Token", { exact: true })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain(state.rawToken);
    await page.getByRole("button", { name: "Tạo token", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Token", { exact: true })).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Huỷ", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: "hive_pat_test3" });
    await expect(row).toContainText("codex");
    await row.getByRole("button", { name: "Gia hạn", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Gia hạn token" })).toBeVisible();
    await dialog.getByRole("button", { name: "Gia hạn", exact: true }).click();
    await expect(dialog).toBeHidden();
    await row.getByRole("button", { name: "Thu hồi", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Thu hồi token?" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Thu hồi", exact: true }).click();
    await expect(row).toContainText("Đã thu hồi");
    await expect(row.getByRole("button", { name: "Gia hạn", exact: true })).toBeDisabled();
    await expect(row.getByRole("button", { name: "Thu hồi", exact: true })).toBeDisabled();
    expect(hub.rpcCalls.filter((c) => c.path.startsWith("mcpAdmin/")).every((c) => c.org === ORG_ID)).toBe(true);
    expect(hub.rpcCalls.find((c) => c.path === "mcpAdmin/createToken")?.input).toEqual({
      clientId: "codex",
      lifetimeDays: 90,
    });
  });
}

test("MCP member: only own tokens, disabled tool controls and no extension", async ({ page }) => {
  const { hub } = await setup(page, "member");
  await page.goto("/admin/mcp");
  await expect(page.getByRole("switch", { name: "Trạng thái doc_get" })).toBeDisabled();
  await expect(page.getByText(/Bạn quản lý token của mình/)).toBeVisible();
  await page.getByRole("tab", { name: /Token MCP/ }).click();
  await expect(page.getByText("hive_pat_test1…")).toBeVisible();
  await expect(page.getByText("hive_pat_test2…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Gia hạn", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Thu hồi", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Thu hồi", exact: true }).click();
  await expect(page.getByText("Đã thu hồi", { exact: true })).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "mcpAdmin/setTool" || c.path === "mcpAdmin/extendToken")).toBe(false);
});

for (const theme of ["light", "dark"] as const) {
  test(`MCP 360px ${theme}: bilingual tabs, keyboard focus, token dialog and no page overflow`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 360, height: 800 });
    const { state } = await setup(page);
    await page.goto("/admin/mcp");
    await expect(page.getByRole("heading", { name: "MCP và công cụ" })).toBeVisible();
    await expect(page.getByRole("table")).toContainText("doc_get");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mcp-tools-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByRole("heading", { name: "MCP and tools" })).toBeVisible();
    await expect(page.getByRole("table")).toContainText("Read a doc");
    const toolsTab = page.getByRole("tab", { name: /Hub tools/ });
    await toolsTab.focus();
    await page.keyboard.press("ArrowRight");
    const serversTab = page.getByRole("tab", { name: "External MCP servers", exact: true });
    await expect(serversTab).toBeFocused();
    expect(await serversTab.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await serversTab.click();
    await expect(page.getByText("Coming soon", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /MCP tokens/ }).click();
    await expect(page.getByRole("table")).toContainText("cursor");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mcp-tokens-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "New token", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "New token", exact: true }).click();
    await expect(dialog.getByLabel("Token", { exact: true })).toHaveValue(state.rawToken);
    await expect(dialog.getByText(/shown only once/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mcp-create-${theme}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "VI", exact: true }).click();
    await expect(page.getByRole("heading", { name: "MCP và công cụ" })).toBeVisible();
    await page.getByRole("tab", { name: "MCP server ngoài", exact: true }).click();
    await expect(page.getByText("Sắp có", { exact: true })).toBeVisible();
  });
}

test("MCP: loading, empty state and retry after API failure", async ({ page }) => {
  const { state } = await setup(page);
  state.tokens = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/mcpAdmin/listTools**", async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto("/admin/mcp", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tabpanel").getByRole("status")).toHaveText("Đang tải…");
  release();
  await expect(page.getByRole("table")).toContainText("doc_get");
  await page.getByRole("tab", { name: /Token MCP/ }).click();
  await expect(page.getByText("Chưa có token MCP. Tạo token để kết nối client của bạn.")).toBeVisible();
  await page.route("**/rpc/mcpAdmin/listTokens**", (route) => route.abort("connectionrefused"));
  await page.reload();
  await page.getByRole("tab", { name: /Token MCP/ }).click();
  await expect(page.getByRole("alert")).toContainText("Không tải được dữ liệu MCP.");
  await page.unroute("**/rpc/mcpAdmin/listTokens**");
  await page.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.getByText("Chưa có token MCP. Tạo token để kết nối client của bạn.")).toBeVisible();
});
