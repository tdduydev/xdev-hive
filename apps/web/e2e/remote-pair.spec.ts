import { expect, type Page, test } from "@playwright/test";
import { remoteErrors } from "@xdev-hive/contracts";
import { fromBase64url, pairTag } from "@xdev-hive/contracts/terminal-auth";
import {
  fail,
  fakeHub,
  remoteFixture,
  TERMINAL_MACHINE,
  TERMINAL_OFFLINE_MACHINE,
  TERMINAL_ORG,
  USER,
} from "./fake-hub.ts";

type Fixture = ReturnType<typeof remoteFixture>;

// Bí mật 16 byte như worker sinh; chỉ nằm trong fragment, không bao giờ được gửi lên hub.
const SECRET = "Vu2J3v9B7TLPSno9WLp67A";
const PAIR_ID = "pair-0a1b2c3d";
const pairUrl = (machine = "sdlc-box-01") => `/remote/pair?m=${encodeURIComponent(machine)}&p=${PAIR_ID}#s=${SECRET}`;

async function setup(
  page: Page,
  fixture: Fixture,
  init: { lang?: "en"; theme?: "dark" | undefined; insecure?: boolean; signedIn?: boolean } = {},
) {
  await page.addInitScript(
    ({ org, lang, theme, insecure }) => {
      localStorage.setItem("hive.org", org);
      if (lang) localStorage.setItem("hive.lang", lang);
      if (theme) localStorage.setItem("hive.theme", theme);
      // Playwright chạy ở localhost (luôn là secure context); giả trang HTTP bằng cách tắt cờ trước khi app đọc.
      if (insecure) Object.defineProperty(window, "isSecureContext", { get: () => false });
    },
    { org: TERMINAL_ORG.id, lang: init.lang, theme: init.theme, insecure: init.insecure },
  );
  return fakeHub(page, { signedIn: init.signedIn ?? true, rpc: fixture.rpc });
}

/** Authenticator ảo của Chrome có UV, như Face ID / vân tay trên điện thoại. */
async function virtualAuthenticator(page: Page) {
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
  return { cdp, authenticatorId };
}

const noHorizontalScroll = async (page: Page, width: number) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
};

