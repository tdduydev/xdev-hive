import { createHash, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { challengeBytes, fromBase64url, type StartParams, toBase64url } from "@xdev-hive/contracts/terminal-auth";
import {
  fail,
  fakeHub,
  fakeRemoteSocket,
  ok,
  REMOTE_SESSION_STARTED,
  REMOTE_TASK,
  remoteFixture,
  TERMINAL_MACHINE,
  TERMINAL_ORG,
  USER,
} from "./fake-hub.ts";

// Mở phiên mới từ điện thoại (specs/010 US4, T052): form → passkey ký đúng các trường → `remote.start` → vào phiên và tự
// xin quyền gõ. Hub giả kiểm chữ ký như worker để bắt lệch byte giữa phần ký và phần gửi.

type Fixture = ReturnType<typeof remoteFixture>;

const DEVICE_ID = "dev-phone-01";
const CREDENTIAL_ID = Buffer.from("cred-remote-phone-01");

async function setup(page: Page, fixture: Fixture, init: { paired?: boolean } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await page.addInitScript(
    ({ org, machineId, device }) => {
      localStorage.setItem("hive.org", org);
      if (device) localStorage.setItem("hive.remote.devices", JSON.stringify({ [machineId]: device }));
    },
    {
      org: TERMINAL_ORG.id,
      machineId: TERMINAL_MACHINE,
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
    sessionId: REMOTE_SESSION_STARTED,
    deviceId: DEVICE_ID,
    passkey: publicKey,
  });
  const assertions = async () => {
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    return credentials[0]?.signCount ?? 0;
  };
  return { socket, assertions, publicKey };
}

/** Kiểm như worker: challenge dựng lại từ đúng các trường hub chuyển trong `term_start` (cộng userId của phiên đăng nhập). */
async function verifyStart(call: Record<string, unknown>, passkey: KeyObject): Promise<boolean> {
  const { machineId, auth, ...fields } = call as {
    machineId: string;
    auth: {
      ephPub: string;
      ts: number;
      nonce: string;
      assertion: { authenticatorData: string; clientDataJSON: string; signature: string };
    };
  } & Omit<StartParams, "userId">;
  const challenge = await challengeBytes({
    machineId,
    action: "start",
    params: { userId: USER.id, ...fields },
    ephPub: auth.ephPub,
    ts: auth.ts,
    nonce: auth.nonce,
  });
  const clientData = JSON.parse(Buffer.from(fromBase64url(auth.assertion.clientDataJSON)).toString("utf8")) as {
    challenge: string;
  };
  const signed = Buffer.concat([
    fromBase64url(auth.assertion.authenticatorData),
    createHash("sha256").update(fromBase64url(auth.assertion.clientDataJSON)).digest(),
  ]);
  return (
    clientData.challenge === toBase64url(challenge) &&
    verify("sha256", signed, passkey, fromBase64url(auth.assertion.signature))
  );
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Mở phiên mới" });

test.use({ viewport: { width: 360, height: 740 } });

test("360 px: mở phiên bằng passkey với thư mục con, task, lời nhắc có dấu, vào phiên và điều khiển ngay", async ({
  page,
}) => {
  const fixture = remoteFixture();
  const { socket, assertions, publicKey } = await setup(page, fixture);
  await page.goto("/remote");
  await page.getByRole("button", { name: "Mở phiên mới" }).click();
  const form = sheet(page);
  await expect(form.getByLabel("Máy")).toHaveValue(TERMINAL_MACHINE);
  await expect(form.getByText("Máy này hỏi chủ máy bấm Cho phép tại máy")).toBeVisible();
  await form.getByLabel("Thư mục con (không bắt buộc)").fill("apps/hub");
  await form.getByLabel("Task").selectOption(REMOTE_TASK.id);
  await form.getByLabel("Lời nhắc đầu tiên (không bắt buộc)").fill("sửa lỗi đăng nhập");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await form.getByRole("button", { name: "Xác thực và mở" }).click();

  await expect(page).toHaveURL(new RegExp(`/remote/${REMOTE_SESSION_STARTED}$`));
  const call = fixture.state.startCalls[0] ?? {};
  expect(call).toMatchObject({
    machineId: TERMINAL_MACHINE,
    deviceId: DEVICE_ID,
    cli: "claude",
    rootId: "r1",
    subdir: "apps/hub",
    projectId: REMOTE_TASK.projectId,
    taskId: REMOTE_TASK.id,
    prompt: "sửa lỗi đăng nhập",
    auth: { kind: "passkey" },
  });
  expect(call).not.toHaveProperty("accountId");
  expect(call).not.toHaveProperty("userId");
  expect(Number(call.cols)).toBeGreaterThanOrEqual(40);
  expect(await verifyStart(call, publicKey)).toBe(true);

  // Trang phiên tự xin quyền gõ (passkey lần hai) rồi bỏ cờ khỏi URL.
  await expect(page.getByText("Bạn đang điều khiển phiên này.")).toBeVisible();
  expect(socket.state.controls).toBe(1);
  expect(await assertions()).toBe(2);
  expect(page.url()).not.toContain("control");
});

test("thiết bị chưa ghép: chỉ đường tới ghép, không hỏi passkey, nút mở bị tắt", async ({ page }) => {
  const fixture = remoteFixture();
  const { assertions } = await setup(page, fixture, { paired: false });
  await page.goto("/remote");
  await page.getByRole("button", { name: "Mở phiên mới" }).click();
  const form = sheet(page);
  await expect(form.getByText("Thiết bị này chưa ghép với máy nên chưa mở phiên được.")).toBeVisible();
  await expect(form.getByRole("link", { name: "Ghép thiết bị" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Xác thực và mở" })).toBeDisabled();
  expect(await assertions()).toBe(0);
  expect(fixture.state.startCalls).toEqual([]);
});

test("máy chưa cho thư mục nào: báo thêm tại máy, nút mở bị tắt", async ({ page }) => {
  const fixture = remoteFixture();
  const machines = fixture.rpc["remote/machines"];
  fixture.rpc["remote/machines"] = () => {
    const reply = machines();
    const list = (reply.json as { json: { remote: { roots: unknown[] } | null }[] }).json;
    for (const m of list) if (m.remote) m.remote.roots = [];
    return ok(list);
  };
  await setup(page, fixture);
  await page.goto("/remote");
  await page.getByRole("button", { name: "Mở phiên mới" }).click();
  const form = sheet(page);
  await expect(form.getByText("Máy chưa cho phép thư mục nào.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Xác thực và mở" })).toBeDisabled();
});

test("máy từ chối: câu lỗi của hub hiện trong tấm, vẫn ở lại để sửa", async ({ page }) => {
  const fixture = remoteFixture({
    startError: fail("ROOT_ESCAPE", 400, "Đường dẫn đi ra ngoài thư mục được phép."),
  });
  await setup(page, fixture);
  await page.goto("/remote");
  await page.getByRole("button", { name: "Mở phiên mới" }).click();
  const form = sheet(page);
  await form.getByLabel("Thư mục con (không bắt buộc)").fill("../etc");
  await form.getByRole("button", { name: "Xác thực và mở" }).click();
  await expect(form.getByRole("alert")).toHaveText("Đường dẫn đi ra ngoài thư mục được phép.");
  await expect(page).toHaveURL(/\/remote$/);
  await expect(form.getByRole("button", { name: "Xác thực và mở" })).toBeEnabled();
});
