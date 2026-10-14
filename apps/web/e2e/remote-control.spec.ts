import { generateKeyPairSync } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  fakeHub,
  fakeRemoteSocket,
  REMOTE_SESSION_LIVE,
  remoteFixture,
  TERMINAL_MACHINE,
  TERMINAL_ORG,
} from "./fake-hub.ts";

type Fixture = ReturnType<typeof remoteFixture>;

const DEVICE_ID = "dev-phone-01";
const CREDENTIAL_ID = Buffer.from("cred-remote-phone-01");

/**
 * Điện thoại đã ghép: passkey nằm sẵn trong authenticator ảo (có UV như Face ID) và trình duyệt nhớ thiết bị của máy
 * (`hive.remote.devices`). Khoá công khai đưa cho worker giả để kiểm chữ ký thật.
 */
async function setup(page: Page, fixture: Fixture, init: { paired?: boolean; lang?: "en" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await page.addInitScript(
    ({ org, machineId, device, lang }) => {
      localStorage.setItem("hive.org", org);
      if (lang) localStorage.setItem("hive.lang", lang);
      if (device) localStorage.setItem("hive.remote.devices", JSON.stringify({ [machineId]: device }));
    },
    {
      org: TERMINAL_ORG.id,
      machineId: TERMINAL_MACHINE,
      lang: init.lang,
      device: init.paired === false ? null : { deviceId: DEVICE_ID, credentialId: CREDENTIAL_ID.toString("base64url") },
    },
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: CREDENTIAL_ID.toString("base64"),
      isResidentCredential: false,
      rpId: "localhost",
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      signCount: 0,
    },
  });
  await fakeHub(page, { signedIn: true, rpc: fixture.rpc });
  const socket = await fakeRemoteSocket(page, fixture, {
    sessionId: REMOTE_SESSION_LIVE,
    deviceId: DEVICE_ID,
    passkey: publicKey,
  });
  /** Số lần trình duyệt hỏi passkey: mỗi lần là một chữ ký, signCount tăng. */
  const assertions = async () => {
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    return credentials[0]?.signCount ?? 0;
  };
  return { socket, assertions };
}

const bar = (page: Page) => page.getByRole("toolbar", { name: "Thanh phím terminal" });
const xterm = (page: Page) => page.locator(".xterm-rows");
const typed = (socket: Awaited<ReturnType<typeof setup>>["socket"]) => socket.state.inputs.join("");

async function takeControl(page: Page) {
  await expect(page.getByText("Đang xem trực tiếp.")).toBeVisible();
  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();
  await expect(page.getByText("Bạn đang điều khiển phiên này.")).toBeVisible();
}

test.use({ viewport: { width: 360, height: 740 } });

