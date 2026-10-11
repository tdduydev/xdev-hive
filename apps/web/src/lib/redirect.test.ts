import { describe, expect, it } from "vitest";
import { authRedirect, loginHref, safeRedirect } from "./redirect.ts";

describe("safeRedirect", () => {
  it("giữ đường dẫn trong hub, kèm query và hash", () => {
    expect(safeRedirect("/du-an/abc?tab=viec#log")).toBe("/du-an/abc?tab=viec#log");
  });
  it.each([
    ["không có", undefined],
    ["không phải chuỗi", 42],
    ["URL tuyệt đối", "https://evil.example/"],
    ["protocol-relative", "//evil.example/x"],
    ["gạch ngược", "/\\evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["không bắt đầu bằng /", "du-an"],
    ["chính trang đăng nhập", "/dang-nhap?redirect=/x"],
  ])("về trang chủ khi %s", (_, value) => expect(safeRedirect(value)).toBe("/"));
});

describe("loginHref", () => {
  it("trang chủ thì không kèm redirect", () => expect(loginHref("/")).toBe("/dang-nhap"));
  it("trang khác thì mã hoá vào ?redirect=", () =>
    expect(loginHref("/du-an?x=1")).toBe("/dang-nhap?redirect=%2Fdu-an%3Fx%3D1"));
});

describe("authRedirect", () => {
  const at = (href: string, redirect?: string) => ({
    pathname: new URL(href, "http://h").pathname,
    href,
    ...(redirect === undefined ? {} : { redirect }),
  });

  it("chưa đăng nhập: trang chủ chuyển về /dang-nhap", () => expect(authRedirect(at("/"), false)).toBe("/dang-nhap"));
  it("chưa đăng nhập: trang khác (kể cả không tồn tại) chuyển về /dang-nhap và nhớ chỗ quay lại", () =>
    expect(authRedirect(at("/khong-co?a=1"), false)).toBe("/dang-nhap?redirect=%2Fkhong-co%3Fa%3D1"));
  it("chưa đăng nhập: đang ở /dang-nhap thì ở yên", () =>
    expect(authRedirect(at("/dang-nhap?redirect=%2Fx", "/x"), false)).toBeNull());
  it("đã đăng nhập: vào trang bất kỳ", () => expect(authRedirect(at("/du-an"), true)).toBeNull());
  it("đã đăng nhập: mở /dang-nhap thì vào /", () => expect(authRedirect(at("/dang-nhap"), true)).toBe("/"));
  it("đã đăng nhập: mở /dang-nhap?redirect= thì về đúng chỗ cũ", () =>
    expect(authRedirect(at("/dang-nhap?redirect=%2Fdu-an", "/du-an"), true)).toBe("/du-an"));
  it("đã đăng nhập: redirect ra ngoài hub bị bỏ", () =>
    expect(authRedirect(at("/dang-nhap", "https://evil.example"), true)).toBe("/"));
});
