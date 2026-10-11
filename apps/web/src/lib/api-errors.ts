import { ORPCError } from "@orpc/client";

const NETWORK = "Không kết nối được hub. Kiểm tra mạng rồi thử lại.";
const SERVER = "Hub đang gặp lỗi. Thử lại sau ít phút.";

const BY_CODE: Record<string, string> = {
  UNAUTHORIZED: "Phiên đăng nhập đã hết hạn. Tải lại trang rồi đăng nhập lại.",
  FORBIDDEN: "Bạn không có quyền làm việc này.",
  NOT_FOUND: "Không tìm thấy. Có thể dữ liệu vừa bị xoá; tải lại trang để xem bản mới.",
  CONFLICT: "Dữ liệu bị trùng hoặc vừa bị người khác đổi. Tải lại trang rồi thử lại.",
  BAD_REQUEST: "Dữ liệu gửi lên không hợp lệ.",
  TOO_MANY_REQUESTS: "Thao tác quá nhanh. Đợi một lát rồi thử lại.",
};

/**
 * Lỗi nghiệp vụ mà câu của hub chỉ nói cái gì sai, chưa nói người dùng làm gì tiếp; theo `data.code` hub gửi kèm.
 * Câu dài hơn của hub vì người duyệt cần biết vì sao kế hoạch vừa mở đã không duyệt được.
 */
const BY_HUB_CODE: Record<string, string> = {
  PLAN_DECIDED:
    "Kế hoạch này không còn chờ duyệt: có người vừa duyệt hoặc từ chối, việc đã bị huỷ, hoặc agent đã lập bản mới. Tải lại để xem bản mới nhất.",
  PLAN_NOT_FOUND: "Việc này chưa có kế hoạch. Kế hoạch có khi dự án bật plan mode và agent lập xong.",
};

/**
 * Câu báo lỗi tiếng Việt cho một lời gọi API. Lỗi đã khai báo trong hợp đồng (`defined`) mang câu hub viết bằng
 * tiếng Việt và nói rõ lý do (vd. chủ sở hữu cuối cùng), nên dùng nguyên văn. Lỗi khác mang câu mặc định tiếng Anh
 * của oRPC, nên đổi theo mã.
 */
export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ORPCError)) return NETWORK;
  const hubCode = isRecord(error.data) && typeof error.data.code === "string" ? error.data.code : undefined;
  const byHubCode = hubCode ? BY_HUB_CODE[hubCode] : undefined;
  if (byHubCode) return byHubCode;
  // "Chưa đăng nhập." của hub đúng nhưng khó hiểu khi đang dùng dở; nói rõ là phiên đã hết hạn.
  if (error.defined && error.code !== "UNAUTHORIZED" && error.message) return error.message;
  const byCode = BY_CODE[error.code];
  if (byCode) return byCode;
  if (error.status >= 500) return SERVER;
  return `Không làm được việc này (mã ${error.code}). Thử lại hoặc báo quản trị hub.`;
}

export interface FormError {
  /** Trường của form bị lỗi (tên trường trong input của thủ tục), nếu biết. */
  field?: string;
  message: string;
}

interface Issue {
  message?: unknown;
  path?: unknown;
}

/** Tên trường đầu tiên trong `path` của một issue (Standard Schema cho phép phần tử là `{ key }`). */
function topField(path: unknown): string | undefined {
  if (!Array.isArray(path)) return undefined;
  const first: unknown = path[0];
  const key = typeof first === "object" && first !== null && "key" in first ? first.key : first;
  return typeof key === "string" ? key : undefined;
}

/**
 * Lỗi để hiện trên form: gắn vào đúng ô khi hub chỉ ra được trường sai, còn lại hiện chung. `byCode` gắn lỗi nghiệp
 * vụ của hub (`data.code`, vd. SSO_DISCOVERY_FAILED) vào ô liên quan, cho form biết lỗi đó thuộc ô nào.
 */
export function formError(error: unknown, byCode: Record<string, string> = {}): FormError {
  const message = apiErrorMessage(error);
  if (!(error instanceof ORPCError)) return { message };
  const data: unknown = error.data;
  if (error.code === "CONFLICT" && isRecord(data) && data.code === "SLUG_TAKEN") return { field: "slug", message };
  const coded = isRecord(data) && typeof data.code === "string" ? byCode[data.code] : undefined;
  if (coded) return { field: coded, message };
  if (error.code === "BAD_REQUEST" && isRecord(data) && Array.isArray(data.issues)) {
    const issue = data.issues[0] as Issue | undefined;
    const field = topField(issue?.path);
    if (field && typeof issue?.message === "string") return { field, message: issue.message };
  }
  return { message };
}

/** Mã nghiệp vụ hub gắn vào lỗi (`data.code`, vd. SSO_DOMAIN_TAKEN), nếu có. */
export function apiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  const data: unknown = error.data;
  return isRecord(data) && typeof data.code === "string" ? data.code : undefined;
}

/** Không thử lại lỗi 4xx (quyền, dữ liệu sai): kết quả không đổi, chỉ làm người dùng chờ lâu hơn mới thấy lỗi. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ORPCError && error.status < 500) return false;
  return failureCount < 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
