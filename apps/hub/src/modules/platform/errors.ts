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

/** Đối tượng không có trong tổ chức đang làm việc. Lớp API đổi thành NOT_FOUND. */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Trùng định danh hoặc trạng thái không cho phép thao tác (vd. hạ chủ sở hữu cuối cùng). Đổi thành CONFLICT. */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
