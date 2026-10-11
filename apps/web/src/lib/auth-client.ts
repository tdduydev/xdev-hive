import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";

// Hub phục vụ Better Auth ở /api/auth cùng origin với web (lúc dev đi qua proxy của Vite), nên không cần baseURL.
// oauthProviderClient gắn query đã ký của luồng OAuth (client MCP xin token) vào lời gọi đăng nhập và đồng ý, để hub
// quay lại đúng luồng authorize sau khi người dùng đăng nhập.
export const authClient = createAuthClient({ basePath: "/api/auth", plugins: [ssoClient(), oauthProviderClient()] });

/** Hub trả `{ redirect, url }` khi lời gọi thuộc luồng OAuth và cần chuyển trình duyệt sang bước kế tiếp. */
export function oauthContinuation(data: unknown): string | null {
  const d = data as { redirect?: unknown; url?: unknown } | null;
  return d?.redirect === true && typeof d.url === "string" ? d.url : null;
}

/**
 * Đăng ký bằng email kèm mã mời. Gọi thẳng endpoint vì kiểu của `signUp.email` chỉ nhận trường của Better Auth, còn
 * `inviteToken` là trường riêng mà hook đăng ký của hub đọc trong body (apps/hub, identity/auth.ts); Better Auth bỏ
 * qua trường lạ khi tạo người dùng.
 */
export function signUpWithInvite(body: { name: string; email: string; password: string; inviteToken: string }) {
  return authClient.$fetch("/sign-up/email", { method: "POST", body });
}
