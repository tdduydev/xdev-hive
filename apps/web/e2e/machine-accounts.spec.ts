import { expect, type Page, test } from "@playwright/test";
import {
  ACCOUNTS_ORG,
  fakeHub,
  machineAccountsFixture,
  ok,
  PERSONAL_MACHINE_ID,
  type RpcHandler,
  SHARED_MACHINE_ID,
} from "./fake-hub.ts";

const OFFLINE_MACHINE_ID = "8e8e8e8e-0000-4000-8000-000000000003";
const RUN_ID = "5d5d5d5d-0000-4000-8000-000000000001";
const OLD_RUN_ID = "5d5d5d5d-0000-4000-8000-000000000002";
const at = "2026-10-13T08:00:00.000Z";

/** Run của máy dùng chung cho tab Lượt chạy và khối Đang chạy: một run đang chạy, một run đã xong. */
function runRow(id: string, state: string, taskKey: string, taskTitle: string) {
  return {
    id,
    taskId: "6c6c6c6c-0000-4000-8000-000000000001",
    projectId: "9a9a9a9a-0000-4000-8000-000000000001",
    kind: "code",
    state,
    cli: "claude",
    machineId: SHARED_MACHINE_ID,
    machineName: "sdlc-box-01",
    startedAt: at,
    finishedAt: state === "running" ? null : "2026-10-13T08:20:00.000Z",
    cost: { costUsd: 0.42 },
    prUrl: null,
    taskKey,
    taskTitle,
  };
}

async function setup(page: Page, opts: { codexPolls?: number; extra?: Record<string, RpcHandler> } = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ACCOUNTS_ORG.id);
  const { state, rpc } = machineAccountsFixture(opts);
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...rpc,
      "runs/search": () =>
        ok({
          items: [
            runRow(RUN_ID, "running", "PAY-12", "Sửa lỗi thanh toán"),
            runRow(OLD_RUN_ID, "succeeded", "PAY-9", "Thêm webhook"),
          ],
          nextCursor: null,
          machines: [],
        }),
      ...opts.extra,
    },
  });
  return { state, hub, rpc };
}

/** Thêm máy mất kết nối và bản worker mới để danh sách có đủ trạng thái (ảnh, cột Worker). */
function withMoreMachines(rpc: Record<string, RpcHandler>): Record<string, RpcHandler> {
  return {
    "machines/workerRelease": () => ok({ version: "1.4.0", url: "https://example.test/v1.4.0", publishedAt: at }),
    "machines/list": (input, call, hub) => {
      const base = rpc["machines/list"]?.(input, call, hub);
      const list = (base?.json as { json: Record<string, unknown>[] } | undefined)?.json ?? [];
      return ok([
        ...list,
        {
          ...list[1],
          id: OFFLINE_MACHINE_ID,
          name: "mac-mini-office-02",
          os: "darwin",
          version: "1.4.0",
          status: "offline",
          lastSeenAt: "2026-10-12T08:00:00.000Z",
        },
      ]);
    },
  };
}

async function openAccounts(page: Page, opts: { codexPolls?: number } = {}) {
  const result = await setup(page, opts);
  await page.goto(`/machines/${SHARED_MACHINE_ID}?tab=goi-agent`);
  return result;
}

