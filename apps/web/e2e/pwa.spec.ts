import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { preview } from "vite";
import { fakeHub } from "./fake-hub.ts";

/*
 * Service worker chỉ có ở bản build (vite dev không đăng ký, xem src/lib/pwa.ts), nên các ca dưới dựng bản build vào
 * thư mục tạm và phục vụ bằng `vite preview` ở cổng riêng, không đụng dev server của Playwright. Manifest và service
 * worker đều là file sinh lúc build, nên kiểm trên bản build mới đúng thứ người dùng nhận.
 */
const webRoot = fileURLToPath(new URL("..", import.meta.url));

let outDir = "";
let origin = "";
let stop: () => Promise<void> = async () => {};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  outDir = await mkdtemp(join(tmpdir(), "hive-web-pwa-"));
  await promisify(execFile)("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], { cwd: webRoot });
  const port = await freePort();
  // configFile: false vì preview chỉ cần phục vụ file tĩnh; proxy tới hub của vite.config không có nghĩa ở đây.
  const server = await preview({
    root: webRoot,
    configFile: false,
    build: { outDir },
    preview: { host: "localhost", port, strictPort: true },
  });
  origin = `http://localhost:${port}`;
  stop = () => server.close();
});

test.afterAll(async () => {
  await stop();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

/** Đọc cỡ ảnh từ khối IHDR của PNG (8 byte chữ ký, 4 byte độ dài, "IHDR", rộng, cao). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("manifest hợp lệ: tên, chế độ standalone, start_url và đủ icon có thật", async ({ page, request }) => {
  await page.goto(origin);
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.json");

  const response = await request.get(`${origin}${href}`);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: "xDev Hive",
    short_name: "Hive",
    display: "standalone",
    start_url: "/",
    scope: "/",
  });
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

  type Icon = { src: string; sizes: string; type: string; purpose?: string };
  const icons: Icon[] = manifest.icons;
  for (const size of ["192x192", "512x512"]) {
    expect(icons.some((icon) => icon.sizes === size && icon.purpose === "any")).toBe(true);
    expect(icons.some((icon) => icon.sizes === size && icon.purpose === "maskable")).toBe(true);
  }
  for (const icon of icons) {
    const file = await request.get(`${origin}${icon.src}`);
    expect(file.ok(), icon.src).toBe(true);
    expect(file.headers()["content-type"]).toBe("image/png");
    const [width] = icon.sizes.split("x").map(Number);
    expect(pngSize(await file.body())).toEqual({ width, height: width });
  }

  // iOS không đọc icon của manifest: cần apple-touch-icon và meta riêng.
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(touch).toBeTruthy();
  expect(pngSize(await (await request.get(`${origin}${touch}`)).body())).toEqual({ width: 180, height: 180 });
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", /^#[0-9a-f]{6}$/i);
});

test("service worker đăng ký, chỉ đệm vỏ ứng dụng, mất mạng vẫn mở được vỏ", async ({ page, context }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Lần mở đầu trang chưa do service worker quản; tải lại để có controller.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .toMatch(/\/sw\.js$/);

  // Dữ liệu người dùng đi mạng: gọi thử từng đường dẫn của hub rồi kiểm cache không có dấu vết.
  await page.evaluate(() =>
    Promise.all(
      ["/rpc/me/get", "/api/auth/get-session", "/mcp", "/ws", "/auth/x"].map((p) => fetch(p).catch(() => null)),
    ),
  );
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        urls.push(`${name} ${new URL(request.url).pathname}`);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(5);
  expect(cached.every((entry) => entry.startsWith("hive-shell-"))).toBe(true);
  expect(cached.some((entry) => entry.endsWith("/index.html"))).toBe(true);
  expect(cached.some((entry) => /\/assets\/index-[\w-]+\.js$/.test(entry))).toBe(true);
  expect(cached.filter((entry) => /\s\/(rpc|api|ws|mcp|auth)(\/|$)/.test(entry))).toEqual([]);

  // Mất mạng: điều hướng tới một đường dẫn của SPA vẫn ra vỏ ứng dụng (không phải trang lỗi của trình duyệt).
  await context.setOffline(true);
  await page.goto(`${origin}/leader/terminal/offline-check`);
  await expect(page).toHaveTitle("xDev Hive");
  await expect(page.locator("#root")).not.toBeEmpty();
  await context.setOffline(false);
});

test("dev server không đăng ký service worker, để sửa code không bị cache cũ làm khó", async ({ page, baseURL }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto(baseURL ?? "/");
  await expect(page.locator("#root")).not.toBeEmpty();
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((list) => list.length))).toBe(0);
});

test("nút cài: Chrome/Android bắt beforeinstallprompt rồi gọi hộp cài của trình duyệt", async ({ page, baseURL }) => {
  await fakeHub(page, { signedIn: true });
  await page.goto(baseURL ?? "/");
  await expect(page.getByRole("button", { name: "Cài lên màn hình chính" })).toHaveCount(0);
  await page.evaluate(() => {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: () => {
        (window as unknown as { installPrompted: number }).installPrompted =
          ((window as unknown as { installPrompted?: number }).installPrompted ?? 0) + 1;
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    window.dispatchEvent(event);
    (window as unknown as { installDefaultPrevented: boolean }).installDefaultPrevented = event.defaultPrevented;
  });
  // Giữ sự kiện lại để cài khi người dùng bấm, không để thanh mặc định của trình duyệt tự bật.
  expect(
    await page.evaluate(() => (window as unknown as { installDefaultPrevented: boolean }).installDefaultPrevented),
  ).toBe(true);
  const install = page.getByRole("button", { name: "Cài lên màn hình chính" });
  await expect(install).toBeVisible();
  await install.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { installPrompted?: number }).installPrompted))
    .toBe(1);
  // Mỗi sự kiện chỉ dùng được một lần: sau khi gọi, nút biến mất.
  await expect(install).toHaveCount(0);
});

test.describe("iOS Safari", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    viewport: { width: 1280, height: 800 },
  });

  test("không có sự kiện cài nên hiện hướng dẫn Chia sẻ → Thêm vào MH chính", async ({ page, baseURL }) => {
    await fakeHub(page, { signedIn: true });
    await page.goto(baseURL ?? "/");
    await page.getByRole("button", { name: "Cài lên màn hình chính" }).click();
    const dialog = page.getByRole("dialog", { name: /Cài xDev Hive trên iPhone/ });
    await expect(dialog).toContainText("Chia sẻ");
    await expect(dialog).toContainText("Thêm vào MH chính");
    await dialog.getByRole("button", { name: "Đã hiểu" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
