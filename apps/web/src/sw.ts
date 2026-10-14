/// <reference lib="webworker" />
/*
 * Service worker chỉ để mở app nhanh và còn vỏ khi mất mạng (PWA cài trên điện thoại). Cố ý hẹp:
 * - Chỉ giữ file build của chính app (`__WB_MANIFEST`: JS/CSS/font/icon có hash trong tên, và index.html).
 * - Mọi đường dẫn của hub (/rpc, /api, /ws, /mcp, /auth) đi thẳng ra mạng, service worker không chen vào: dữ liệu
 *   người dùng, phiên đăng nhập và terminal không bao giờ nằm trong cache của trình duyệt.
 * - Không `skipWaiting`/`clients.claim`: bản mới chờ đến khi đóng hết tab rồi mới thay, để không đổi mã dưới chân
 *   người đang gõ trong terminal. Điều hướng luôn thử mạng trước nên index.html mới vẫn tới ngay khi có mạng.
 * Web Push (`push`, `notificationclick`) chờ hub có Web Push (T071), chưa xử lý ở đây.
 */

// Biến file thành module để `declare const self` bên dưới không đụng khai báo toàn cục của lib webworker.
export {};

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };

const PASS_THROUGH = ["/rpc", "/api", "/ws", "/mcp", "/auth", "/.well-known"];
const CACHE_PREFIX = "hive-shell-";

const entries = self.__WB_MANIFEST;
const absolute = (url: string) => new URL(url, self.registration.scope).href;

/** Tên cache theo nội dung bản build: bản mới có cache riêng, cache bản cũ xoá khi bản mới kích hoạt. */
function versionOf(list: PrecacheEntry[]): string {
  let hash = 5381;
  for (const char of JSON.stringify(list)) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
const CACHE = `${CACHE_PREFIX}${versionOf(entries)}`;
const SHELL = absolute("index.html");

const passThrough = (pathname: string) =>
  PASS_THROUGH.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload` để không nạp file cũ từ cache HTTP của trình duyệt vào bản cache mới.
      cache.addAll(entries.map((entry) => new Request(absolute(entry.url), { cache: "reload" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
});

async function navigate(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    // Mất mạng: trả vỏ SPA, router phía client tự dựng trang; các lời gọi /rpc của trang sẽ báo lỗi mạng như bình thường.
    const shell = await caches.match(SHELL, { cacheName: CACHE });
    if (shell) return shell;
    throw new TypeError("Không có mạng và chưa có vỏ ứng dụng trong cache.");
  }
}

async function asset(request: Request): Promise<Response> {
  return (await caches.match(request, { cacheName: CACHE, ignoreVary: true })) ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || passThrough(url.pathname)) return;
  event.respondWith(request.mode === "navigate" ? navigate(request) : asset(request));
});
