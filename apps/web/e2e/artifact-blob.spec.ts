import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { buildCsp, buildFrameDocument } from "@xdev-hive/artifacts-runtime";
import { LIB_DIST_DIR, readLibManifest } from "@xdev-hive/artifacts-runtime/node";

/*
 * Ảnh và PDF (T062) trong trình duyệt thật: khung là origin mờ (`sandbox="allow-scripts"`), nên `<img>` và `fetch` của nó
 * là yêu cầu chéo origin tới route tệp. Test dựng đúng tài liệu và header mà hub trả (buildFrameDocument + buildCsp) trên
 * một origin giả, để thấy pdf.js chạy được dưới CSP đó. Route thật của hub kiểm ở upload.db.test.ts.
 */
const ORIGIN = "http://hub.test";
const LIB_BASE = `${ORIGIN}/_artifact/lib/`;
const BLOB_BASE = `${ORIGIN}/_artifact/blob/`;
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

// PNG 1×1 hợp lệ.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** PDF hai trang, bảng xref đúng độ lệch để pdf.js không phải dựng lại. */
function pdfWithPages(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`,
    );
    const stream = `BT /F1 24 Tf 20 100 Td (Trang ${i + 1}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function serve(page: Page, type: "image" | "pdf", file: { body: Buffer; mediaType: string }) {
  const manifest = readLibManifest();
  if (!manifest) throw new Error("Chưa dựng bộ thư viện khung (pnpm --filter @xdev-hive/artifacts-runtime build:lib).");
  const frameRequests: string[] = [];
  page.on("requestfinished", (request) => {
    if (request.frame() !== page.mainFrame()) frameRequests.push(new URL(request.url()).pathname);
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/host") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body><script>window.__messages = [];
addEventListener("message", (event) => window.__messages.push(event.data));</script>
<iframe id="f" sandbox="allow-scripts" src="${ORIGIN}/_artifact/frame/t1" width="800" height="600"></iframe></body>`,
      });
    }
    if (url.pathname.startsWith("/_artifact/lib/")) {
      const path = resolve(LIB_DIST_DIR, `.${url.pathname.slice("/_artifact/lib".length)}`);
      if (!path.startsWith(`${LIB_DIST_DIR}${sep}`) || !existsSync(path)) return route.fulfill({ status: 404 });
      return route.fulfill({
        body: readFileSync(path),
        headers: {
          "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname.startsWith("/_artifact/blob/")) {
      return route.fulfill({
        body: file.body,
        headers: {
          "Content-Type": file.mediaType,
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      });
    }
    if (url.pathname.startsWith("/_artifact/frame/")) {
      return route.fulfill({
        body: buildFrameDocument({
          type,
          content: "",
          theme: "light",
          manifest,
          libBase: LIB_BASE,
          blobUrl: `${BLOB_BASE}t1`,
        }),
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": buildCsp({ libBase: LIB_BASE, blobBase: BLOB_BASE }),
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
  await page.goto(`${ORIGIN}/host`);
  return { frameRequests, consoleErrors };
}

const frameOf = async (page: Page): Promise<Frame> => {
  await expect.poll(() => page.frames().find((f) => f.url().includes("/_artifact/frame/")) ?? null).not.toBeNull();
  return page.frames().find((f) => f.url().includes("/_artifact/frame/")) as Frame;
};

const messages = (page: Page) =>
  page.evaluate(() => (window as unknown as { __messages: { type: string }[] }).__messages);

test("ảnh: <img> trong khung mờ nạp được tệp qua route tệp, không có lỗi gửi cho trang cha", async ({ page }) => {
  const { frameRequests } = await serve(page, "image", { body: PNG, mediaType: "image/png" });
  const frame = await frameOf(page);
  await expect
    .poll(() => frame.evaluate(() => (document.querySelector("img") as HTMLImageElement | null)?.naturalWidth ?? 0))
    .toBe(1);
  expect((await messages(page)).filter((m) => m.type === "error")).toEqual([]);
  expect(frameRequests).toContain("/_artifact/blob/t1");
});

test("ảnh hỏng: khung báo lỗi lên trang cha để hiện 'Tải lại trang'", async ({ page }) => {
  await serve(page, "image", { body: Buffer.from("không phải ảnh"), mediaType: "image/png" });
  await expect.poll(async () => (await messages(page)).some((m) => m.type === "error")).toBe(true);
});

test("PDF: pdf.js dựng đủ trang vào canvas dưới CSP của khung, worker chạy trên luồng chính", async ({ page }) => {
  const { frameRequests } = await serve(page, "pdf", { body: pdfWithPages(2), mediaType: "application/pdf" });
  const frame = await frameOf(page);
  await expect.poll(() => frame.locator("#pages .page").count()).toBe(2);
  await expect.poll(() => frame.locator("#pages canvas").count()).toBeGreaterThan(0);
  // Canvas có nét chữ: ít nhất một điểm ảnh không phải trắng.
  const painted = await frame.evaluate(() => {
    const canvas = document.querySelector("#pages canvas") as HTMLCanvasElement;
    const { data } = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height) ?? { data: [] };
    for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 200) return true;
    return false;
  });
  expect(painted).toBe(true);
  expect((await messages(page)).filter((m) => m.type === "error")).toEqual([]);
  // Khung chỉ nói chuyện với thư mục thư viện và route tệp.
  for (const path of frameRequests) expect(path).toMatch(/^\/_artifact\/(lib|blob|frame)\//);
});

test("PDF hỏng: báo lỗi runtime lên trang cha", async ({ page }) => {
  await serve(page, "pdf", { body: Buffer.from("%PDF-1.4 hỏng"), mediaType: "application/pdf" });
  await expect.poll(async () => (await messages(page)).some((m) => m.type === "error")).toBe(true);
});
