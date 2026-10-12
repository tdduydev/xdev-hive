import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { HUB_PORT, OWNER } from "./env.ts";

// Chạy sau admin-flow.spec.ts: tổ chức acme-dev và đội Thanh toán (OWNER là quản trị) đã có.

const hub = `http://127.0.0.1:${HUB_PORT}`;

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  // Trang đăng nhập có hai ô Email (link đăng nhập và mật khẩu): chỉ làm trong khối mật khẩu.
  const form = page.locator("details", { hasText: "Đăng nhập bằng email và mật khẩu" });
  await form.locator("summary").click();
  await form.getByLabel("Email", { exact: true }).fill(OWNER.email);
  await form.getByLabel("Mật khẩu").fill(OWNER.password);
  await form.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

/** App desktop giả: cổng tạm trên 127.0.0.1 nhận callback của trình duyệt, như browser_login.rs. */
async function fakeApp() {
  const received: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/callback") received.push(url.searchParams);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("Đã kết nối app xDev Hive.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const query = new URLSearchParams({ port: String(port), state, challenge, machine: "e2e-macbook" });
  return { received, verifier, state, path: `/desktop/connect?${query}`, close: () => server.close() };
}

test("app desktop đăng nhập bằng trình duyệt: cho phép, đổi mã, đăng ký máy bằng mã nhận được", async ({
  page,
  request,
}) => {
  const app = await fakeApp();
  try {
    await signIn(page);
    await page.goto(app.path);
    await expect(page.getByRole("heading", { name: "Kết nối app xDev Hive trên máy này?" })).toBeVisible();
    await expect(page.getByText("e2e-macbook", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Đội")).toContainText("Thanh toán");
    await page.getByRole("button", { name: "Cho phép" }).click();
    await expect(page.getByText("Đã kết nối app xDev Hive.")).toBeVisible();

    expect(app.received).toHaveLength(1);
    const back = app.received[0] as URLSearchParams;
    expect(back.get("state")).toBe(app.state);
    const code = back.get("code") ?? "";
    expect(code.startsWith("hdc_")).toBe(true);

    // Mã một mình (không verifier) không đổi được gì.
    const wrong = await request.post(`${hub}/api/v1/desktop/connect/exchange`, {
      data: { code, verifier: randomBytes(32).toString("base64url") },
    });
    expect(wrong.status()).toBe(401);

    const res = await request.post(`${hub}/api/v1/desktop/connect/exchange`, {
      data: { code, verifier: app.verifier },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const out = (await res.json()) as { machine: string; registrationToken: string; personalToken: string };
    expect(out.machine).toBe("e2e-macbook");
    expect(out.personalToken.startsWith("hive_pat_")).toBe(true);

    const replay = await request.post(`${hub}/api/v1/desktop/connect/exchange`, {
      data: { code, verifier: app.verifier },
    });
    expect(replay.status()).toBe(401);

    const reg = await request.post(`${hub}/api/v1/worker/register`, {
      data: { registrationToken: out.registrationToken, machineId: out.machine, os: "darwin", version: "0.2.1" },
    });
    expect(reg.ok(), await reg.text()).toBe(true);
    expect(((await reg.json()) as { machineToken: string }).machineToken.startsWith("hwm_")).toBe(true);

    // Token cá nhân gọi được MCP thay người dùng (app lưu nó vào keychain).
    const whoami = await request.post(`${hub}/mcp`, {
      headers: { authorization: `Bearer ${out.personalToken}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hive_whoami", arguments: {} } },
    });
    expect(whoami.ok(), await whoami.text()).toBe(true);
    expect(await whoami.text()).toContain(OWNER.email);
  } finally {
    app.close();
  }
});

test("từ chối trên trình duyệt: app nhận error, không có mã", async ({ page }) => {
  const app = await fakeApp();
  try {
    await signIn(page);
    await page.goto(app.path);
    await page.getByRole("button", { name: "Từ chối" }).click();
    await expect(page.getByText("Đã kết nối app xDev Hive.")).toBeVisible();
    const back = app.received[0] as URLSearchParams;
    expect(back.get("error")).toBe("access_denied");
    expect(back.get("state")).toBe(app.state);
    expect(back.get("code")).toBeNull();
  } finally {
    app.close();
  }
});

test("liên kết thiếu tham số thì không cho phép", async ({ page }) => {
  await signIn(page);
  await page.goto("/desktop/connect?port=80&state=x");
  await expect(page.getByText("Liên kết đăng nhập không hợp lệ")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cho phép" })).toHaveCount(0);
});
