/**
 * Lỗi nghiệp vụ của fleet. Module không phụ thuộc oRPC; router đổi `kind` thành mã lỗi đã khai báo trong hợp đồng.
 * `code` ổn định để client phân biệt lý do mà không cần đọc message.
 */
export class FleetError extends Error {
  override readonly name = "FleetError";
  readonly kind: "bad_request" | "unauthorized" | "not_found" | "conflict" | "rate_limited";
  readonly code: string;

  constructor(kind: FleetError["kind"], code: string, message: string) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

// Cùng một lỗi cho mã sai, hết hạn hay đã dùng, để người dò không biết mã nào từng tồn tại.
export const invalidRegistration = () =>
  new FleetError("unauthorized", "REGISTRATION_INVALID", "Mã đăng ký không hợp lệ, đã hết hạn hoặc đã dùng.");

// Một lỗi cho nonce sai, chữ ký sai, máy không có khoá hay đã bị thu hồi (ADR 0033), như invalidRegistration.
export const machineAuthFailed = () =>
  new FleetError("unauthorized", "MACHINE_AUTH_FAILED", "Máy không xác thực được với hub.");
