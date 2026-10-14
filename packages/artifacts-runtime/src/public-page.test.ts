import { describe, expect, it } from "vitest";
import { buildPublicPage, buildPublicPageCsp, publicPageHeaders } from "./public-page.ts";

const frameUrl = "https://hive.example.com/_artifact/frame/s.abc_DEF-123";
const base = { title: "Bảng doanh thu", type: "react", version: 4, expiresAt: "2026-10-21T08:30:00.000Z", frameUrl };

describe("buildPublicPage", () => {
  it("không có script nào và chỉ có một iframe sandbox", () => {
    const html = buildPublicPage(base);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html).toContain(`<iframe sandbox="allow-scripts" src="${frameUrl}"`);
    expect(html).not.toContain("allow-same-origin");
  });

  it("hiện tiêu đề, loại, phiên bản, hạn và nhãn cảnh báo", () => {
    const html = buildPublicPage(base);
    expect(html).toContain("<h1>Bảng doanh thu</h1>");
    expect(html).toContain("react · v4 · Hết hạn 2026-10-21 08:30 UTC");
    expect(html).toContain("Nội dung do agent tạo");
  });

  it("escape tiêu đề có HTML", () => {
    const html = buildPublicPage({ ...base, title: '<img src=x onerror=alert(1)>"</title><script>x</script>' });
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<script/i);
    expect(html.match(/<\/title>/g)).toHaveLength(1);
    expect(html).toContain("&#60;img src=x onerror=alert(1)&#62;");
  });

  it("escape loại và địa chỉ khung", () => {
    const html = buildPublicPage({ ...base, type: "<b>" });
    expect(html).not.toContain("<b>");
    expect(() => buildPublicPage({ ...base, frameUrl: 'https://h.example/_artifact/frame/x" onload="1' })).toThrow();
  });

  it("từ chối khung không phải http(s) hoặc hạn sai", () => {
    expect(() => buildPublicPage({ ...base, frameUrl: "javascript:alert(1)" })).toThrow();
    expect(() => buildPublicPage({ ...base, frameUrl: "/_artifact/frame/x" })).toThrow();
    expect(() => buildPublicPage({ ...base, expiresAt: "không phải ngày" })).toThrow();
  });
});

describe("header trang công khai", () => {
  it("CSP theo FR-143 với frame-src chỉ là thư mục khung của hub", () => {
    expect(buildPublicPageCsp({ frameUrl })).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src https://hive.example.com/_artifact/frame/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("không có script-src và không cho script chạy", () => {
    const csp = buildPublicPageCsp({ frameUrl });
    expect(csp).not.toMatch(/script-src/);
    expect(csp).toMatch(/^default-src 'none'/);
  });

  it("đủ header không cache, không lộ referrer, không lập chỉ mục", () => {
    expect(publicPageHeaders({ frameUrl })).toEqual({
      "Content-Security-Policy": buildPublicPageCsp({ frameUrl }),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    });
  });
});
