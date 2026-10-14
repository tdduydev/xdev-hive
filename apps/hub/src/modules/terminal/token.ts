import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { mcpAudience } from "../runs/index.ts";

/**
 * Token MCP của một phiên terminal Leader: JWT HS256 hub cấp khi mở phiên, worker ghi vào file `--mcp-config` của
 * Claude. Khoá suy từ HIVE_AUTH_SECRET bằng nhãn HKDF riêng, nên không thay được run token hay cookie phiên và ngược
 * lại. Token chỉ là chìa vào cổng MCP: cổng còn kiểm phiên đang chạy và người mở vẫn còn vai trò (mcp-tokens.ts).
 */
export interface TerminalTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  typ: "terminal";
  session_id: string;
  org_id: string;
  user_id: string;
  iat: number;
  exp: number;
  jti: string;
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

/** Phiên sống tối đa chừng này; quá hạn thì Leader mất cổng MCP và người mở mở phiên mới. */
export const TERMINAL_TOKEN_TTL_SEC = 24 * 60 * 60;

export function terminalTokenKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "", "xdev-hive terminal token v1", 32));
}

export function signTerminalToken(
  key: Buffer,
  publicUrl: string,
  input: { sessionId: string; orgId: string; userId: string; ttlSec?: number },
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const claims: TerminalTokenClaims = {
    iss: publicUrl.replace(/\/+$/, ""),
    aud: mcpAudience(publicUrl),
    sub: `terminal:${input.sessionId}`,
    typ: "terminal",
    session_id: input.sessionId,
    org_id: input.orgId,
    user_id: input.userId,
    iat,
    exp: iat + (input.ttlSec ?? TERMINAL_TOKEN_TTL_SEC),
    jti: randomUUID(),
  };
  const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** null khi sai chữ ký, sai `aud`/`iss`, không phải token terminal hay đã hết hạn; không nói lý do. */
export function verifyTerminalToken(
  key: Buffer,
  publicUrl: string,
  token: string,
  now = Date.now(),
): TerminalTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== HEADER) return null;
  const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: TerminalTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TerminalTokenClaims;
  } catch {
    return null;
  }
  if (claims.typ !== "terminal" || claims.aud !== mcpAudience(publicUrl)) return null;
  if (claims.iss !== publicUrl.replace(/\/+$/, "")) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  if (typeof claims.session_id !== "string" || typeof claims.org_id !== "string") return null;
  if (typeof claims.user_id !== "string") return null;
  return claims;
}