test("360 px: xem trực tiếp, điều khiển bằng passkey, Ctrl-C và ô soạn có dấu tới máy đúng byte, đủ 40 cột", async ({
  page,
}) => {
  const fixture = remoteFixture();
  const { socket, assertions } = await setup(page, fixture);
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  socket.out("claude> sẵn sàng\r\n");
  await expect(xterm(page)).toContainText("claude> sẵn sàng");
  // Người xem: không có thanh phím, không gửi gì ngoài `resume`.
  await expect(bar(page)).toHaveCount(0);
  expect(socket.sockets[0]?.received.map((f) => f.t)).toEqual(["resume"]);

  await takeControl(page);
  expect(await assertions()).toBe(1);
  expect(socket.state.controls).toBe(1);
  // Cỡ PTY theo màn điện thoại, gói `resize` ký đúng: tối thiểu 40 cột ở 360 px.
  await expect.poll(() => socket.state.resizes.at(-1)?.cols ?? 0).toBeGreaterThanOrEqual(40);

  await bar(page).getByRole("button", { name: "Ctrl-C", exact: true }).click();
  await expect.poll(() => typed(socket)).toBe("\x03");
  const line = page.getByRole("textbox", { name: "Soạn dòng" });
  await line.fill("sửa lỗi đăng nhập");
  await page.getByRole("button", { name: "Gửi dòng" }).click();
  await expect.poll(() => typed(socket)).toBe("\x03sửa lỗi đăng nhập\r");
  await expect(xterm(page)).toContainText("sửa lỗi đăng nhập");

  // Gõ thẳng trên bàn phím của xterm cũng đi qua cùng đường ký.
  await page.locator(".xterm").click();
  await page.keyboard.type("y");
  await expect.poll(() => typed(socket)).toBe("\x03sửa lỗi đăng nhập\ry");
  expect(socket.state.rejected).toEqual([]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(360);

  await page.getByRole("button", { name: "Trả quyền" }).click();
  await expect(page.getByRole("button", { name: "Điều khiển", exact: true })).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(() => socket.sockets[0]?.received.some((f) => f.t === "release")).toBe(true);
});

test("mất mạng 10 giây rồi nối lại: không hỏi passkey, gõ tiếp được, không lặp output", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = remoteFixture();
  const { socket, assertions } = await setup(page, fixture);
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  await takeControl(page);
  await bar(page).getByRole("button", { name: "Ctrl-C", exact: true }).click();
  await expect.poll(() => typed(socket)).toBe("\x03");
  socket.out("trước khi mất mạng\r\n");
  await expect(xterm(page)).toContainText("trước khi mất mạng");

  fixture.state.offline = true;
  socket.drop();
  await expect(page.getByRole("status").filter({ hasText: "Mất kết nối, đang nối lại…" })).toBeVisible();
  await page.waitForTimeout(10_000);
  fixture.state.offline = false;

  await expect.poll(() => socket.sockets.length, { timeout: 20_000 }).toBe(2);
  await expect(page.getByText("Bạn đang điều khiển phiên này.")).toBeVisible();
  const resume = socket.state.resumes.at(-1);
  expect(resume).toMatchObject({ t: "resume", resumeToken: expect.any(String), deviceId: DEVICE_ID });
  expect(Number(resume?.after)).toBeGreaterThanOrEqual(0);
  expect(await assertions()).toBe(1);
  expect(socket.state.controls).toBe(1);

  const line = page.getByRole("textbox", { name: "Soạn dòng" });
  await line.fill("tiếp tục");
  await page.getByRole("button", { name: "Gửi dòng" }).click();
  await expect.poll(() => typed(socket)).toBe("\x03tiếp tục\r");
  expect(socket.state.rejected).toEqual([]);
  // `resume.after` đúng nên output cũ không được phát lại lần nữa.
  expect((await xterm(page).innerText()).split("trước khi mất mạng")).toHaveLength(2);
});

test("bị giành quyền: báo rõ, về chỉ xem, phím không còn gửi, xin lại phải xác thực lại", async ({ page }) => {
  const fixture = remoteFixture();
  const { socket, assertions } = await setup(page, fixture);
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  await takeControl(page);

  socket.takeOver();
  await expect(page.getByText("Quyền gõ đã chuyển sang nơi khác")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await page.locator(".xterm").click();
  await page.keyboard.type("x");
  await page.waitForTimeout(200);
  expect(typed(socket)).toBe("");
  expect(socket.sockets[0]?.received.filter((f) => f.t === "in")).toEqual([]);

  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();
  await expect(page.getByText("Bạn đang điều khiển phiên này.")).toBeVisible();
  expect(await assertions()).toBe(2);
});

test("thiết bị chưa ghép: không hỏi passkey, chỉ đường tới trang ghép", async ({ page }) => {
  const fixture = remoteFixture();
  const { socket, assertions } = await setup(page, fixture, { paired: false });
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();
  await expect(page.getByText("Thiết bị này chưa ghép với máy")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ghép thiết bị" })).toBeVisible();
  expect(await assertions()).toBe(0);
  expect(socket.state.controls).toBe(0);
});

test("tiếng Anh: nút và trạng thái điều khiển có nhãn tiếng Anh", async ({ page }) => {
  const fixture = remoteFixture();
  const { socket } = await setup(page, fixture, { lang: "en" });
  await page.goto(`/remote/${REMOTE_SESSION_LIVE}`);
  await expect.poll(() => socket.sockets.length).toBe(1);
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByText("You are controlling this session.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Give back" })).toBeVisible();
});
