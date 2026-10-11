export const LOGIN_PATH = "/dang-nhap";

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
export const INVITE_PREFIX = "/moi/";

/** Nơi phải chuyển tới trước khi vào `to`, hoặc null nếu được vào. */
export function authRedirect(to: Destination, signedIn: boolean): string | null {
  const onLogin = to.pathname === LOGIN_PATH;
  if (signedIn) return onLogin ? safeRedirect(to.redirect) : null;
  if (to.pathname.startsWith(INVITE_PREFIX)) return null;
  return onLogin ? null : loginHref(safeRedirect(to.href));
}
