import type { Context } from "hono";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";

export interface DeployStreamDeps {
  auth?: Auth | undefined;
  pool?: pg.Pool | undefined;
}

/**
 * GET /api/v1/deploys/{id}/stream: SSE các bước và log của lần triển khai. Nằm ngoài oRPC như luồng của run vì cần
 * Last-Event-ID. Làm ở task sau; giờ trả 501 sau khi kiểm đăng nhập.
 */
export function deployStreamHandler(deps: DeployStreamDeps) {
  return async (c: Context) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers: c.req.raw.headers }) : null;
    if (!session) return c.json({ message: "Chưa đăng nhập." }, 401);
    return c.json(
      { message: "Chức năng CI/CD và triển khai chưa được làm xong.", data: { code: "NOT_IMPLEMENTED" } },
      501,
    );
  };
}
