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
