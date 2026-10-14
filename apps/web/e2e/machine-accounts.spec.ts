import { expect, type Page, test } from "@playwright/test";
import { ACCOUNTS_ORG, fakeHub, machineAccountsFixture, SHARED_MACHINE_ID } from "./fake-hub.ts";

async function openAccounts(page: Page, opts: { codexPolls?: number } = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ACCOUNTS_ORG.id);
  const { state, rpc } = machineAccountsFixture(opts);
  const hub = await fakeHub(page, { signedIn: true, rpc });
  await page.goto("/machines");
  return { state, hub };
}

async function openDialog(page: Page, machine: string) {
  await page.getByRole("button", { name: `Gói agent của ${machine}` }).click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`Gói agent · ${machine}`) });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("thêm gói Claude theo gói Pro/Max: URL, dán mã xác nhận, hoàn tất", async ({ page }) => {
  const { state, hub } = await openAccounts(page);
  const dialog = await openDialog(page, "sdlc-box-01");
  await expect(dialog.getByText("Claude Max team")).toBeVisible();
  await expect(dialog.getByText("Chưa đăng nhập")).toBeVisible();
  await expect(dialog.getByText("còn 68%")).toBeVisible();

  await dialog.getByLabel("Tên gói").fill("Claude Pro Ha");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await expect(dialog.getByRole("radio", { name: /Theo gói Pro\/Max/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();

  expect(hub.rpcCalls.find((call) => call.path === "machines/accounts/loginStart")?.input).toEqual({
    machineId: SHARED_MACHINE_ID,
    cli: "claude",
    label: "Claude Pro Ha",
    how: "plan",
  });
  const open = dialog.getByRole("link", { name: "Mở trang đăng nhập" });
  await expect(open).toHaveAttribute("href", /claude\.ai\/oauth/);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", /noopener/);

  await dialog.getByLabel("Dán mã xác nhận").fill("  auth-code-xyz ");
  await dialog.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Đã đăng nhập" })).toContainText("claude-2");
  expect(state.pasted).toEqual(["  auth-code-xyz "]);
  // Gói mới vào danh sách mà không cần tải lại trang.
  await expect(dialog.getByRole("list").getByText("Claude Pro Ha")).toBeVisible();
});

test("dán token: ô là password và có cảnh báo token 1 năm", async ({ page }) => {
  const { state } = await openAccounts(page);
  const dialog = await openDialog(page, "sdlc-box-01");
  await dialog.getByLabel("Tên gói").fill("CI token");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await dialog.getByRole("radio", { name: /Dán token/ }).check();
  await expect(dialog.getByRole("note")).toContainText("1 năm");
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  const field = dialog.getByLabel("Dán token");
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("sk-ant-oat01-secret");
  await dialog.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Đã đăng nhập" })).toBeVisible();
  expect(state.pasted).toEqual(["sk-ant-oat01-secret"]);
  await expect(page.getByText("sk-ant-oat01-secret")).toHaveCount(0);
});

test("thêm gói Codex bằng mã thiết bị: hiện URL và mã, tự xong sau vài lần hỏi", async ({ page }) => {
  const { hub } = await openAccounts(page, { codexPolls: 2 });
  const dialog = await openDialog(page, "sdlc-box-01");
  await dialog.getByRole("radio", { name: "Codex" }).check();
  await dialog.getByLabel("Tên gói").fill("Codex Pro");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await expect(dialog.getByRole("radio", { name: /Mã thiết bị/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  expect(hub.rpcCalls.find((call) => call.path === "machines/accounts/loginStart")?.input).toMatchObject({
    cli: "codex",
    how: "device",
  });
  await expect(dialog.getByRole("status", { name: "Mã thiết bị" })).toHaveText("ABCD-1234");
  await expect(dialog.getByRole("link", { name: "Mở trang đăng nhập" })).toHaveAttribute("href", /auth\.openai\.com/);
  await expect(dialog.getByRole("button", { name: "Chép mã thiết bị" })).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "Đã đăng nhập" })).toContainText("codex-2");
  expect(hub.rpcCalls.filter((call) => call.path === "machines/accounts/loginGet").length).toBeGreaterThan(2);
});

test("huỷ phiên đăng nhập rồi thử lại", async ({ page }) => {
  const { hub } = await openAccounts(page);
  const dialog = await openDialog(page, "sdlc-box-01");
  await dialog.getByLabel("Tên gói").fill("Claude tạm");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  await dialog.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Đã huỷ phiên đăng nhập");
  expect(hub.rpcCalls.some((call) => call.path === "machines/accounts/loginCancel")).toBe(true);
  await dialog.getByRole("button", { name: "Thử lại" }).click();
  await expect(dialog.getByRole("button", { name: "Bắt đầu đăng nhập" })).toBeVisible();
});

test("mở lại hộp thoại khi phiên đang dở thì tiếp tục đúng bước", async ({ page }) => {
  await openAccounts(page);
  let dialog = await openDialog(page, "sdlc-box-01");
  await dialog.getByLabel("Tên gói").fill("Claude dở");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  await expect(dialog.getByLabel("Dán mã xác nhận")).toBeVisible();
  await dialog.getByRole("button", { name: "Thoát hộp thoại" }).click();
  await expect(dialog).toBeHidden();
  dialog = await openDialog(page, "sdlc-box-01");
  await expect(dialog.getByLabel("Dán mã xác nhận")).toBeVisible();
});

test("bật tắt một gói gọi setAccount", async ({ page }) => {
  const { state, hub } = await openAccounts(page);
  const dialog = await openDialog(page, "sdlc-box-01");
  const toggle = dialog.getByRole("switch", { name: "Dùng gói Claude Max team" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(hub.rpcCalls.find((call) => call.path === "machines/setAccount")?.input).toEqual({
    machineId: SHARED_MACHINE_ID,
    accountId: "claude-1",
    enabled: false,
  });
  expect(state.accounts[0]?.enabled).toBe(false);
});

test("máy cá nhân chỉ hiện lời nhắc, không cho thêm gói", async ({ page }) => {
  await openAccounts(page);
  const dialog = await openDialog(page, "dev-ha");
  await expect(dialog.getByText("Máy cá nhân: chủ máy quản lý gói tại máy.")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Thêm gói" })).toHaveCount(0);
  await expect(dialog.getByRole("switch")).toHaveCount(0);
});

test("màn 360 px: hộp thoại không tràn ngang, các bước dùng được", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await openAccounts(page);
  const dialog = await openDialog(page, "sdlc-box-01");
  const fits = () =>
    dialog.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.scrollWidth <= Math.ceil(box.width) && box.left >= 0 && box.right <= window.innerWidth;
    });
  // Hộp thoại có hiệu ứng phóng to lúc mở, đo lúc đó cho kích thước sai; đợi tới khi ổn định.
  await expect.poll(fits, { message: "hộp thoại tràn ngang ở bước 1" }).toBe(true);
  await dialog.getByLabel("Tên gói").fill("Claude điện thoại");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  await expect(dialog.getByLabel("Dán mã xác nhận")).toBeVisible();
  await expect.poll(fits, { message: "hộp thoại tràn ngang ở bước dán mã" }).toBe(true);
});

test("tiếng Anh: hộp thoại và các bước theo ngôn ngữ đã chọn", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await openAccounts(page);
  await page.getByRole("button", { name: "Agent accounts of sdlc-box-01" }).click();
  const dialog = page.getByRole("dialog", { name: /Agent accounts · sdlc-box-01/ });
  await expect(dialog.getByRole("heading", { name: "Add account" })).toBeVisible();
  await expect(dialog.getByText("Signed out")).toBeVisible();
  await dialog.getByLabel("Account name").fill("Claude EN");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("radio", { name: /^Pro\/Max plan/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Start sign-in" }).click();
  await expect(dialog.getByLabel("Paste the confirmation code")).toBeVisible();
});
