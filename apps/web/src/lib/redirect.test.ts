import { describe, expect, it } from "vitest";
import { authRedirect, legacyRedirect, loginHref, safeRedirect } from "./redirect.ts";

describe("safeRedirect", () => {
  it("giữ đường dẫn trong hub, kèm query và hash", () => {
    expect(safeRedirect("/projects/abc?tab=viec#log")).toBe("/projects/abc?tab=viec#log");
  });
  it.each([
    ["không có", undefined],
    ["không phải chuỗi", 42],
    ["URL tuyệt đối", "https://evil.example/"],
    ["protocol-relative", "//evil.example/x"],
    ["gạch ngược", "/\\evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["không bắt đầu bằng /", "du-an"],
    ["chính trang đăng nhập", "/login?redirect=/x"],
  ])("về trang chủ khi %s", (_, value) => expect(safeRedirect(value)).toBe("/"));
});

describe("loginHref", () => {
  it("trang chủ thì không kèm redirect", () => expect(loginHref("/")).toBe("/login"));
  it("trang khác thì mã hoá vào ?redirect=", () =>
    expect(loginHref("/projects?x=1")).toBe("/login?redirect=%2Fprojects%3Fx%3D1"));
});

describe("authRedirect", () => {
  const at = (href: string, redirect?: string) => ({
    pathname: new URL(href, "http://h").pathname,
    href,
    ...(redirect === undefined ? {} : { redirect }),
  });

  it("chưa đăng nhập: trang chủ chuyển về /login", () => expect(authRedirect(at("/"), false)).toBe("/login"));
  it("chưa đăng nhập: trang khác (kể cả không tồn tại) chuyển về /login và nhớ chỗ quay lại", () =>
    expect(authRedirect(at("/khong-co?a=1"), false)).toBe("/login?redirect=%2Fkhong-co%3Fa%3D1"));
  it("chưa đăng nhập: trang mở link mời xem được, không bị chuyển đi", () =>
    expect(authRedirect(at("/invite/7Hk2abcdefghijklmnop"), false)).toBeNull());
  it("đã đăng nhập: trang mở link mời", () =>
    expect(authRedirect(at("/invite/7Hk2abcdefghijklmnop"), true)).toBeNull());
  it("đăng nhập xong quay lại đúng link mời", () =>
    expect(authRedirect(at("/login?redirect=%2Finvite%2Fabc", "/invite/abc"), true)).toBe("/invite/abc"));
  it("chưa đăng nhập: đang ở /login thì ở yên", () =>
    expect(authRedirect(at("/login?redirect=%2Fx", "/x"), false)).toBeNull());
  it("đã đăng nhập: vào trang bất kỳ", () => expect(authRedirect(at("/projects"), true)).toBeNull());
  it("đã đăng nhập: mở /login thì vào /", () => expect(authRedirect(at("/login"), true)).toBe("/"));
  it("đã đăng nhập: mở /login?redirect= thì về đúng chỗ cũ", () =>
    expect(authRedirect(at("/login?redirect=%2Fprojects", "/projects"), true)).toBe("/projects"));
  it("đã đăng nhập: redirect ra ngoài hub bị bỏ", () =>
    expect(authRedirect(at("/login", "https://evil.example"), true)).toBe("/"));
});

describe("legacyRedirect", () => {
  const at = (href: string) => legacyRedirect({ pathname: new URL(href, "http://x").pathname, href });
  it.each([
    ["/dang-nhap", "/login"],
    ["/dang-nhap?redirect=%2Fx", "/login?redirect=%2Fx"],
    ["/moi/abc", "/invite/abc"],
    ["/dong-y-mcp?client_id=c&state=s", "/mcp/consent?client_id=c&state=s"],
    ["/tao-to-chuc?buoc=doi", "/orgs/new?buoc=doi"],
    ["/quan-tri/doi?doi=1", "/admin/teams?doi=1"],
    ["/quan-tri/thanh-vien", "/admin/members"],
    ["/quan-tri/dang-nhap", "/admin/sign-in-settings"],
    ["/quan-tri/may", "/admin/machines"],
    ["/viec/HIVE-1", "/tasks/HIVE-1"],
    ["/du-an/abc#log", "/projects/abc#log"],
  ])("%s -> %s", (from, to) => expect(at(from)).toBe(to));
  it.each(["/", "/login", "/invite/abc", "/moi-khac", "/admin/members"])("%s giữ nguyên", (href) =>
    expect(at(href)).toBeNull(),
  );
});