async function openDialog(page: Page, machine = "sdlc-box-01") {
  await page.getByRole("tabpanel").getByRole("button", { name: "Thêm gói" }).click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`Thêm gói · ${machine}`) });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("danh sách máy: bấm dòng mở trang máy, ⋯ mở tab Gói agent, thao tác dòng tối đa hai nút", async ({ page }) => {
  await setup(page);
  await page.goto("/machines");
  await expect(page.getByRole("heading", { name: "Máy", exact: true })).toBeVisible();
  const row = page.getByRole("row", { name: /sdlc-box-01/ });
  await expect(row).toContainText("Sẵn sàng");
  await expect(row).toContainText("Dùng chung");
  await expect(row.getByRole("button", { name: "Tạm dừng", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Thu hồi", exact: true })).toBeVisible();
  // Cho đội dùng chung và Gói agent nằm trong menu ⋯, giữ tên truy cập theo máy.
  await row.getByRole("button", { name: "Thao tác khác cho sdlc-box-01" }).click();
  await expect(page.getByRole("menuitem", { name: "Thôi dùng chung sdlc-box-01" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Gói agent của sdlc-box-01" }).click();
  await expect(page).toHaveURL(`/machines/${SHARED_MACHINE_ID}?tab=goi-agent`);
  await expect(page.getByRole("tab", { name: /Gói agent/ })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("link", { name: "Máy", exact: true }).first().click();
  await expect(page).toHaveURL("/machines");
  await page
    .getByRole("row", { name: /dev-ha/ })
    .getByText("Cá nhân")
    .click();
  await expect(page).toHaveURL(`/machines/${PERSONAL_MACHINE_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "dev-ha" })).toBeVisible();
});

test("danh sách máy: máy mất kết nối báo trong dòng, không có cảnh báo riêng dưới bảng", async ({ page }) => {
  const { rpc } = machineAccountsFixture();
  await setup(page, { extra: withMoreMachines(rpc) });
  await page.goto("/machines");
  const row = page.getByRole("row", { name: /mac-mini-office-02/ });
  await expect(row).toContainText("Mất kết nối");
  await expect(row).toContainText("Nhịp");
  await expect(page.getByText(/mất kết nối\. Run đang chờ/)).toHaveCount(0);
  // Bản worker cũ có nhãn và nút cập nhật theo tên máy ở cột Worker.
  await expect(page.getByRole("row", { name: /sdlc-box-01/ })).toContainText("Có bản 1.4.0");
  await expect(page.getByRole("button", { name: "Cập nhật worker trên sdlc-box-01" })).toBeVisible();
  await expect(row.getByRole("button", { name: /Cập nhật worker/ })).toHaveCount(0);
});

test("trang máy: đầu trang, tab có URL, lượt chạy theo máy, thu hồi ở vùng nguy hiểm", async ({ page }) => {
  const { rpc } = machineAccountsFixture();
  const { hub } = await setup(page, {
    extra: {
      ...withMoreMachines(rpc),
      "machines/update": (input) => ok({ id: (input as { machineId: string }).machineId, name: "sdlc-box-01" }),
      "machines/revoke": (input) => ok({ id: (input as { machineId: string }).machineId, name: "sdlc-box-01" }),
    },
  });
  await page.goto(`/machines/${SHARED_MACHINE_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "sdlc-box-01" })).toBeVisible();
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  // Máy có run đang giữ chỗ nên trạng thái là Đang chạy, không phải Sẵn sàng.
  await expect(header).toContainText("Đang chạy");
  await expect(header).toContainText("Linux");
  await expect(header).toContainText("Worker 1.3.0");

  // Tổng quan: thông tin máy và run đang giữ chỗ.
  const running = page.getByRole("region", { name: "Đang chạy" });
  await expect(running).toContainText("Sửa lỗi thanh toán");
  await expect(running).not.toContainText("Thêm webhook");
  await expect(running).toContainText("1 / 2 chỗ đang dùng.");

  await page.getByRole("button", { name: "Cập nhật worker trên sdlc-box-01" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã gửi lệnh cập nhật" })).toContainText("sdlc-box-01");

  await page.getByRole("tab", { name: "Lượt chạy" }).click();
  await expect(page).toHaveURL(`/machines/${SHARED_MACHINE_ID}?tab=luot-chay`);
  await expect(page.getByRole("row", { name: /PAY-9/ })).toContainText("Thành công");
  expect(hub.rpcCalls.find((call) => call.path === "runs/search")?.input).toMatchObject({
    machineId: SHARED_MACHINE_ID,
  });
  await page.reload();
  await expect(page.getByRole("tab", { name: "Lượt chạy" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("tab", { name: "Tổng quan" }).click();
  await expect(page).toHaveURL(`/machines/${SHARED_MACHINE_ID}`);
  const danger = page.getByRole("region", { name: "Vùng nguy hiểm" });
  await danger.getByRole("button", { name: "Thu hồi máy" }).click();
  const confirm = page.getByRole("dialog", { name: "Thu hồi máy sdlc-box-01?" });
  await confirm.getByRole("button", { name: "Thu hồi máy" }).click();
  await expect(confirm).toBeHidden();
  expect(hub.rpcCalls.find((call) => call.path === "machines/revoke")?.input).toEqual({
    machineId: SHARED_MACHINE_ID,
  });
});

test("trang máy: id không có thì báo không tìm thấy và chỉ đường về danh sách", async ({ page }) => {
  await setup(page);
  await page.goto("/machines/8e8e8e8e-0000-4000-8000-0000000000ff");
  await expect(page.getByText("Không tìm thấy máy này")).toBeVisible();
  await page.getByRole("link", { name: "Về danh sách máy" }).click();
  await expect(page).toHaveURL("/machines");
});

test("thêm gói Claude theo gói Pro/Max: URL, dán mã xác nhận, hoàn tất", async ({ page }) => {
  const { state, hub } = await openAccounts(page);
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("Claude Max team")).toBeVisible();
  await expect(panel.getByText("Chưa đăng nhập")).toBeVisible();
  await expect(panel.getByText("còn 68%")).toBeVisible();
  const dialog = await openDialog(page);

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
  await expect(dialog.getByRole("list", { name: "Các bước thêm gói" }).locator('[aria-current="step"]')).toHaveText(
    /Xong/,
  );
  expect(state.pasted).toEqual(["  auth-code-xyz "]);
  await dialog.getByRole("button", { name: "Xong", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Gói mới vào danh sách mà không cần tải lại trang.
  await expect(panel.getByRole("list").getByText("Claude Pro Ha")).toBeVisible();
});

test("dán token: ô là password và có cảnh báo token 1 năm", async ({ page }) => {
  const { state } = await openAccounts(page);
  const dialog = await openDialog(page);
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
  const dialog = await openDialog(page);
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
  const dialog = await openDialog(page);
  await dialog.getByLabel("Tên gói").fill("Claude tạm");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  await dialog.getByRole("button", { name: "Huỷ", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Đã huỷ phiên đăng nhập");
  expect(hub.rpcCalls.some((call) => call.path === "machines/accounts/loginCancel")).toBe(true);
  await dialog.getByRole("button", { name: "Thử lại" }).click();
  await expect(dialog.getByRole("button", { name: "Bắt đầu đăng nhập" })).toBeVisible();
});

test("đóng hộp thoại khi phiên đang dở thì tab báo và mở lại đúng bước", async ({ page }) => {
  await openAccounts(page);
  let dialog = await openDialog(page);
  await dialog.getByLabel("Tên gói").fill("Claude dở");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  await expect(dialog.getByLabel("Dán mã xác nhận")).toBeVisible();
  await dialog.getByRole("button", { name: "Thoát hộp thoại" }).click();
  await expect(dialog).toBeHidden();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("status").filter({ hasText: "Đang đăng nhập gói Claude dở" })).toBeVisible();
  await panel.getByRole("button", { name: "Tiếp tục đăng nhập" }).click();
  dialog = page.getByRole("dialog", { name: /Thêm gói · sdlc-box-01/ });
  await expect(dialog.getByLabel("Dán mã xác nhận")).toBeVisible();
});

test("bật tắt một gói gọi setAccount", async ({ page }) => {
  const { state, hub } = await openAccounts(page);
  const toggle = page.getByRole("tabpanel").getByRole("switch", { name: "Dùng gói Claude Max team" });
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
  await setup(page);
  await page.goto(`/machines/${PERSONAL_MACHINE_ID}?tab=goi-agent`);
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("Máy cá nhân: chủ máy quản lý gói tại máy.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Thêm gói" })).toHaveCount(0);
  await expect(panel.getByRole("switch")).toHaveCount(0);
});

test("màn 360 px: trang máy và hộp thoại không tràn ngang, nút bước luôn thấy", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openAccounts(page);
  await expect(page.getByRole("heading", { level: 1, name: "sdlc-box-01" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const dialog = await openDialog(page);
  const fits = () =>
    dialog.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return (
        el.scrollWidth <= Math.ceil(box.width) &&
        box.left >= 0 &&
        box.right <= window.innerWidth &&
        box.bottom <= window.innerHeight
      );
    });
  // Hộp thoại có hiệu ứng phóng to lúc mở, đo lúc đó cho kích thước sai; đợi tới khi ổn định.
  await expect.poll(fits, { message: "hộp thoại tràn ở bước 1" }).toBe(true);
  await dialog.getByLabel("Tên gói").fill("Claude điện thoại");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  // Bước chọn cách đăng nhập có 4 thẻ: thân cuộn, nút vẫn trong màn hình.
  await expect(dialog.getByRole("button", { name: "Bắt đầu đăng nhập" })).toBeInViewport();
  await expect.poll(fits, { message: "hộp thoại tràn ở bước cách đăng nhập" }).toBe(true);
  await dialog.getByRole("button", { name: "Bắt đầu đăng nhập" }).click();
  await expect(dialog.getByLabel("Dán mã xác nhận")).toBeVisible();
  await expect.poll(fits, { message: "hộp thoại tràn ở bước dán mã" }).toBe(true);
});

test("tiếng Anh: danh sách, trang máy và hộp thoại theo ngôn ngữ đã chọn", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await setup(page);
  await page.goto("/machines");
  await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /sdlc-box-01/ })).toContainText("Ready");
  await page
    .getByRole("row", { name: /sdlc-box-01/ })
    .getByRole("button", { name: "More actions for sdlc-box-01" })
    .click();
  await page.getByRole("menuitem", { name: "Agent accounts of sdlc-box-01" }).click();
  await expect(page.getByRole("tab", { name: /Agent accounts/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByText("Signed out")).toBeVisible();
  await page.getByRole("tabpanel").getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog", { name: /Add account · sdlc-box-01/ });
  await dialog.getByLabel("Account name").fill("Claude EN");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("radio", { name: /^Pro\/Max plan/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Start sign-in" }).click();
  await expect(dialog.getByLabel("Paste the confirmation code")).toBeVisible();
});

// Ảnh sau khi đổi giao diện (admin-layout.md § Migration checklist 8): chỉ chụp khi đặt HIVE_SHOTS_DIR.
const SHOTS = process.env.HIVE_SHOTS_DIR;
for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["vi", "en"] as const) {
    for (const width of [1440, 1100, 360]) {
      test(`ảnh trang Máy ${width} ${scheme} ${lang}`, async ({ page }) => {
        test.skip(!SHOTS, "chỉ chụp khi đặt HIVE_SHOTS_DIR");
        test.setTimeout(120_000);
        await page.emulateMedia({ colorScheme: scheme });
        await page.addInitScript((value) => localStorage.setItem("hive.lang", value), lang);
        const { rpc } = machineAccountsFixture();
        await setup(page, { extra: withMoreMachines(rpc) });
        await page.setViewportSize({ width, height: 900 });
        const shot = (name: string) =>
          page.screenshot({ path: `${SHOTS}/machines-${name}-${width}-${scheme}-${lang}.png`, fullPage: true });
        await page.goto("/machines");
        await expect(page.getByRole("row", { name: /sdlc-box-01/ })).toBeVisible();
        await shot("list");
        await page.goto(`/machines/${SHARED_MACHINE_ID}`);
        await expect(page.getByRole("region", { name: lang === "vi" ? "Đang chạy" : "Running now" })).toContainText(
          "PAY-12",
        );
        await shot("detail");
        await page.goto(`/machines/${SHARED_MACHINE_ID}?tab=goi-agent`);
        await expect(page.getByRole("tabpanel").getByText("Claude Max team")).toBeVisible();
        await shot("accounts");
        await page.goto(`/machines/${SHARED_MACHINE_ID}?tab=luot-chay`);
        await expect(page.getByRole("row", { name: /PAY-9/ })).toBeVisible();
        await shot("runs");
        await page.goto(`/machines/${SHARED_MACHINE_ID}?tab=goi-agent`);
        await page
          .getByRole("tabpanel")
          .getByRole("button", { name: lang === "vi" ? "Thêm gói" : "Add account" })
          .click();
        await page.getByRole("dialog").getByRole("textbox").fill("Claude Max 2");
        await page
          .getByRole("dialog")
          .getByRole("button", { name: lang === "vi" ? "Tiếp tục" : "Continue" })
          .click();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${SHOTS}/machines-add-account-${width}-${scheme}-${lang}.png` });
      });
    }
  }
}
