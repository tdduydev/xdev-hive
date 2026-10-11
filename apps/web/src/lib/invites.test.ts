import { describe, expect, it } from "vitest";
import {
  canInvite,
  canRevoke,
  emailsError,
  invitableRoles,
  isInviteToken,
  joinedOrg,
  MAX_INVITES,
  parseEmails,
  sameEmail,
} from "./invites.ts";

describe("parseEmails", () => {
  it("tách theo dấu phẩy, chấm phẩy, khoảng trắng và xuống dòng", () =>
    expect(parseEmails("a@x.vn, b@x.vn;c@x.vn\nd@x.vn  e@x.vn").emails).toEqual([
      "a@x.vn",
      "b@x.vn",
      "c@x.vn",
      "d@x.vn",
      "e@x.vn",
    ]));
  it("chữ thường, bỏ trùng, giữ thứ tự nhập", () =>
    expect(parseEmails("Ha.Le@example.com, b@x.vn, ha.le@example.com")).toEqual({
      emails: ["ha.le@example.com", "b@x.vn"],
      invalid: [],
    }));
  it("giữ nguyên chữ người dùng gõ sai để báo lại", () =>
    expect(parseEmails("a@x.vn, khong-phai-email, b@x").invalid).toEqual(["khong-phai-email", "b@x"]));
  it("ô trống", () => expect(parseEmails(" ,\n ")).toEqual({ emails: [], invalid: [] }));
});

describe("emailsError", () => {
  it("không có email", () => expect(emailsError(parseEmails(""))).toBe("Nhập ít nhất một email."));
  it("liệt kê email sai", () =>
    expect(emailsError(parseEmails("a@x.vn, sai, cung-sai"))).toBe("Email không hợp lệ: sai, cung-sai."));
  it("quá giới hạn của hub", () => {
    const many = Array.from({ length: MAX_INVITES + 1 }, (_, i) => `n${i}@x.vn`).join(",");
    expect(emailsError(parseEmails(many))).toBe(`Mời tối đa ${MAX_INVITES} email mỗi lần.`);
  });
  it("hợp lệ", () => expect(emailsError(parseEmails("a@x.vn"))).toBeUndefined());
});

describe("vai trò được mời", () => {
  it("chủ sở hữu mời được thành viên và quản trị", () => expect(invitableRoles("owner")).toEqual(["member", "admin"]));
  it("quản trị chỉ mời thành viên (hub chặn mời quản trị)", () => expect(invitableRoles("admin")).toEqual(["member"]));
  it("thành viên không mời được ai", () => {
    expect(invitableRoles("member")).toEqual([]);
    expect(canInvite("member")).toBe(false);
  });
  it("quản trị mời được", () => expect(canInvite("admin")).toBe(true));
});

describe("canRevoke", () => {
  it("lời mời đã dùng thì không thu hồi", () => expect(canRevoke("accepted")).toBe(false));
  it("lời mời chờ nhận hoặc hết hạn thì thu hồi được", () => {
    expect(canRevoke("pending")).toBe(true);
    expect(canRevoke("expired")).toBe(true);
  });
});

describe("isInviteToken", () => {
  it("mã 43 ký tự base64url của hub", () => expect(isInviteToken("A".repeat(43))).toBe(true));
  it("quá ngắn hoặc quá dài", () => {
    expect(isInviteToken("abc")).toBe(false);
    expect(isInviteToken("A".repeat(129))).toBe(false);
  });
});

describe("sameEmail", () => {
  it("không phân biệt hoa thường như hub", () => expect(sameEmail("Ha.Le@example.com", "ha.le@example.com")).toBe(true));
  it("email khác", () => expect(sameEmail("a@x.vn", "b@x.vn")).toBe(false));
});

describe("joinedOrg", () => {
  const orgs = [
    { id: "1", name: "Nội bộ" },
    { id: "2", name: "FPT Software xDev" },
  ];
  it("tìm theo tên trong lời mời", () => expect(joinedOrg(orgs, "FPT Software xDev")?.id).toBe("2"));
  it("không khớp tên thì lấy tổ chức đầu tiên", () => expect(joinedOrg(orgs, "Khác")?.id).toBe("1"));
  it("chưa vào tổ chức nào", () => expect(joinedOrg([], "FPT Software xDev")).toBeNull());
});
