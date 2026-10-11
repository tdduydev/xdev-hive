import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";

// Hub phục vụ Better Auth ở /api/auth cùng origin với web (lúc dev đi qua proxy của Vite), nên không cần baseURL.
export const authClient = createAuthClient({ basePath: "/api/auth", plugins: [ssoClient()] });
