/**
 * Lỗi từ Better Auth: `error` mà authClient trả về, hoặc `?error=` khi hub chuyển hướng về sau OAuth/SSO.
 * `status` = 0 nghĩa là không gọi tới được hub.
 */
export interface AuthErrorLike {
  code?: string | undefined;
  status?: number | undefined;
}

export type AuthMethod = "sso" | "social" | "email" | "signup";

const RETRY = "Phiên đăng nhập đã hết hạn hoặc bị mở ở tab khác. Thử đăng nhập lại.";
const SSO_BROKEN = "Không dùng được SSO của tổ chức lúc này. Báo quản trị tổ chức kiểm tra cấu hình SSO.";
const OTHER_METHOD = "Email này đã gắn với cách đăng nhập khác trên hub. Đăng nhập bằng cách đã dùng lần trước.";
const HUB_FAILED = "Hub gặp lỗi khi tạo phiên đăng nhập. Thử lại sau ít phút.";
const NETWORK = "Không kết nối được hub. Kiểm tra mạng rồi thử lại.";

// Mã lấy từ Better Auth 1.7 (BASE_ERROR_CODES, OAUTH_CALLBACK_ERROR_CODES, plugin sso). So khớp không phân biệt hoa thường
// vì mã trong `?error=` viết thường.
const LABELS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Email hoặc mật khẩu không đúng.",
  INVALID_PASSWORD: "Email hoặc mật khẩu không đúng.",
  USER_NOT_FOUND: "Email hoặc mật khẩu không đúng.",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Tài khoản này chưa đặt mật khẩu. Đăng nhập bằng SSO, GitHub hoặc GitLab.",
  INVALID_EMAIL: "Email không hợp lệ.",
  VALIDATION_ERROR: "Email hoặc mật khẩu chưa đúng định dạng.",
  EMAIL_NOT_VERIFIED: "Email chưa được xác minh. Mở thư xác minh rồi thử lại.",
  PROVIDER_NOT_FOUND: "Hub chưa bật cách đăng nhập này. Dùng cách khác hoặc báo quản trị hub.",
  OAUTH_PROVIDER_NOT_FOUND: "Hub chưa bật cách đăng nhập này. Dùng cách khác hoặc báo quản trị hub.",
  ACCESS_DENIED: "Bạn đã huỷ hoặc chưa cấp quyền ở trang của nhà cung cấp.",
  SIGNUP_DISABLED: "Tài khoản này chưa có trên hub. Nhờ quản trị tổ chức gửi lời mời.",
  // Các mã SIGN_UP_* và EMAIL_NOT_ASCII do quy tắc "chỉ nhận người được mời" của hub đặt (apps/hub, identity/auth.ts).
  // SIGN_UP_NOT_INVITED đến qua `?error=` khi GitHub, GitLab hoặc SSO định tạo tài khoản mới. Hub cố ý dùng một mã cho
  // cả "chưa được mời" lẫn "email chưa xác minh", nên câu báo phải nói cả hai.
  SIGN_UP_INVITE_REQUIRED: "Hub chỉ cho đăng ký bằng lời mời. Mở link mời mà quản trị tổ chức gửi cho bạn.",
  SIGN_UP_INVITE_INVALID:
    "Lời mời không còn dùng được cho email này (sai, hết hạn hoặc đã dùng). Nhờ quản trị tổ chức gửi lời mời mới.",
  SIGN_UP_NOT_INVITED:
    "Hub chỉ nhận người được mời. Email của tài khoản bạn vừa dùng phải được nhà cung cấp xác minh và có lời mời còn hạn: nhờ quản trị tổ chức mời đúng email đó, hoặc tạo tài khoản bằng link mời.",
  SIGN_UP_INVITE_ACCEPT_FAILED: "Hub chưa tạo được tài khoản vì lỗi khi nhận lời mời. Thử lại sau ít phút.",
  EMAIL_NOT_ASCII:
    "Hub chỉ nhận email viết bằng ký tự ASCII (không dấu, không ký tự đặc biệt). Dùng tài khoản có địa chỉ email khác.",
  USER_ALREADY_EXISTS: "Email này đã có tài khoản trên hub. Đăng nhập để nhận lời mời.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Email này đã có tài khoản trên hub. Đăng nhập để nhận lời mời.",
  PASSWORD_TOO_SHORT: "Mật khẩu quá ngắn, cần ít nhất 10 ký tự.",
  PASSWORD_TOO_LONG: "Mật khẩu quá dài.",
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "Hub chưa bật đăng ký bằng email. Đăng nhập bằng SSO, GitHub hoặc GitLab.",
  STATE_MISMATCH: RETRY,
  STATE_NOT_FOUND: RETRY,
  INVALID_STATE: RETRY,
  PLEASE_RESTART_THE_PROCESS: RETRY,
  INVALID_CALLBACK_REQUEST: RETRY,
  NO_CODE: RETRY,
  INVALID_CODE: RETRY,
  EMAIL_NOT_FOUND: "Nhà cung cấp không trả về email. Cho phép đọc email trong tài khoản đó rồi thử lại.",
  USER_EMAIL_NOT_FOUND: "Nhà cung cấp không trả về email. Cho phép đọc email trong tài khoản đó rồi thử lại.",
  UNABLE_TO_GET_USER_INFO: "Không lấy được thông tin tài khoản từ nhà cung cấp. Thử lại.",
  FAILED_TO_GET_USER_INFO: "Không lấy được thông tin tài khoản từ nhà cung cấp. Thử lại.",
  ACCOUNT_NOT_LINKED: OTHER_METHOD,
  UNABLE_TO_LINK_ACCOUNT: OTHER_METHOD,
  ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER: OTHER_METHOD,
  EMAIL_DOES_NOT_MATCH: OTHER_METHOD,
  INVALID_PROVIDER: SSO_BROKEN,
  DISCOVERY_FAILED: SSO_BROKEN,
  USER_CREATION_FAILED: HUB_FAILED,
  UNABLE_TO_CREATE_USER: HUB_FAILED,
  FAILED_TO_CREATE_USER: HUB_FAILED,
  FAILED_TO_CREATE_SESSION: HUB_FAILED,
  INTERNAL_SERVER_ERROR: HUB_FAILED,
  INVALID_ORIGIN: "Địa chỉ đang mở không khớp cấu hình của hub. Mở hub bằng đúng địa chỉ quản trị cung cấp.",
  MISSING_OR_NULL_ORIGIN: "Địa chỉ đang mở không khớp cấu hình của hub. Mở hub bằng đúng địa chỉ quản trị cung cấp.",
};

/** Câu báo lỗi tiếng Việt cho người dùng. Mã lạ vẫn được ghi kèm để báo quản trị. */
export function authErrorLabel(error: AuthErrorLike, method?: AuthMethod): string {
  const code = error.code?.toUpperCase();
  if (code) {
    const label = LABELS[code] ?? (code.startsWith("DISCOVERY_") ? SSO_BROKEN : undefined);
    if (label) return label;
  }
  const { status } = error;
  if (status === 0) return NETWORK;
  if (status === 429) return "Thử quá nhiều lần. Đợi một phút rồi thử lại.";
  // Plugin sso trả 404 không kèm mã khi không có nhà cung cấp nào cho tên miền.
  if (method === "sso" && status === 404) {
    return "Chưa có SSO cho tên miền email này. Dùng GitHub, GitLab hoặc email, hoặc hỏi quản trị tổ chức.";
  }
  if (status !== undefined && status >= 500) return "Hub đang gặp lỗi. Thử lại sau ít phút.";
  const failed = method === "signup" ? "Không tạo được tài khoản" : "Không đăng nhập được";
  return code ? `${failed} (mã ${code}). Thử lại hoặc báo quản trị hub.` : `${failed}. Thử lại hoặc báo quản trị hub.`;
}
