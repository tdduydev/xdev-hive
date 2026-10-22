import { generateKeyPairSync } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  fakeHub,
  fakeRemoteSocket,
  LOCK_CODE,
  REMOTE_SESSION_LIVE,
  REMOTE_SESSION_STARTED,
  remoteFixture,
  TERMINAL_ORG,
} from "./fake-hub.ts";

// Hub chạy HTTP (specs/010 D15, T028): trình duyệt không có WebAuthn nên mở phiên và xin quyền gõ bằng mã Authenticator.
// Không có authenticator ảo; worker giả kiểm mã, trộn mã vào HKDF và kiểm HMAC từng phím như worker thật.

type Fixture = ReturnType<typeof remoteFixture>;

const WARNING = "Hub chạy HTTP: nội dung phiên và phím gõ đi qua mạng không mã hoá";

async function setup(page: Page, fixture: Fixture, sessionId: string) {
  await page.clock.install();
  await page.addInitScript((org) => {
    localStorage.setItem("hive.org", org);
    Object.defineProperty(window, "isSecureContext", { get: () => false });
  }, TERMINAL_ORG.id);
  await fakeHub(page, { signedIn: true, rpc: fixture.rpc });
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return fakeRemoteSocket(page, fixture, { sessionId, deviceId: "dev-unused", passkey: publicKey });
}

const codeSheet = (page: Page) => page.getByRole("dialog", { name: "Nhập mã Authenticator" });
const typed = (socket: Awaited<ReturnType<typeof setup>>) => socket.state.inputs.join("");

async function submitCode(page: Page, code: string) {
  const sheet = codeSheet(page);
  await sheet.getByLabel("Mã Authenticator").fill(code);
  await sheet.getByRole("button", { name: "Xác nhận" }).click();
}

test.use({ viewport: { width: 360, height: 740 } });

test("mở phiên bằng mã, chờ mã mới rồi xin quyền gõ bằng mã thứ hai; cảnh báo HTTP luôn hiện", async ({ page }) => {
  const fixture = remoteFixture({ totp: { codes: ["123456", "654321"] } });
  const socket = await setup(page, fixture, REMOTE_SESSION_STARTED);
  await page.goto("/remote");
  await expect(page.getByText(WARNING)).toBeVisible();
  await page.getByRole("button", { name: "Mở phiên mới" }).click();
  const form = page.getByRole("dialog", { name: "Mở phiên mới" });
  const submit = form.getByRole("button", { name: "Xác thực và mở" });
  await expect(submit).toBeDisabled();
  await form.getByLabel("Mã Authenticator").fill("12a34");
  await expect(form.getByLabel("Mã Authenticator")).toHaveValue("1234");
  await form.getByLabel("Mã Authenticator").fill("123456");
  await submit.click();

  await expect(page).toHaveURL(new RegExp(`/remote/${REMOTE_SESSION_STARTED}`));
  expect(fixture.state.startCalls[0]).toMatchObject({ auth: { kind: "totp", code: "123456" } });
  expect(fixture.state.startCalls[0]).not.toHaveProperty("deviceId");
  await expect(page.getByText(WARNING)).toBeVisible();

  // Trang phiên tự hỏi mã để xin quyền gõ; mã vừa dùng chưa đổi nên phải chờ.
  const sheet = codeSheet(page);
  await expect(sheet.getByText(/Mã vừa được dùng\. Chờ mã mới/)).toBeVisible();
  await sheet.getByLabel("Mã Authenticator").fill("654321");
  await expect(sheet.getByRole("button", { name: "Xác nhận" })).toBeDisabled();
  await page.clock.fastForward(30_000);
  await expect(sheet.getByText(/Mã vừa được dùng/)).toHaveCount(0);
  await sheet.getByRole("button", { name: "Xác nhận" }).click();

  await expect(page.getByText("Bạn đang điều khiển phiên này.")).toBeVisible();
  await expect(sheet).toHaveCount(0);
  const control = socket.sockets.at(-1)?.received.find((f) => f.t === "control");
  expect(control).toMatchObject({ auth: { kind: "totp", code: "654321" } });
  expect(control).not.toHaveProperty("deviceId");
  // Khoá HMAC trộn mã: worker giả nhận phím có chữ ký đúng.
  await page.locator(".xterm").click();
  await page.keyboard.type("y");
  await expect.poll(() => typed(socket)).toContain("y");
  expect(socket.state.rejected).toEqual([]);
});

test("mã sai, mã dùng lại, khoá: báo đúng lý do trong hộp nhập mã", async ({ page }) => {
  const fixture = remoteFixture({ totp: { codes: ["123456"] } });
  const socket = await setup(page, fixture, REMOTE_SESSION_LIVE);
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect(page.getByText(WARNING)).toBeVisible();
  await expect.poll(() => socket.sockets.length).toBe(1);
  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();

  await submitCode(page, "000001");
  await expect(codeSheet(page).getByRole("alert")).toHaveText("Mã Authenticator không đúng.");

  await submitCode(page, "123456");
  await expect(page.getByText("Bạn đang điều khiển phiên này.")).toBeVisible();
  await page.getByRole("button", { name: "Trả quyền" }).click();

  // Mã cũ ở bước sau: trình duyệt không chặn nữa nhưng máy nhớ đã dùng.
  await page.clock.fastForward(30_000);
  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();
  await submitCode(page, "123456");
  await expect(codeSheet(page).getByRole("alert")).toHaveText("Mã này vừa được dùng. Chờ mã mới rồi thử lại.");
  await expect(codeSheet(page).getByText(/Chờ mã mới \(\d+ giây\)/)).toBeVisible();

  await page.clock.fastForward(30_000);
  await submitCode(page, LOCK_CODE);
  await expect(codeSheet(page).getByRole("alert")).toContainText("máy tạm khoá mã Authenticator");
  await expect(codeSheet(page).getByRole("alert")).toContainText("Còn khoảng 5 phút nữa mới nhập lại được.");
});

test("tổ chức tắt mã Authenticator: không hỏi mã, nói cần HTTPS", async ({ page }) => {
  const fixture = remoteFixture({ totp: { codes: ["123456"], allowed: false } });
  const socket = await setup(page, fixture, REMOTE_SESSION_LIVE);
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();
  await expect(page.getByText("tổ chức không cho dùng mã Authenticator")).toBeVisible();
  await expect(codeSheet(page)).toHaveCount(0);
  expect(socket.state.controls).toBe(0);

  await page.goto("/remote");
  await page.getByRole("button", { name: "Mở phiên mới" }).click();
  const form = page.getByRole("dialog", { name: "Mở phiên mới" });
  await expect(form.getByText("tổ chức không cho dùng mã Authenticator")).toBeVisible();
  await expect(form.getByLabel("Mã Authenticator")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Xác thực và mở" })).toBeDisabled();
});
