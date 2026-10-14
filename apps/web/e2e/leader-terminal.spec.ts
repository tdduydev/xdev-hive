import { expect, type Page, test } from "@playwright/test";
import {
  fakeHub,
  fakeTerminalSocket,
  ok,
  TERMINAL_BUSY_MACHINE,
  TERMINAL_MACHINE,
  TERMINAL_ORG,
  TERMINAL_PROJECT,
  TERMINAL_SESSION_ID,
  terminalFixture,
  terminalProposal,
  terminalSession,
} from "./fake-hub.ts";

type Fixture = ReturnType<typeof terminalFixture>;

async function setup(page: Page, fixture: Fixture, init: { lang?: "en"; theme?: "dark" } = {}) {
  await page.addInitScript(
    ({ org, lang, theme }) => {
      localStorage.setItem("hive.org", org);
      if (lang) localStorage.setItem("hive.lang", lang);
      if (theme) localStorage.setItem("hive.theme", theme);
    },
    { org: TERMINAL_ORG.id, ...init },
  );
  const hub = await fakeHub(page, { signedIn: true, rpc: fixture.rpc });
  const socket = await fakeTerminalSocket(page, fixture);
  return { hub, socket };
}

const xterm = (page: Page) => page.locator(".xterm-rows");

test("mở phiên ở chế độ Đề xuất, gõ lệnh và thấy output trong xterm", async ({ page }) => {
  const fixture = terminalFixture();
  fixture.state.sessions = [];
  const { socket } = await setup(page, fixture);
  await page.goto("/leader");

  await expect(page.getByText("Chưa có phiên terminal nào.")).toBeVisible();
  await page.getByRole("button", { name: "Mở terminal Leader" }).click();
  const dialog = page.getByRole("dialog", { name: "Mở terminal Leader" });

  // Máy: chỉ máy online; máy đã đủ phiên thì khoá kèm lý do; máy offline không hiện.
  await expect(dialog.getByRole("radio", { name: /sdlc-box-01/ })).toBeChecked();
  const busy = dialog.getByRole("radio", { name: /sdlc-box-02/ });
  await expect(busy).toBeDisabled();
  await expect(dialog).toContainText("Đã đủ số phiên terminal");
  await expect(dialog.getByRole("radio", { name: /sdlc-box-03/ })).toHaveCount(0);
  // Gói của máy: gói chưa đăng nhập bị khoá.
  await expect(dialog.getByRole("option", { name: /Claude Pro Ha \(chưa đăng nhập\)/ })).toBeDisabled();
  // Quyền: máy này cho toàn quyền.
  await expect(dialog).toContainText("Toàn quyền");
  // Model: sonnet mặc định, opus chưa đủ dữ liệu.
  await expect(dialog.getByRole("radio", { name: /Sonnet/ })).toBeChecked();
  await expect(dialog.locator("label").filter({ hasText: "Opus" })).toContainText("chưa đủ dữ liệu");
  await expect(dialog.locator("label").filter({ hasText: "Sonnet" })).toContainText("0,42 USD");
  await expect(dialog.getByRole("radio", { name: "Đề xuất" })).toBeChecked();

  await dialog.getByRole("button", { name: "Mở terminal" }).click();
  await expect(page).toHaveURL(new RegExp(`/leader/terminal/${TERMINAL_SESSION_ID}$`));
  expect(fixture.state.opened).toEqual([
    {
      projectId: TERMINAL_PROJECT.id,
      machineId: TERMINAL_MACHINE,
      mode: "propose",
      model: "sonnet",
      cols: 120,
      rows: 32,
    },
  ]);

  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PAY · payment-api" })).toBeVisible();
  expect(socket.last?.url).toMatch(/\/ws\/terminal\?ticket=ticket-\d+$/);

  socket.out("$ ");
  await expect(xterm(page)).toContainText("$");
  await page.locator(".xterm").click();
  await page.keyboard.type("tiếng Việt");
  await expect.poll(() => socket.inputs().join("")).toBe("tiếng Việt");
  await expect(xterm(page)).toContainText("tiếng Việt");
  // Cỡ khung được báo cho hub sau khi fit.
  await expect.poll(() => socket.last?.received.some((f) => f.t === "resize")).toBe(true);
  expect(socket.last?.received[0]).toEqual({ t: "resume", after: -1 });
});

