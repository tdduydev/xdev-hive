import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { apiErrorMessage, formError, shouldRetry } from "./api-errors.ts";

// Lỗi client nhận khi hub trả lỗi đã khai báo trong hợp đồng (packages/contracts/src/tenancy.ts).
const defined = (code: string, message: string, data?: unknown) =>
  new ORPCError(code, { defined: true, message, data });

describe("apiErrorMessage", () => {
  it("lỗi hub đã khai báo: dùng nguyên câu tiếng Việt của hub", () =>
    expect(apiErrorMessage(defined("CONFLICT", "Tổ chức phải còn ít nhất một chủ sở hữu đang hoạt động."))).toBe(
      "Tổ chức phải còn ít nhất một chủ sở hữu đang hoạt động.",
    ));
  it("hết phiên: nói rõ thay vì 'Chưa đăng nhập.'", () =>
    expect(apiErrorMessage(defined("UNAUTHORIZED", "Chưa đăng nhập."))).toMatch(/Phiên đăng nhập đã hết hạn/));
  it("lỗi không khai báo mang câu tiếng Anh của oRPC: đổi theo mã", () =>
    expect(apiErrorMessage(new ORPCError("FORBIDDEN"))).toBe("Bạn không có quyền làm việc này."));
  it("hub lỗi 5xx", () => expect(apiErrorMessage(new ORPCError("INTERNAL_SERVER_ERROR"))).toMatch(/Hub đang gặp lỗi/));
  it("proxy trả 502 không đúng định dạng", () =>
    expect(apiErrorMessage(new ORPCError("BAD_GATEWAY", { status: 502 }))).toMatch(/Hub đang gặp lỗi/));
  it("mất mạng (fetch ném TypeError)", () =>
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toMatch(/Không kết nối được hub/));
  it("kế hoạch đã được quyết: nói rõ làm gì tiếp thay cho câu ngắn của hub", () =>
    expect(apiErrorMessage(defined("CONFLICT", "Kế hoạch không còn chờ duyệt.", { code: "PLAN_DECIDED" }))).toMatch(
      /Tải lại để xem bản mới nhất/,
    ));
  it("mã lạ 4xx: báo chung kèm mã", () =>
    expect(apiErrorMessage(new ORPCError("I_AM_A_TEAPOT", { status: 418 }))).toMatch(/I_AM_A_TEAPOT/));
});

describe("formError", () => {
  it("trùng định danh gắn vào ô định danh", () =>
    expect(
      formError(defined("CONFLICT", 'Định danh "thanh-toan" đã được đội khác dùng.', { code: "SLUG_TAKEN" })),
    ).toEqual({ field: "slug", message: 'Định danh "thanh-toan" đã được đội khác dùng.' }));
  it("lỗi kiểm tra đầu vào gắn vào trường đầu tiên bị sai", () =>
    expect(
      formError(
        defined("BAD_REQUEST", "Dữ liệu không hợp lệ ở trường emailDomain: Tên miền không hợp lệ.", {
          issues: [{ path: ["emailDomain"], message: "Tên miền không hợp lệ." }],
        }),
      ),
    ).toEqual({ field: "emailDomain", message: "Tên miền không hợp lệ." }));
  it("path dạng { key } của Standard Schema", () =>
    expect(
      formError(defined("BAD_REQUEST", "x", { issues: [{ path: [{ key: "name" }], message: "Tên trống." }] })),
    ).toEqual({ field: "name", message: "Tên trống." }));
  it("lỗi không gắn được vào trường thì hiện chung", () =>
    expect(formError(defined("FORBIDDEN", "Cần vai trò quản trị của tổ chức trở lên."))).toEqual({
      message: "Cần vai trò quản trị của tổ chức trở lên.",
    }));
  it("mất mạng", () => expect(formError(new TypeError("x")).message).toMatch(/Không kết nối được hub/));
  it("lỗi nghiệp vụ gắn vào ô theo mã của hub", () =>
    expect(
      formError(
        defined("BAD_REQUEST", "Không đọc được cấu hình OIDC từ Issuer URL.", { code: "SSO_DISCOVERY_FAILED" }),
        { SSO_DISCOVERY_FAILED: "issuer" },
      ),
    ).toEqual({ field: "issuer", message: "Không đọc được cấu hình OIDC từ Issuer URL." }));
  it("mã không có trong bảng thì hiện chung", () =>
    expect(
      formError(defined("CONFLICT", "Đã có người đăng nhập bằng SSO này.", { code: "SSO_HAS_ACCOUNTS" }), {
        SSO_DISCOVERY_FAILED: "issuer",
      }),
    ).toEqual({ message: "Đã có người đăng nhập bằng SSO này." }));
});

describe("shouldRetry", () => {
  it("không thử lại lỗi 4xx", () => expect(shouldRetry(0, new ORPCError("FORBIDDEN"))).toBe(false));
  it("thử lại lỗi 5xx và mất mạng, tối đa 2 lần", () => {
    expect(shouldRetry(0, new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(true);
    expect(shouldRetry(1, new TypeError("x"))).toBe(true);
    expect(shouldRetry(2, new TypeError("x"))).toBe(false);
  });
});
