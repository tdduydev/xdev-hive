import { describe, expect, it } from "vitest";
import { authErrorLabel } from "./auth-errors.ts";

describe("authErrorLabel", () => {
  it("sai mật khẩu", () =>
    expect(authErrorLabel({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 }, "email")).toBe(
      "Email hoặc mật khẩu không đúng.",
    ));
  it("mã viết thường trong ?error= sau khi chuyển hướng", () =>
    expect(authErrorLabel({ code: "signup_disabled" })).toMatch(/chưa có trên hub/));
  it("người dùng huỷ ở GitHub/GitLab", () => expect(authErrorLabel({ code: "access_denied" })).toMatch(/đã huỷ/));
  it("hub chưa bật GitHub", () =>
    expect(authErrorLabel({ code: "PROVIDER_NOT_FOUND", status: 404 }, "social")).toMatch(/chưa bật/));
  it("SSO: không có nhà cung cấp cho tên miền (404 không mã)", () =>
    expect(authErrorLabel({ status: 404 }, "sso")).toMatch(/Chưa có SSO cho tên miền/));
  it("SSO: lỗi discovery của IdP", () =>
    expect(authErrorLabel({ code: "discovery_timeout", status: 502 }, "sso")).toMatch(/SSO của tổ chức/));
  it("mất kết nối", () => expect(authErrorLabel({ status: 0 })).toMatch(/Không kết nối được hub/));
  it("bị giới hạn lượt thử", () => expect(authErrorLabel({ status: 429 })).toMatch(/quá nhiều lần/));
  it("hub lỗi 5xx", () => expect(authErrorLabel({ status: 503 })).toMatch(/Hub đang gặp lỗi/));
  it("mã lạ: báo chung kèm mã", () =>
    expect(authErrorLabel({ code: "WEIRD_THING", status: 400 })).toMatch(/WEIRD_THING/));
  it("không có gì: vẫn có câu tiếng Việt", () => expect(authErrorLabel({})).toMatch(/^Không đăng nhập được/));
  it("đăng ký: mã mời của hub không dùng được", () =>
    expect(authErrorLabel({ code: "SIGN_UP_INVITE_INVALID", status: 403 }, "signup")).toMatch(/Lời mời không còn/));
  it("GitHub/GitLab/SSO: người mới chưa được mời (mã gửi về qua ?error=)", () =>
    expect(authErrorLabel({ code: "SIGN_UP_NOT_INVITED" })).toMatch(/^Hub chỉ nhận người được mời/));
  it("GitHub/GitLab: email chưa xác minh", () =>
    expect(authErrorLabel({ code: "SIGN_UP_EMAIL_UNVERIFIED" })).toMatch(/chưa được nhà cung cấp xác minh/));
  it("đăng ký: email đã có tài khoản thì gợi ý đăng nhập", () =>
    expect(authErrorLabel({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", status: 422 }, "signup")).toMatch(
      /Đăng nhập để nhận lời mời/,
    ));
  it("đăng ký: mật khẩu ngắn", () =>
    expect(authErrorLabel({ code: "PASSWORD_TOO_SHORT", status: 400 }, "signup")).toMatch(/ít nhất 10 ký tự/));
  it("đăng ký: mã lạ nói rõ là không tạo được tài khoản", () =>
    expect(authErrorLabel({ code: "WEIRD", status: 400 }, "signup")).toMatch(/^Không tạo được tài khoản \(mã WEIRD\)/));
});