test("ghép thành công: tạo passkey có UV, gửi tag đúng, bí mật rời khỏi URL và không tới hub", async ({ page }) => {
  const fixture = remoteFixture();
  const hub = await setup(page, fixture);
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  await page.goto(pairUrl());

  await expect(page.getByRole("heading", { name: "Ghép điện thoại với máy", level: 1 })).toBeVisible();
  await expect(page.getByText("sdlc-box-01", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  expect(page.url()).not.toContain(SECRET);

  await page.getByLabel("Tên thiết bị").fill("Điện thoại của Duy");
  await page.getByRole("button", { name: "Tạo passkey và ghép" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Đã ghép “Điện thoại của Duy” với máy sdlc-box-01." }),
  ).toBeVisible();

  expect(fixture.state.pairOptionsCalls).toEqual([{ machineId: TERMINAL_MACHINE, pairId: PAIR_ID }]);
  const [call] = fixture.state.pairCalls as {
    machineId: string;
    pairId: string;
    label: string;
    credentialId: string;
    spki: string;
    tag: string;
    synced: boolean;
  }[];
  expect(call).toMatchObject({ machineId: TERMINAL_MACHINE, pairId: PAIR_ID, label: "Điện thoại của Duy" });
  expect(call?.tag).toHaveLength(43);
  // Hub (và worker) kiểm tag bằng chính SPKI và credential gửi lên: tag tính lại ở đây phải khớp.
  const expected = await pairTag(fromBase64url(SECRET), {
    pairId: PAIR_ID,
    userId: USER.id,
    credentialId: call?.credentialId ?? "",
    spki: call?.spki ?? "",
  });
  expect(call?.tag).toBe(expected);

  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(Buffer.from(credentials[0]?.credentialId ?? "", "base64").toString("base64url")).toBe(call?.credentialId);
  expect(credentials[0]?.rpId).toBe("localhost");

  expect(JSON.stringify(hub.rpcCalls)).not.toContain(SECRET);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(SECRET);

  await page.getByRole("link", { name: "Xem thiết bị đã ghép" }).click();
  const section = page.getByRole("region", { name: "sdlc-box-01" });
  const row = section.getByRole("listitem").filter({ hasText: "Điện thoại của Duy" });
  await expect(row.getByText("Thiết bị này")).toBeVisible();
});

test("mã ghép hết hạn: hiện câu của hub và cho thử lại", async ({ page }) => {
  await setup(
    page,
    remoteFixture({
      pairError: fail("BAD_REQUEST", 400, remoteErrors.PAIR_EXPIRED, { code: "PAIR_EXPIRED" }),
    }),
  );
  await virtualAuthenticator(page);
  await page.goto(pairUrl());
  await page.getByRole("button", { name: "Tạo passkey và ghép" }).click();
  await expect(page.getByRole("alert")).toContainText(remoteErrors.PAIR_EXPIRED);
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeEnabled();
});

test("máy của người khác: không có trong máy của tôi thì báo MACHINE_NOT_YOURS, không gọi ghép", async ({ page }) => {
  const fixture = remoteFixture();
  await setup(page, fixture);
  await page.goto(pairUrl("may-cua-nguoi-khac"));
  await expect(page.getByRole("alert")).toContainText(remoteErrors.MACHINE_NOT_YOURS);
  await expect(page.getByText("Đang đăng nhập: duy@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tạo passkey và ghép" })).toHaveCount(0);
  expect(fixture.state.pairOptionsCalls).toHaveLength(0);
});

test("hub từ chối vì máy của người khác: hiện câu của hub", async ({ page }) => {
  await setup(
    page,
    remoteFixture({
      pairError: fail("FORBIDDEN", 403, remoteErrors.MACHINE_NOT_YOURS, { code: "MACHINE_NOT_YOURS" }),
    }),
  );
  await virtualAuthenticator(page);
  await page.goto(pairUrl());
  await page.getByRole("button", { name: "Tạo passkey và ghép" }).click();
  await expect(page.getByRole("alert")).toContainText(remoteErrors.MACHINE_NOT_YOURS);
});

test("hub chạy HTTP: báo cần HTTPS, không có nút ghép; trang Điều khiển từ xa cảnh báo HTTP", async ({ page }) => {
  await setup(page, remoteFixture(), { insecure: true });
  await page.goto(pairUrl());
  await expect(page.getByText("Cần hub chạy HTTPS")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tạo passkey và ghép" })).toHaveCount(0);
  // Dù không ghép được, bí mật vẫn phải rời khỏi thanh địa chỉ.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

  await page.goto("/remote");
  await expect(page.getByText("Hub chạy HTTP: nội dung phiên và phím gõ không được mã hoá")).toBeVisible();
});

test("link thiếu bí mật: nói quét lại mã QR", async ({ page }) => {
  await setup(page, remoteFixture());
  await page.goto(`/remote/pair?m=sdlc-box-01&p=${PAIR_ID}`);
  await expect(page.getByRole("heading", { name: "Link ghép không đủ" })).toBeVisible();
  await expect(page.getByText("Quét lại mã QR trên máy")).toBeVisible();
});

test("chưa đăng nhập: chuyển tới đăng nhập mà link quay lại không mang bí mật", async ({ page }) => {
  await setup(page, remoteFixture(), { signedIn: false });
  await page.goto(pairUrl());
  await expect(page).toHaveURL(/\/login\?redirect=/);
  expect(decodeURIComponent(page.url())).toContain(`/remote/pair?m=sdlc-box-01&p=${PAIR_ID}`);
  expect(decodeURIComponent(page.url())).not.toContain(SECRET);
  // Bí mật cất trong tab để trang ghép dùng sau khi đăng nhập xong.
  expect(await page.evaluate((id) => sessionStorage.getItem(`hive.pair.${id}`), PAIR_ID)).toBe(SECRET);
});

test("thiết bị đã ghép: danh sách theo máy, gỡ có xác nhận, máy offline không gỡ được", async ({ page }) => {
  const fixture = remoteFixture();
  await setup(page, fixture);
  await page.goto("/remote");
  await page.getByRole("link", { name: "Thiết bị: sdlc-box-01" }).click();
  await expect(page.getByRole("heading", { name: "Thiết bị đã ghép", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`machine=${TERMINAL_MACHINE}`));

  const section = page.getByRole("region", { name: "sdlc-box-01" });
  await expect(section.getByText("iPad của Duy")).toBeVisible();
  await expect(section.getByText("Passkey đồng bộ")).toBeVisible();
  await expect(page.getByRole("region", { name: "máy-offline" })).toHaveCount(0);

  await section.getByRole("button", { name: "Gỡ thiết bị: iPad của Duy" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Gỡ “iPad của Duy”?" })).toBeVisible();
  await expect(dialog.getByText("gỡ là gỡ trên mọi thiết bị dùng chung tài khoản đó")).toBeVisible();
  await dialog.getByRole("button", { name: "Giữ lại" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.state.revokeCalls).toHaveLength(0);

  await section.getByRole("button", { name: "Gỡ thiết bị: iPad của Duy" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Gỡ thiết bị", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(section.getByText("Chưa ghép thiết bị nào với máy này.")).toBeVisible();
  expect(fixture.state.revokeCalls).toEqual([{ machineId: TERMINAL_MACHINE, deviceId: "dev-ipad-01" }]);

  await page.getByRole("link", { name: "Xem mọi máy" }).click();
  const offline = page.getByRole("region", { name: "máy-offline" });
  await expect(offline.getByText("Pixel 9")).toBeVisible();
  await expect(offline.getByRole("button", { name: "Gỡ thiết bị: Pixel 9" })).toBeDisabled();
});

test("gỡ lỗi: hộp thoại giữ nguyên và hiện câu của hub", async ({ page }) => {
  await setup(
    page,
    remoteFixture({
      revokeError: fail("CONFLICT", 409, remoteErrors.MACHINE_OFFLINE, { code: "MACHINE_OFFLINE" }),
    }),
  );
  await page.goto(`/remote/devices?machine=${TERMINAL_MACHINE}`);
  await page.getByRole("button", { name: "Gỡ thiết bị: iPad của Duy" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Gỡ thiết bị", exact: true }).click();
  await expect(dialog.getByText(remoteErrors.MACHINE_OFFLINE)).toBeVisible();
});

test("tiếng Anh: trang ghép và trang thiết bị đổi chữ", async ({ page }) => {
  await setup(page, remoteFixture(), { lang: "en" });
  await page.goto(pairUrl());
  await expect(page.getByRole("heading", { name: "Pair this phone with a machine", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create passkey and pair" })).toBeVisible();
  await page.goto(`/remote/devices?machine=${TERMINAL_OFFLINE_MACHINE}`);
  await expect(page.getByRole("heading", { name: "Paired devices", level: 1 })).toBeVisible();
  await expect(page.getByText("never used", { exact: false })).toBeVisible();
});

test.describe("360 px", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const theme of [undefined, "dark"] as const) {
    test(`ghép và thiết bị ${theme ?? "sáng"}: không cuộn ngang, nút cao ≥ 44 px`, async ({ page }) => {
      await setup(page, remoteFixture(), { theme });
      await page.goto(pairUrl());
      if (theme) await expect(page.locator("html")).toHaveClass(/dark/);
      const submit = page.getByRole("button", { name: "Tạo passkey và ghép" });
      await expect(submit).toBeVisible();
      expect((await submit.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await page.getByLabel("Tên thiết bị").boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await noHorizontalScroll(page, 360);

      await page.goto("/remote/devices");
      const revoke = page.getByRole("button", { name: "Gỡ thiết bị: iPad của Duy" });
      await expect(revoke).toBeVisible();
      for (const button of [revoke, page.getByRole("link", { name: "Ghép thiết bị mới" })]) {
        const box = await button.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
      }
      await noHorizontalScroll(page, 360);
    });
  }
});
