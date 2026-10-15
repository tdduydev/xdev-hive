import { generateKeyPairSync } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  fakeHub,
  fakeRemoteSocket,
  ok,
  REMOTE_SESSION_COLLEAGUE,
  REMOTE_SESSION_ENDED,
  REMOTE_SESSION_LIVE,
  remoteFixture,
  TERMINAL_ORG,
} from "./fake-hub.ts";

type Fixture = ReturnType<typeof remoteFixture>;

async function setup(
  page: Page,
  fixture: Fixture,
  init: { lang?: "en"; theme?: "dark" } = {},
  extra: Record<string, () => ReturnType<typeof ok>> = {},
) {
  await page.addInitScript(
    ({ org, lang, theme }) => {
      localStorage.setItem("hive.org", org);
      if (lang) localStorage.setItem("hive.lang", lang);
      if (theme) localStorage.setItem("hive.theme", theme);
    },
    { org: TERMINAL_ORG.id, ...init },
  );
  return fakeHub(page, { signedIn: true, rpc: { ...fixture.rpc, ...extra } });
}

/** WebSocket của phiên đang chạy; các test ở đây không xin quyền gõ nên passkey chỉ là khoá bất kỳ. */
const liveSocket = (page: Page, fixture: Fixture) =>
  fakeRemoteSocket(page, fixture, {
    sessionId: REMOTE_SESSION_LIVE,
    deviceId: "dev-phone-01",
    passkey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey,
  });

const xterm = (page: Page) => page.locator(".xterm-rows");
const noHorizontalScroll = async (page: Page, width: number) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
};

test("danh sách: máy với trạng thái từ xa, phiên đang chạy trước, phiên của đồng nghiệp chỉ xem", async ({ page }) => {
  await setup(page, remoteFixture());
  await page.goto("/remote");

  await expect(page.getByRole("heading", { name: "Điều khiển từ xa", level: 1 })).toBeVisible();
  const machines = page.getByRole("region", { name: "Máy của tôi" });
  await expect(machines.getByText("Từ xa đang bật", { exact: true })).toBeVisible();
  await expect(machines.getByText("Từ xa đang tắt", { exact: true })).toBeVisible();
  await expect(machines.getByText("Offline", { exact: true })).toBeVisible();
  await expect(machines.getByText("1 đang chạy")).toBeVisible();

  const sessions = page.getByRole("region", { name: "Phiên" });
  const links = sessions.getByRole("link");
  await expect(links).toHaveCount(3);
  // Đang chạy lên trước, rồi phiên đã kết thúc mới nhất trước.
  await expect(links.nth(0)).toContainText("PAY-12");
  await expect(links.nth(0)).toContainText("Đang chạy");
  await expect(links.nth(1)).toContainText("payment-api/apps/hub");
  await expect(links.nth(1)).toContainText("12,3 KB");
  await expect(links.nth(2)).toContainText("Chỉ xem");
  await expect(links.nth(2)).toContainText(/Lê Minh Anh/);
  await expect(links.nth(2)).toContainText("Cho đội xem");
});

test("danh sách rỗng nói cách có phiên đầu tiên", async ({ page }) => {
  await setup(page, remoteFixture({ sessions: [] }));
  await page.goto("/remote");
  await expect(page.getByRole("heading", { name: "Chưa có phiên nào" })).toBeVisible();
  await expect(page.getByText("Chạy `hive` trên máy của bạn")).toBeVisible();
});

test("menu có Điều khiển từ xa và bấm vào mở trang", async ({ page }) => {
  await setup(page, remoteFixture());
  await page.goto("/tasks");
  await page.getByRole("link", { name: "Điều khiển từ xa" }).first().click();
  await expect(page).toHaveURL(/\/remote$/);
});

test("phát lại: tải bản ghi theo từng trang từ đầu, không cần WebSocket, hiện lý do kết thúc", async ({ page }) => {
  const fixture = remoteFixture({ chunks: ["dòng một\r\n", "dòng hai\r\n", "dòng ba\r\n"], pageSize: 1 });
  let sockets = 0;
  // Vite mở WebSocket HMR của riêng nó; chỉ đếm kết nối terminal.
  page.on("websocket", (socket) => {
    if (socket.url().includes("/ws/terminal")) sockets += 1;
  });
  await setup(page, fixture);
  await page.goto(`/remote/${REMOTE_SESSION_ENDED}`);

  await expect(xterm(page)).toContainText("dòng một");
  await expect(xterm(page)).toContainText("dòng hai");
  await expect(xterm(page)).toContainText("dòng ba");
  await expect(page.getByRole("status").filter({ hasText: "Đã kết thúc" })).toBeVisible();
  await expect(page.getByText("CLI đã thoát.")).toBeVisible();
  await expect(page.getByText("Máy: sdlc-box-01")).toBeVisible();
  await expect(page.getByText("Bản ghi: 12,3 KB")).toBeVisible();

  // Mỗi trang hỏi tiếp từ seq cuối của trang trước; dev mode chạy effect hai lần nên có thể có hai lượt từ đầu.
  const afters = fixture.state.chunkCalls.map((call) => call.after);
  expect(afters).toEqual(expect.arrayContaining([-1, 0, 1]));
  for (const call of fixture.state.chunkCalls) expect(call.id).toBe(REMOTE_SESSION_ENDED);
  expect(sockets).toBe(0);
});

