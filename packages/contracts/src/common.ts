import { oc } from "@orpc/contract";
import { z } from "zod";

export const id = z.uuid("Mã không hợp lệ.");

// `code` ổn định để client phân biệt lý do mà không phải đọc message.
const reason = z.object({ code: z.string() }).optional();
export const orgErrors = {
  UNAUTHORIZED: { message: "Chưa đăng nhập." },
  // Không khai báo data: lỗi kiểm tra đầu vào của oRPC mang danh sách issues.
  BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
  FORBIDDEN: { message: "Bạn không có quyền làm việc này.", data: reason },
  NOT_FOUND: { message: "Không tìm thấy.", data: reason },
  CONFLICT: { message: "Dữ liệu bị trùng hoặc xung đột.", data: reason },
};

const ORG_HEADER = "Tổ chức lấy từ header `x-hive-org`.";

/** Route của dữ liệu trong một tổ chức: tổ chức đi theo header, lỗi theo bộ chung. */
export const orgRoute = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: `/v1/${string}`,
  summary: string,
  tag: string,
) => oc.route({ method, path, summary, tags: [tag], description: ORG_HEADER }).errors(orgErrors);