test("hộp thoại báo rõ khi hub chưa bật terminal hoặc người dùng chưa đủ quyền", async ({ page }) => {
  const fixture = terminalFixture({ options: { enabled: false } });
  await setup(page, fixture);
  await page.goto("/leader");
  await page.getByRole("button", { name: "Mở terminal Leader" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Hub chưa bật Terminal Leader");
  await expect(dialog.getByRole("button", { name: "Mở terminal" })).toBeDisabled();

  const denied = terminalFixture({ options: { allowed: false } });
  const second = await page.context().newPage();
  await setup(second, denied);
  await second.goto("/leader");
  await second.getByRole("button", { name: "Mở terminal Leader" }).click();
  await expect(second.getByRole("dialog")).toContainText("quản trị đội hoặc BA/PO");
});

test("Bypass hiện cảnh báo và bắt tick xác nhận trước khi mở", async ({ page }) => {
  const fixture = terminalFixture({ session: { mode: "bypass" } });
  fixture.state.actions = [
    {
      id: "3c3c3c3c-0000-4000-8000-0000000000a1",
      at: "2026-10-14T01:10:00.000Z",
      tool: "leader_action",
      outcome: "success",
      action: 'Tạo việc "Sửa làm tròn" trong PAY',
      tier: "light",
      model: "sonnet",
      reason: "Đổi một dòng.",
    },
    {
      id: "3c3c3c3c-0000-4000-8000-0000000000a2",
      at: "2026-10-14T01:12:00.000Z",
      tool: "task_list",
      outcome: "error",
      action: null,
      tier: null,
      model: null,
      reason: null,
    },
  ];
  await setup(page, fixture);
  await page.goto("/leader");
  await page.getByRole("button", { name: "Mở terminal Leader" }).click();
  const dialog = page.getByRole("dialog", { name: "Mở terminal Leader" });
  const open = dialog.getByRole("button", { name: "Mở terminal" });
  await expect(dialog.getByLabel("Tôi hiểu và muốn mở ở chế độ Bypass")).toHaveCount(0);

  await dialog.getByRole("radio", { name: /Bypass/ }).check();
  await expect(dialog).toContainText("Leader gọi tool hub bằng quyền của bạn, không qua duyệt");
  await expect(dialog).toContainText("ghi nhật ký");
  await expect(open).toBeDisabled();
  await dialog.getByLabel("Tôi hiểu và muốn mở ở chế độ Bypass").check();
  await expect(open).toBeEnabled();
  await dialog.getByRole("radio", { name: /Opus/ }).check();
  await open.click();

  await expect(page).toHaveURL(new RegExp(`/leader/terminal/${TERMINAL_SESSION_ID}$`));
  expect(fixture.state.opened).toMatchObject([{ mode: "bypass", confirmBypass: true, model: "opus" }]);

  // Khung phải là nhật ký hành động, không phải đề xuất.
  const log = page.getByRole("region", { name: "Nhật ký hành động" });
  await expect(log).toContainText("leader_action");
  await expect(log).toContainText('Tạo việc "Sửa làm tròn" trong PAY');
  await expect(log).toContainText("Nhẹ");
  await expect(log).toContainText("Đổi một dòng.");
  await expect(log).toContainText("task_list");
  await expect(log).toContainText("Lỗi");
  await expect(page.getByRole("region", { name: "Đề xuất của phiên" })).toHaveCount(0);
});

test("đề xuất của phiên hiện cấp độ và lý do, sửa cấp rồi duyệt gửi tier mới", async ({ page }) => {
  const fixture = terminalFixture();
  const { socket } = await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);

  const panel = page.getByRole("region", { name: "Đề xuất của phiên" });
  const card = panel.getByLabel("Đề xuất của leader");
  await expect(card).toContainText('Tạo việc "Thêm hoàn tiền một phần" trong dự án PAY');
  await expect(card).toContainText("Leader chọn cấp: Vừa");
  await expect(card).toContainText("Một màn UI kèm e2e.");
  const tier = card.getByLabel("Cấp độ khi duyệt");
  await expect(tier).toHaveValue("medium");
  await expect(card).toContainText("Một màn giao diện, CRUD kèm e2e");
  await tier.selectOption("heavy");
  await expect(card).toContainText("Nhiều module, giao thức, bảo mật");

  await card.getByRole("button", { name: "Duyệt và thực hiện" }).click();
  await expect.poll(() => fixture.state.approved).toEqual([{ id: terminalProposal().id, tier: "heavy" }]);
  await expect(panel.getByText("Đã duyệt", { exact: true })).toBeVisible();

  // Đề xuất mới đến qua khung `activity` thì khung tự tải lại, không cần đợi 5 giây.
  fixture.state.proposals = [
    terminalProposal({
      id: "6f6f6f6f-0000-4000-8000-0000000000a2",
      action: { type: "run.dispatch", taskId: "1a1a1a1a-0000-4000-8000-000000000001" },
    }),
    ...fixture.state.proposals,
  ];
  socket.send({ t: "activity" });
  const second = panel.getByLabel("Đề xuất của leader").first();
  await expect(second).toContainText("Giao việc 1a1a1a1a");
  await expect(second).toContainText("Leader chưa chọn cấp độ");
  await expect(second.getByLabel("Cấp độ khi duyệt")).toHaveValue("");
  await second.getByRole("button", { name: "Từ chối…" }).click();
  await second.getByLabel("Lý do từ chối").fill("Chưa cần");
  await second.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect
    .poll(() => fixture.state.rejected)
    .toEqual([{ id: "6f6f6f6f-0000-4000-8000-0000000000a2", reason: "Chưa cần" }]);
});

test("mất kết nối thì báo, tự nối lại bằng vé mới và gửi resume sau seq cuối", async ({ page }) => {
  const fixture = terminalFixture();
  const { socket } = await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();

  socket.out("một\r\n");
  socket.out("hai\r\n");
  await expect(xterm(page)).toContainText("hai");
  // Chế độ dev của React chạy effect hai lần nên đã xin vé thừa một lần: đếm tương đối.
  const ticketsBefore = fixture.state.tickets;
  socket.drop(1006);
  await expect(page.getByRole("status").filter({ hasText: "Mất kết nối, đang nối lại" })).toBeVisible();

  await expect.poll(() => socket.sockets.length, { timeout: 8000 }).toBe(2);
  expect(fixture.state.tickets).toBe(ticketsBefore + 1);
  expect(socket.sockets[1]?.url).toContain(`ticket=ticket-${ticketsBefore + 1}`);
  await expect.poll(() => socket.sockets[1]?.received[0]).toEqual({ t: "resume", after: 1 });
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();

  // Hub phát lại cả đuôi lẫn phần mới: phần đã có không vẽ hai lần.
  socket.send({ t: "out", seq: 1, data: Buffer.from("hai\r\n").toString("base64") });
  socket.send({ t: "out", seq: 2, data: Buffer.from("ba\r\n").toString("base64") });
  await expect(xterm(page)).toContainText("ba");
  expect((await xterm(page).innerText()).match(/hai/g)).toHaveLength(1);
});

test("người xem không phải chủ phiên chỉ xem: không gõ được, không có công tắc và nút đóng", async ({ page }) => {
  const fixture = terminalFixture({ session: { isOwner: false, ownerName: "Người khác", visibility: "team" } });
  fixture.state.canInput = false;
  // Thành viên thường: quản trị tổ chức thì đóng được phiên của người khác, người xem thường thì không.
  fixture.rpc["orgs/mine"] = () => ok({ orgs: [{ ...TERMINAL_ORG, role: "member" }], canCreateOrg: false });
  const { socket } = await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);

  await expect(page.getByText("Chỉ xem").first()).toBeVisible();
  await expect(page.getByText("terminal không nhận phím gõ")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Cho đội xem" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đóng phiên" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();

  socket.out("chỉ để xem\r\n");
  await expect(xterm(page)).toContainText("chỉ để xem");
  await page.locator(".xterm").click();
  await page.keyboard.type("rm -rf /");
  await page.waitForTimeout(300);
  expect(socket.inputs()).toEqual([]);
  // Đề xuất hiện nhưng người xem không duyệt được.
  const card = page.getByLabel("Đề xuất của leader");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Duyệt và thực hiện" })).toHaveCount(0);
});

test("chủ phiên bật Cho đội xem và đóng phiên có xác nhận", async ({ page }) => {
  const fixture = terminalFixture();
  await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);

  const share = page.getByRole("switch", { name: "Cho đội xem" });
  await expect(share).not.toBeChecked();
  await share.click();
  await expect.poll(() => fixture.state.visibility).toEqual([{ id: TERMINAL_SESSION_ID, visibility: "team" }]);
  await expect(share).toBeChecked();

  await page.getByRole("button", { name: "Đóng phiên" }).click();
  const dialog = page.getByRole("dialog", { name: "Đóng phiên terminal?" });
  await dialog.getByRole("button", { name: "Giữ phiên" }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.state.closed).toBe(0);
  await page.getByRole("button", { name: "Đóng phiên" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Đóng phiên" }).click();
  await expect.poll(() => fixture.state.closed).toBe(1);
  await expect(page.getByText("Phiên đã kết thúc").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Đóng phiên" })).toHaveCount(0);
});

test("phiên đã đóng phát lại bản ghi, không nối WebSocket", async ({ page }) => {
  const fixture = terminalFixture({
    session: { state: "closed", endReason: "idle", exitCode: null, endedAt: "2026-10-14T02:00:00.000Z" },
    chunks: ["bản ghi dòng một\r\n", "bản ghi dòng hai\r\n"],
  });
  const { socket } = await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);

  await expect(xterm(page)).toContainText("bản ghi dòng một");
  await expect(xterm(page)).toContainText("bản ghi dòng hai");
  await expect(page.getByText("Phiên bị đóng vì không hoạt động quá lâu.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Phiên đã kết thúc" })).toBeVisible();
  expect(socket.sockets).toHaveLength(0);
  // Chế độ dev của React chạy effect hai lần nên có thể hỏi hai lần; lần nào cũng từ đầu bản ghi.
  expect(fixture.state.chunkCalls.length).toBeGreaterThan(0);
  for (const call of fixture.state.chunkCalls) expect(call).toMatchObject({ id: TERMINAL_SESSION_ID, after: -1 });
});

test("trang Leader liệt kê phiên terminal với trạng thái, chế độ, máy, model và link", async ({ page }) => {
  const fixture = terminalFixture();
  fixture.state.sessions = [
    terminalSession(),
    terminalSession({
      id: "7b7b7b7b-0000-4000-8000-0000000000a2",
      state: "closed",
      mode: "bypass",
      model: "opus",
      machineName: "sdlc-box-02",
      isOwner: false,
      ownerName: "Lan",
    }),
  ];
  await setup(page, fixture);
  await page.goto("/leader");
  const list = page.getByRole("region", { name: "Phiên terminal" });
  await expect(list.getByRole("link")).toHaveCount(2);
  const first = list.getByRole("link").first();
  await expect(first).toContainText("Đang chạy");
  await expect(first).toContainText("Đề xuất");
  await expect(first).toContainText("PAY · sdlc-box-01");
  await expect(first).toContainText("Sonnet");
  const second = list.getByRole("link").nth(1);
  await expect(second).toContainText("Đã kết thúc");
  await expect(second).toContainText("Bypass");
  await expect(second).toContainText("Chỉ xem");
  await expect(second).toContainText("Opus · Lan");
  await first.click();
  await expect(page).toHaveURL(new RegExp(`/leader/terminal/${TERMINAL_SESSION_ID}$`));
});

test("360 px, giao diện tối, tiếng Anh: khung đề xuất thành ngăn mở được dưới terminal", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const fixture = terminalFixture();
  await setup(page, fixture, { lang: "en", theme: "dark" });
  await page.goto("/leader");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.getByRole("button", { name: "Open Leader terminal" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Leader terminal" });
  await expect(dialog).toContainText("Machine");
  await expect(dialog).toContainText("Terminal session limit reached");
  await dialog.getByRole("radio", { name: /Bypass/ }).check();
  await expect(dialog).toContainText("Bypass skips approval");
  const box = await dialog.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  await page.keyboard.press("Escape");

  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Share with team" })).toBeVisible();
  const toggle = page.getByRole("button", { name: /Proposals \(1\)/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Leader proposal")).toBeHidden();
  await toggle.click();
  const card = page.getByLabel("Leader proposal");
  await expect(card).toBeVisible();
  await expect(card.getByLabel("Tier when approving")).toHaveValue("medium");
  await expect(card).toContainText("Leader picked tier: Medium");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  // Terminal có nền tối theo token.
  const background = await page
    .locator(".xterm-screen")
    .evaluate((el) => getComputedStyle(el.parentElement as Element).backgroundColor);
  expect(background).not.toBe("rgb(255, 255, 255)");
});

test("vé WebSocket bị từ chối 4403 thì dừng và báo mất quyền xem", async ({ page }) => {
  const fixture = terminalFixture({ session: { isOwner: false, visibility: "team" } });
  fixture.state.canInput = false;
  const { socket } = await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();
  const ticketsBefore = fixture.state.tickets;
  socket.drop(4403);
  await expect(page.getByText("Bạn không còn quyền xem phiên này")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(socket.sockets).toHaveLength(1);
  expect(fixture.state.tickets).toBe(ticketsBefore);
});

test("máy busy: đủ số phiên thì không chọn được, mở máy khác", async ({ page }) => {
  const fixture = terminalFixture();
  await setup(page, fixture);
  await page.goto("/leader");
  await page.getByRole("button", { name: "Mở terminal Leader" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: /sdlc-box-02/ })).toBeDisabled();
  await dialog.getByRole("radio", { name: /sdlc-box-01/ }).check();
  await dialog.getByLabel("Gói agent").selectOption("claude-1");
  await dialog.getByRole("button", { name: "Mở terminal" }).click();
  await expect(page).toHaveURL(/\/leader\/terminal\//);
  expect(fixture.state.opened).toMatchObject([{ machineId: TERMINAL_MACHINE, accountId: "claude-1" }]);
  expect(JSON.stringify(fixture.state.opened)).not.toContain(TERMINAL_BUSY_MACHINE);
});
