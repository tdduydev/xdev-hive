import { expect, type Page, test } from "@playwright/test";
import { fakeHub, fakeTerminalSocket, ok, TERMINAL_ORG, TERMINAL_SESSION_ID, terminalFixture } from "./fake-hub.ts";

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
  await fakeHub(page, { signedIn: true, rpc: fixture.rpc });
  return fakeTerminalSocket(page, fixture, { echo: false });
}

const bar = (page: Page) => page.getByRole("toolbar", { name: "Thanh phím terminal" });

/** Các khung `in` hub nhận được, nối lại thành một chuỗi: kiểm đúng byte đi vào PTY. */
const typed = (socket: Awaited<ReturnType<typeof setup>>) => socket.inputs().join("");

test.use({ viewport: { width: 360, height: 740 } });

test("360 px, tối: thanh phím hiện, nút đủ cỡ chạm, phím và ô soạn gửi đúng byte, trang không cuộn ngang", async ({
  page,
}) => {
  const fixture = terminalFixture();
  const socket = await setup(page, fixture, { theme: "dark" });
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(bar(page)).toBeVisible();

  // Mọi nút cao và rộng tối thiểu 44 px (cỡ chạm của Apple/WCAG).
  for (const button of await bar(page).getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box?.height, await button.innerText()).toBeGreaterThanOrEqual(44);
    expect(box?.width, await button.innerText()).toBeGreaterThanOrEqual(44);
  }

  await bar(page).getByRole("button", { name: "Ctrl-C", exact: true }).click();
  await expect.poll(() => typed(socket)).toBe("\x03");
  await bar(page).getByRole("button", { name: "Esc" }).click();
  await bar(page).getByRole("button", { name: "Tab" }).click();
  await bar(page).getByRole("button", { name: "Mũi tên lên" }).click();
  await bar(page).getByRole("button", { name: "Mũi tên trái" }).click();
  await bar(page).getByRole("button", { name: "Ctrl-D" }).click();
  await bar(page).getByRole("button", { name: "/" }).click();
  await bar(page).getByRole("button", { name: "Enter" }).click();
  await expect.poll(() => typed(socket)).toBe("\x03\x1b\t\x1b[A\x1b[D\x04/\r");

  // Ô soạn: chữ Việt có dấu đi nguyên vẹn, rồi Enter tách riêng.
  const line = page.getByRole("textbox", { name: "Soạn dòng" });
  await line.fill("xin chào");
  await page.getByRole("button", { name: "Gửi dòng" }).click();
  await expect(line).toHaveValue("");
  await expect.poll(() => typed(socket)).toBe("\x03\x1b\t\x1b[A\x1b[D\x04/\rxin chào\r");

  // Không cuộn ngang ở 360 px: thanh phím tự cuộn trong khung của nó.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(360);
  const box = await bar(page).boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  expect(await bar(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("Ctrl giữ: bấm Ctrl rồi gõ chữ trên bàn phím của xterm thành mã điều khiển, rồi tự nhả", async ({ page }) => {
  const fixture = terminalFixture();
  const socket = await setup(page, fixture);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();

  const ctrl = bar(page).getByRole("button", { name: "Ctrl", exact: true });
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  await page.locator(".xterm").click();
  await page.keyboard.type("r");
  await expect.poll(() => typed(socket)).toBe("\x12");
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.type("r");
  await expect.poll(() => typed(socket)).toBe("\x12r");

  // Ctrl giữ cũng áp cho nút trên thanh: Ctrl + / là 0x1f; Alt + Enter là ESC CR.
  await ctrl.click();
  await bar(page).getByRole("button", { name: "/" }).click();
  await bar(page).getByRole("button", { name: "Alt" }).click();
  await bar(page).getByRole("button", { name: "Enter" }).click();
  await expect.poll(() => typed(socket)).toBe("\x12r\x1f\x1b\r");
});

test("người chỉ xem không có thanh phím, và máy tính để người dùng tự bật", async ({ page }) => {
  const viewer = terminalFixture({ session: { isOwner: false, visibility: "team" } });
  viewer.state.canInput = false;
  viewer.rpc["orgs/mine"] = () => ok({ orgs: [{ ...TERMINAL_ORG, role: "member" }], canCreateOrg: false });
  await setup(page, viewer);
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thanh phím" })).toHaveCount(0);

  const desktop = await page.context().newPage();
  await desktop.setViewportSize({ width: 1280, height: 800 });
  const socket = await setup(desktop, terminalFixture());
  await desktop.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(desktop.getByRole("status").filter({ hasText: "Đã kết nối" })).toBeVisible();
  await expect(bar(desktop)).toHaveCount(0);
  await desktop.getByRole("button", { name: "Thanh phím" }).click();
  await expect(bar(desktop)).toBeVisible();
  await bar(desktop).getByRole("button", { name: "Ctrl-C", exact: true }).click();
  await expect.poll(() => typed(socket)).toBe("\x03");
});

test("tiếng Anh: thanh phím và ô soạn có nhãn tiếng Anh", async ({ page }) => {
  await setup(page, terminalFixture(), { lang: "en" });
  await page.goto(`/leader/terminal/${TERMINAL_SESSION_ID}`);
  await expect(page.getByRole("toolbar", { name: "Terminal key bar" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Compose line" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Arrow up" })).toBeVisible();
});
