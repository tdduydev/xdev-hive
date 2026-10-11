import { describe, expect, it } from "vitest";
import { checkSsoForm, issuerHost } from "./sso.ts";

const valid = {
  issuer: "https://login.microsoftonline.com/3f2a/v2.0",
  domain: "fpt.com",
  clientId: "8c1d5e2a",
  clientSecret: "bi-mat",
};

describe("checkSsoForm", () => {
  it("đủ và đúng thì không có lỗi", () => expect(checkSsoForm(valid, false)).toEqual({}));
  it("issuer không phải URL http(s)", () => {
    expect(checkSsoForm({ ...valid, issuer: "login.microsoftonline.com" }, false).issuer).toMatch(/Issuer URL/);
    expect(checkSsoForm({ ...valid, issuer: "ftp://idp.vn" }, false).issuer).toMatch(/Issuer URL/);
  });
  it("tên miền sai", () => expect(checkSsoForm({ ...valid, domain: "@fpt.com" }, false).domain).toMatch(/tên miền/));
  it("tên miền viết hoa vẫn nhận (hub đổi về chữ thường)", () =>
    expect(checkSsoForm({ ...valid, domain: "FPT.com" }, false).domain).toBeUndefined());
  it("thiếu Client ID", () =>
    expect(checkSsoForm({ ...valid, clientId: "  " }, true).clientId).toBe("Nhập Client ID."));
  it("lần đầu phải có secret", () =>
    expect(checkSsoForm({ ...valid, clientSecret: "" }, false).clientSecret).toMatch(/lần đầu/));
  it("đã cấu hình thì bỏ trống secret là giữ secret cũ", () =>
    expect(checkSsoForm({ ...valid, clientSecret: "" }, true)).toEqual({}));
});

describe("issuerHost", () => {
  it("lấy tên máy", () => expect(issuerHost(valid.issuer)).toBe("login.microsoftonline.com"));
  it("chuỗi không phải URL thì giữ nguyên", () => expect(issuerHost("khong-phai-url")).toBe("khong-phai-url"));
});
