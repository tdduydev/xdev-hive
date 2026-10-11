/**
 * Lỗi phân quyền của nghiệp vụ. Module không phụ thuộc oRPC; lớp API bắt lớp lỗi này rồi đổi thành FORBIDDEN,
 * nên `code` phải ổn định để client phân biệt lý do mà không cần đọc message.
 */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
