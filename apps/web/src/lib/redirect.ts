export const LOGIN_PATH = "/login";

const BASE = "http://hive.invalid";

/**
 * Đích quay lại sau khi đăng nhập, lấy từ `?redirect=`. Chỉ nhận đường dẫn trong cùng hub để không ai
 * dựng được link đăng nhập rồi đẩy người dùng sang trang khác (`//evil.com`, `/\evil.com`, `https://...`).
 */
export function safeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE || url.pathname === LOGIN_PATH) return "/";
  return url.pathname + url.search + url.hash;
}

/** Đường dẫn trang đăng nhập, kèm chỗ quay lại nếu không phải trang chủ. */
export function loginHref(back: string): string {
  return back === "/" ? LOGIN_PATH : `${LOGIN_PATH}?${new URLSearchParams({ redirect: back })}`;
}

export interface Destination {
  pathname: string;
  /** pathname + search + hash */
  href: string;
  /** Giá trị `?redirect=` đã parse. */
  redirect?: unknown;
}

/** Trang mở lời mời: người được mời thường chưa có tài khoản, nên phải xem được lời mời trước khi đăng nhập. */
export const INVITE_PREFIX = "/invite/";

/** Nơi phải chuyển tới trước khi vào `to`, hoặc null nếu được vào. */
export function authRedirect(to: Destination, signedIn: boolean): string | null {
  const onLogin = to.pathname === LOGIN_PATH;
  if (signedIn) return onLogin ? safeRedirect(to.redirect) : null;
  if (to.pathname.startsWith(INVITE_PREFIX)) return null;
  return onLogin ? null : loginHref(safeRedirect(to.href));
}

/*
 * Đường dẫn tiếng Việt cũ. Link mời, thông báo và email đã gửi trước khi đổi tên vẫn trỏ tới đây, nên phải mở được.
 * Khớp theo đoạn đầu trọn vẹn (`/moi` không khớp `/moi-khac`), phần còn lại, query và hash giữ nguyên.
 */
const LEGACY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["/dang-nhap", "/login"],
  ["/moi", "/invite"],
  ["/dong-y-mcp", "/mcp/consent"],
  ["/tao-to-chuc", "/orgs/new"],
  ["/quan-tri/doi", "/admin/teams"],
  ["/quan-tri/thanh-vien", "/admin/members"],
  ["/quan-tri/dang-nhap", "/admin/sign-in-settings"],
  ["/quan-tri/may", "/admin/machines"],
  ["/viec", "/tasks"],
  ["/du-an", "/projects"],
];

/** Địa chỉ mới thay cho đường dẫn tiếng Việt cũ, hoặc null nếu `to` không phải đường dẫn cũ. */
export function legacyRedirect(to: Pick<Destination, "pathname" | "href">): string | null {
  for (const [from, next] of LEGACY_PREFIXES) {
    if (to.pathname === from || to.pathname.startsWith(`${from}/`)) return next + to.href.slice(from.length);
  }
  return null;
}
