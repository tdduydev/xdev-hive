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

/**
 * Trùng định danh hoặc trạng thái không cho phép thao tác (vd. hạ chủ sở hữu cuối cùng). Đổi thành CONFLICT. `data`
 * đi kèm `code` trong lỗi oRPC khi client cần biết chi tiết để hiện (vd. tài liệu còn thiếu của cổng AI SDLC).
 */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
  readonly code: string;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Dữ liệu hợp lệ về dạng nhưng nghiệp vụ không nhận (vd. thiếu secret khi cấu hình lần đầu). Đổi thành BAD_REQUEST. */
export class BadRequestError extends Error {
  override readonly name = "BadRequestError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
