import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Run token (docs/architecture.md mục 6): JWT HS256 hub cấp cùng gói lease, agent trong run dùng để gọi MCP. Khoá ký
 * suy ra từ HIVE_AUTH_SECRET bằng HKDF với nhãn riêng, nên lộ một run token không giúp giả cookie phiên của Better Auth
 * (cùng secret gốc) và ngược lại. Viết tay thay vì thêm thư viện JWT vì chỉ cần một thuật toán, một bên ký và một bên
 * kiểm, đều là hub.
 */
export interface RunTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  run_id: string;
  task_id: string;
  org_id: string;
  attempt: number;
  iat: number;
  exp: number;
  jti: string;
}

export interface RunTokenInput {
  runId: string;
  taskId: string;
  orgId: string;
  attempt: number;
  /** Token hết hạn theo timeout của run. */
  ttlSec: number;
}

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function base64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** Khoá ký run token. HIVE_AUTH_SECRET đã bị config buộc dài ít nhất 32 ký tự khi bật đăng nhập. */
export function runTokenKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "", "xdev-hive run token v1", 32));
}

/** `aud` của run token: cổng MCP của hub này, để token không dùng được ở dịch vụ khác (RFC 8707). */
export const mcpAudience = (publicUrl: string) => `${publicUrl.replace(/\/+$/, "")}/mcp`;

export function signRunToken(
  key: Buffer,
  publicUrl: string,
  input: RunTokenInput,
  now = Date.now(),
): { token: string; claims: RunTokenClaims } {
  const iat = Math.floor(now / 1000);
  const claims: RunTokenClaims = {
    iss: publicUrl.replace(/\/+$/, ""),
    aud: mcpAudience(publicUrl),
    sub: `run:${input.runId}`,
    run_id: input.runId,
    task_id: input.taskId,
    org_id: input.orgId,
    attempt: input.attempt,
    iat,
    exp: iat + input.ttlSec,
    jti: randomUUID(),
  };
  const body = `${HEADER}.${base64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return { token: `${body}.${sig}`, claims };
}

export type RunTokenVerifier = (token: string) => RunTokenClaims | null;

/**
 * Hàm xác thực run token cho cổng MCP. Trả null khi chữ ký sai, sai `aud`, sai `iss` hay đã hết hạn; không phân biệt
 * lý do để người dò không biết token nào gần đúng. Chỉ kiểm chữ ký và thời hạn: cổng MCP còn phải kiểm run vẫn đang
 * chạy và attempt khớp (run đã giao lại thì token của attempt cũ phải bị từ chối).
 */
export function createRunTokenVerifier(opts: {
  authSecret: string;
  publicUrl: string;
  now?: () => number;
}): RunTokenVerifier {
  const key = runTokenKey(opts.authSecret);
  const aud = mcpAudience(opts.publicUrl);
  const iss = opts.publicUrl.replace(/\/+$/, "");
  const now = opts.now ?? Date.now;
  return (token) => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts as [string, string, string];
    if (header !== HEADER) return null;
    const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: RunTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RunTokenClaims;
    } catch {
      return null;
    }
    if (claims.aud !== aud || claims.iss !== iss) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return null;
    if (typeof claims.run_id !== "string" || typeof claims.org_id !== "string") return null;
    return claims;
  };
}