test("phiên đang chạy: xem trực tiếp qua WebSocket thay vì tải bản ghi", async ({ page }) => {
  const fixture = remoteFixture({ chunks: ["bản ghi cũ\r\n"] });
  await setup(page, fixture);
  const socket = await liveSocket(page, fixture);
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  socket.out("đang làm dở\r\n");

  await expect(xterm(page)).toContainText("đang làm dở");
  await expect(page.getByRole("status").filter({ hasText: "Đang chạy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Điều khiển", exact: true })).toBeVisible();
  expect(socket.sockets[0]?.received[0]).toEqual({ t: "resume", after: -1 });
  expect(fixture.state.chunkCalls).toEqual([]);
});

test("phiên của đồng nghiệp: chỉ xem, hiện người mở", async ({ page }) => {
  await setup(page, remoteFixture({ chunks: ["của đồng nghiệp\r\n"] }));
  await page.goto(`/remote/${REMOTE_SESSION_COLLEAGUE}`);
  await expect(xterm(page)).toContainText("của đồng nghiệp");
  await expect(page.getByRole("status").filter({ hasText: "Đã kết thúc" })).toBeVisible();
  await expect(page.getByText("Chỉ xem").first()).toBeVisible();
  await expect(page.getByText("Người mở: Lê Minh Anh")).toBeVisible();
});

test("không tìm thấy phiên: hiện lỗi của hub và nút tải lại", async ({ page }) => {
  await setup(page, remoteFixture());
  await page.goto("/remote/7b7b7b7b-0000-4000-8000-0000000000ff");
  await expect(page.getByRole("alert")).toContainText("Không tìm thấy phiên.");
  await expect(page.getByRole("button", { name: "Tải lại" })).toBeVisible();
});

test("tiếng Anh: danh sách và trang phiên đổi chữ", async ({ page }) => {
  const fixture = remoteFixture();
  await setup(page, fixture, { lang: "en" });
  const socket = await liveSocket(page, fixture);
  await page.goto("/remote");
  await expect(page.getByRole("heading", { name: "Remote control", level: 1 })).toBeVisible();
  await expect(page.getByText("Remote off")).toBeVisible();
  await page.getByRole("link").filter({ hasText: "PAY-12" }).click();
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
  await expect(page.getByText("Watching live.")).toBeVisible();
  socket.out("hello\r\n");
  await expect(xterm(page)).toContainText("hello");
});

test.describe("360 px", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("danh sách: không cuộn ngang, dòng phiên cao ≥ 44 px, cả sáng và tối", async ({ page }) => {
    await setup(page, remoteFixture(), { theme: "dark" });
    await page.goto("/remote");
    await expect(page.locator("html")).toHaveClass(/dark/);
    const links = page.getByRole("region", { name: "Phiên" }).getByRole("link");
    await expect(links).toHaveCount(3);
    for (const link of await links.all()) {
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
    }
    await noHorizontalScroll(page, 360);
  });

  test("phát lại ở 360 px, tối: terminal nằm trong khung, trang không cuộn ngang", async ({ page }) => {
    await setup(page, remoteFixture({ chunks: ["xin chào\r\n"] }), { theme: "dark" });
    await page.goto(`/remote/${REMOTE_SESSION_ENDED}`);
    await expect(xterm(page)).toContainText("xin chào");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await noHorizontalScroll(page, 360);
    const box = await page.locator(".xterm").boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  });
});

test("bảng việc: mục Phiên tương tác liệt kê phiên gắn việc và dẫn tới trang phiên", async ({ page }) => {
  const fixture = remoteFixture();
  await setup(
    page,
    fixture,
    {},
    {
      "projects/list": () => ok([]),
      "tasks/list": () => ok([]),
      "runs/latest": () => ok([]),
    },
  );
  const socket = await liveSocket(page, fixture);
  await page.goto("/tasks");
  const section = page.getByRole("region", { name: "Phiên tương tác" });
  await expect(section.getByRole("link")).toHaveCount(1);
  await expect(section).toContainText("PAY-12");
  await section.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/remote/${REMOTE_SESSION_LIVE}$`));
  await expect.poll(() => socket.sockets.length).toBe(1);
  socket.out("từ bảng việc\r\n");
  await expect(xterm(page)).toContainText("từ bảng việc");
});
