export class HubError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401
        ? "Phiên Hive đã hết hạn. Vui lòng đăng nhập lại."
        : status === 403
          ? "Bạn không có quyền thực hiện thao tác này."
          : status === 404
            ? "Không tìm thấy dữ liệu trên Hive."
            : status === 429
              ? "Hive đang giới hạn yêu cầu. Vui lòng thử lại sau."
              : "Không kết nối được hub. Vui lòng thử lại sau.",
    );
    this.name = "HubError";
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof HubError ? error.message : "Không kết nối được hub. Vui lòng thử lại sau.";
}
