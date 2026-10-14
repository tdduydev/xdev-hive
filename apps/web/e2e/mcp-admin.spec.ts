import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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
    // Bật/tắt tool áp cho cả tổ chức nên đi qua hộp thoại xác nhận, không đổi ngay trên dòng.
    await page.getByRole("button", { name: "Tắt doc_get", exact: true }).click();
    let confirm = page.getByRole("dialog");
    await expect(confirm.getByRole("heading", { name: "Tắt tool doc_get?" })).toBeVisible();
    await confirm.getByRole("button", { name: "Tắt tool", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(state.tools[0]?.enabled).toBe(false);
    await page.getByRole("button", { name: "Bật doc_get", exact: true }).click();
    confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: "Bật tool", exact: true }).click();
    await expect(page.getByRole("button", { name: "Tắt doc_get", exact: true })).toBeVisible();
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
  await expect(page.getByRole("table")).toContainText("doc_get");
  await expect(page.getByRole("button", { name: "Tắt doc_get", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Bạn quản lý token của mình/)).toBeVisible();
  await page.getByRole("tab", { name: /Token MCP/ }).click();
  await expect(page.getByText("hive_pat_test1…")).toBeVisible();
  await expect(page.getByText("hive_pat_test2…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Gia hạn", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Thu hồi", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Thu hồi", exact: true }).click();
  await expect(page.getByText("Đã thu hồi", { exact: true })).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "mcpAdmin/setTool" || c.path === "mcpAdmin/extendToken")).toBe(false);
  // Tab bị ẩn khi không có quyền, kể cả khi mở thẳng bằng URL.
  await expect(page.getByRole("tab", { name: /MCP server ngoài/ })).toHaveCount(0);
  await page.goto("/admin/mcp?tab=server");
  await expect(page.getByRole("tab", { name: /Tool của hub/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Thêm server", exact: true })).toHaveCount(0);
  expect(hub.rpcCalls.some((c) => c.path.startsWith("mcpAdmin/") && c.path.includes("Server"))).toBe(false);
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
    const serversTab = page.getByRole("tab", { name: /External MCP servers/ });
    await expect(serversTab).toBeFocused();
    expect(await serversTab.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await serversTab.click();
    await expect(
      page.getByText("Written to the CLI managed settings on run machines. Deny wins over allow."),
    ).toBeVisible();
    await expect(page.getByRole("table")).toContainText("Filesystem");
    await expect(page.getByText("Servers runs will get", { exact: true })).toBeVisible();
    await expect(page.getByText("Coming soon")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mcp-servers-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    const serverDialog = page.getByRole("dialog");
    await serverDialog.getByLabel("Send to run machines", { exact: true }).selectOption("stdio");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mcp-server-dialog-${theme}.png`), fullPage: true });
    await serverDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(serverDialog).toBeHidden();
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
    await page.getByRole("tab", { name: /MCP server ngoài/ }).click();
    await expect(
      page.getByText("Hub ghi vào managed settings của CLI trên máy chạy run. Mục chặn thắng mục cho phép."),
    ).toBeVisible();
    await expect(page.getByText("Sắp có")).toHaveCount(0);
  });
}

test("MCP admin: external server rules — list, add, edit, change rule, delete and preview", async ({ page }) => {
  const { state, hub } = await setup(page);
  await page.goto("/admin/mcp");
  await page.getByRole("tab", { name: /MCP server ngoài/ }).click();
  await expect(page.getByText("Sắp có")).toHaveCount(0);
  const table = page.getByRole("table");
  await expect(table.getByRole("row").filter({ hasText: "GitHub" })).toContainText("name: github");
  await expect(table.getByRole("row").filter({ hasText: "GitHub" })).toContainText("Cho phép");
  await expect(table.getByRole("row").filter({ hasText: "Filesystem" })).toContainText(
    "command: npx @modelcontextprotocol/server-filesystem",
  );
  await expect(table.getByRole("row").filter({ hasText: "Mọi server khác" })).toContainText("Chặn");
  const preview = page.getByRole("region", { name: "Server run sẽ nhận" });
  await expect(preview).toContainText("github");
  await expect(preview).toContainText("Được phát");

  // Thêm server stdio cho một dự án.
  await page.getByRole("button", { name: "Thêm server", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên server", { exact: true }).fill("Playwright");
  await dialog.getByLabel("Phạm vi", { exact: true }).selectOption({ label: "mobile-app" });
  await dialog.getByLabel("Khớp theo", { exact: true }).selectOption("command");
  await dialog.getByLabel("Phát xuống máy chạy run", { exact: true }).selectOption("stdio");
  await expect(dialog.getByText("Tên trong cấu hình CLI: playwright")).toBeVisible();
  await expect(dialog.getByText(/Không đặt khoá bí mật/)).toBeVisible();
  await dialog.getByLabel("Lệnh", { exact: true }).fill("npx");
  await dialog.getByLabel("Tham số", { exact: true }).fill("@playwright/mcp@latest\n");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(hub.rpcCalls.find((c) => c.path === "mcpAdmin/createServer")?.input).toEqual({
    name: "Playwright",
    rule: "allow",
    matchType: "command",
    pattern: "",
    projectId: "0a0a0a0a-0000-4000-8000-0000000000b1",
    launch: { transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
  });
  const playwright = table.getByRole("row").filter({ hasText: "Playwright" });
  await expect(playwright).toContainText("mobile-app");
  await preview.getByLabel("Xem cho", { exact: true }).selectOption({ label: "mobile-app" });
  await expect(preview).toContainText("playwright");
  expect(hub.rpcCalls.filter((c) => c.path === "mcpAdmin/previewServers").at(-1)?.input).toEqual({
    projectId: "0a0a0a0a-0000-4000-8000-0000000000b1",
  });

  // Sửa: thêm quy tắc chặn github theo tên thì xem trước báo bị chặn.
  await page.getByRole("button", { name: "Thêm server", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên server", { exact: true }).fill("Chặn GitHub");
  await dialog.getByLabel("Quy tắc", { exact: true }).selectOption("deny");
  await dialog.getByLabel("Mẫu khớp", { exact: true }).fill("github");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();
  await preview.getByLabel("Xem cho", { exact: true }).selectOption({ label: "Tổ chức" });
  await expect(preview.getByRole("listitem").filter({ hasText: "github" })).toContainText("Bị chặn");
  await expect(preview.getByRole("listitem").filter({ hasText: "github" })).toContainText('theo quy tắc "Chặn GitHub"');

  await table.getByRole("button", { name: "Sửa Playwright", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Sửa quy tắc server" })).toBeVisible();
  await expect(dialog.getByLabel("Lệnh", { exact: true })).toHaveValue("npx");
  await dialog.getByLabel("Quy tắc", { exact: true }).selectOption("deny");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(playwright).toContainText("Chặn");
  expect(state.servers.find((r) => r.name === "Playwright")?.rule).toBe("deny");

  // Đổi quy tắc hàng loạt rồi xoá.
  await playwright.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Đổi quy tắc", exact: true }).click();
  await expect(playwright).toContainText("Cho phép");
  await table.getByRole("button", { name: "Xoá Chặn GitHub", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Xoá quy tắc?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Xoá", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(table.getByRole("row").filter({ hasText: "Chặn GitHub" })).toHaveCount(0);
  expect(state.servers.map((r) => r.name)).toEqual(["GitHub", "Filesystem", "Mọi server khác", "Playwright"]);
  expect(hub.rpcCalls.filter((c) => c.path.startsWith("mcpAdmin/")).every((c) => c.org === ORG_ID)).toBe(true);
});

test("MCP admin: hub error on a server rule is shown in the dialog", async ({ page }) => {
  const { hub } = await setup(page);
  await page.route("**/rpc/mcpAdmin/createServer", (route) =>
    route.fulfill({
      status: 400,
      json: {
        json: {
          defined: true,
          code: "BAD_REQUEST",
          status: 400,
          message: "Mẫu khớp phải khớp chính server được khai báo trên dòng này.",
          data: { code: "MCP_SERVER_SELF_MATCH" },
        },
      },
    }),
  );
  await page.goto("/admin/mcp");
  await page.getByRole("tab", { name: /MCP server ngoài/ }).click();
  await page.getByRole("button", { name: "Thêm server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên server", { exact: true }).fill("Sentry");
  await dialog.getByLabel("Mẫu khớp", { exact: true }).fill("khac");
  await dialog.getByLabel("Phát xuống máy chạy run", { exact: true }).selectOption("http");
  await dialog.getByLabel("URL", { exact: true }).fill("https://mcp.sentry.dev/mcp");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Mẫu khớp phải khớp chính server");
  await expect(dialog).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "mcpAdmin/listServers")).toBe(true);
});

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
  await expect(page.getByRole("tabpanel").getByRole("status")).toHaveText("Đang tải dữ liệu MCP…");
  release();
  await expect(page.getByRole("table")).toContainText("doc_get");
  await page.getByRole("tab", { name: /Token MCP/ }).click();
  await expect(page).toHaveURL("/admin/mcp?tab=token");
  await expect(page.getByText("Chưa có token MCP", { exact: true })).toBeVisible();
  await page.route("**/rpc/mcpAdmin/listTokens**", (route) => route.abort("connectionrefused"));
  await page.reload();
  // Tab nằm trong URL nên tải lại vẫn ở tab Token.
  await expect(page.getByRole("tab", { name: /Token MCP/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("alert")).toContainText("Không kết nối được hub.");
  await page.unroute("**/rpc/mcpAdmin/listTokens**");
  await page.getByRole("button", { name: "Tải lại", exact: true }).click();
  await expect(page.getByText("Chưa có token MCP", { exact: true })).toBeVisible();
});

for (const width of [1440, 1100, 360]) {
  for (const theme of ["light", "dark"] as const) {
    test(`MCP ${width} ${theme}: ba tab có URL, bảng vừa khung`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("hive.theme", value), theme);
      await setup(page);
      await page.goto("/admin/mcp");
      await expect(page.getByRole("table")).toContainText("doc_get");
      await expectFits(page, width);
      await shot(page, `mcp-tools-${width}-${theme}-vi`);
      await page.getByRole("tab", { name: /MCP server ngoài/ }).click();
      await expect(page).toHaveURL("/admin/mcp?tab=server");
      await expect(page.getByRole("table")).toContainText("Filesystem");
      await expectFits(page, width);
      await shot(page, `mcp-servers-${width}-${theme}-vi`);
      await page.getByRole("tab", { name: /Token MCP/ }).click();
      await expect(page).toHaveURL("/admin/mcp?tab=token");
      await expect(page.getByRole("table")).toContainText("hive_pat_test2");
      await expectFits(page, width);
      await shot(page, `mcp-tokens-${width}-${theme}-vi`);
      await page.getByRole("button", { name: "EN", exact: true }).click();
      await expect(page.getByRole("tab", { name: /MCP tokens/ })).toHaveAttribute("aria-selected", "true");
      await expectFits(page, width);
      await shot(page, `mcp-tokens-${width}-${theme}-en`);
    });
  }
}

async function expectFits(page: Page, width: number) {
  if (width >= 1100)
    for (const table of await page.getByRole("table").all())
      await expect
        .poll(() =>
          table.evaluate((el) => (el.parentElement ? el.parentElement.scrollWidth - el.parentElement.clientWidth : 0)),
        )
        .toBeLessThanOrEqual(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
}

/** Ảnh trước/sau cho người duyệt UI; chỉ chụp khi đặt HIVE_ADMINUI_SHOTS_DIR, CI không ghi file. */
async function shot(page: Page, name: string) {
  const dir = process.env.HIVE_ADMINUI_SHOTS_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}
