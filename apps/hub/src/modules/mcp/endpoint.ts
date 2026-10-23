import { createMcpHandler, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type pg from "pg";
import { type Auth, mcpResource } from "../identity/index.ts";
import { type ClientRequest, readClientRequest } from "../platform/index.ts";
import { verifyPersonalToken } from "./admin-service.ts";
import { type McpPrincipal, noRunTokens, type RunTokenVerifier } from "./principal.ts";
import type { McpToolRegistry } from "./registry.ts";
import { buildMcpServer } from "./server.ts";

export interface McpEndpointDeps {
  auth: Auth;
  /** Pool của role hive_app: tool chạy trong withTenant. */
  pool: pg.Pool;
  registry: McpToolRegistry;
  version: string;
  runTokens?: RunTokenVerifier | undefined;
  /**
   * Nhận run token và token cá nhân (hub chạy http trong mạng tin cậy): không kiểm OAuth và không quảng bá metadata vì
   * /.well-known không có ở chế độ này.
   */
  runTokensOnly?: boolean | undefined;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

/**
 * 401 kèm WWW-Authenticate trỏ tới protected resource metadata (RFC 9728): client CLI đọc metadata, tìm ra
 * authorization server rồi tự mở luồng đăng nhập. Thân là lỗi JSON-RPC để client MCP hiện được thông báo.
 */
function unauthorized(metadataUrl: string, invalidToken: boolean): Response {
  const params = [`resource_metadata="${metadataUrl}"`];
  if (invalidToken) params.unshift('error="invalid_token"');
  const message = invalidToken ? "Token không hợp lệ hoặc không dành cho cổng MCP này." : "Cần đăng nhập để dùng MCP.";
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer ${params.join(", ")}` },
  });
}

function runTokenRequired(): Response {
  const message = "Cổng MCP qua http chỉ nhận run token hoặc token MCP cá nhân; đăng nhập OAuth cần hub chạy https.";
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer error="invalid_token"' },
  });
}

/**
 * Cổng /mcp theo Streamable HTTP, stateless: mỗi request tự mang token, hub dựng một McpServer riêng cho request
 * đó. Không có phiên MCP nên chạy được nhiều bản hub-api sau proxy mà không cần kho phiên dùng chung.
 */
export function createMcpEndpoint(deps: McpEndpointDeps): (request: Request) => Promise<Response> {
  const { auth, runTokens = noRunTokens, runTokensOnly = false } = deps;
  const resource = mcpResource(String(auth.options.baseURL));
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
  // Lấy JWKS thẳng từ Better Auth trong tiến trình thay vì gọi HTTP tới chính hub qua địa chỉ public (có thể đi
  // vòng qua Cloudflare). Khoá cache cố định để thư viện giữ JWKS theo TTL và chỉ tải lại khi gặp kid lạ.
  const jwksCacheKey = {};
  const jwksFetch = () => auth.api.getJwks();

  async function verifyUserToken(token: string): Promise<McpPrincipal | null> {
    let claims: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
    try {
      // Issuer của access token là baseURL đã gồm basePath (/api/auth), giống mặc định của requireMcpAuth.
      const { baseURL: issuer } = await auth.$context;
      claims = await verifyJwsAccessToken(token, {
        jwksFetch,
        jwksCacheKey,
        verifyOptions: { issuer, audience: resource },
      });
    } catch {
      return null;
    }
    // Token gắn DPoP (cnf.jkt) chỉ hợp lệ kèm bằng chứng DPoP; cổng chưa kiểm DPoP nên không nhận như bearer.
    if (!claims.sub || claims.cnf) return null;
    const clientId = typeof claims.azp === "string" ? claims.azp : (claims.client_id as string | undefined);
    return {
      kind: "user",
      userId: claims.sub,
      clientId,
      scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
    };
  }

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const principal = authInfo?.extra?.principal as McpPrincipal | undefined;
      // Handler chỉ được gọi sau khi đã xác thực; thiếu principal là lỗi lập trình, không phải lỗi người dùng.
      if (!principal) throw new Error("Thiếu principal cho request MCP.");
      return buildMcpServer(deps, principal, authInfo?.extra?.client as ClientRequest | undefined);
    },
    {
      // Vẫn phục vụ client đời 2025 (initialize) theo kiểu stateless: Claude Code, Codex chưa chắc đã lên 2026-07-28.
      legacy: "stateless",
      onerror: (error) => console.error("Cổng MCP lỗi:", error),
    },
  );

  const serve = (request: Request, token: string, principal: McpPrincipal) =>
    handler.fetch(request, {
      authInfo: {
        token,
        clientId: principal.clientId ?? principal.runId ?? "",
        scopes: principal.scopes,
        resource: new URL(resource),
        resourceMetadataUrl: metadataUrl,
        // Header sự kiện client (specs/027): tool có ghi dùng khoá chống trùng, nguồn và máy client khai.
        extra: { principal, client: readClientRequest(request.headers) },
      },
    });

  return async (request) => {
    const token = bearerToken(request);
    if (token?.startsWith("hive_pat_")) {
      const principal = await verifyPersonalToken(deps.pool, deps.registry, token);
      if (!principal) return runTokensOnly ? runTokenRequired() : unauthorized(metadataUrl, true);
      return serve(request, token, principal);
    }
    if (runTokensOnly) {
      const runPrincipal = token ? await runTokens.verify(token) : null;
      return token && runPrincipal ? serve(request, token, runPrincipal) : runTokenRequired();
    }
    if (!token) return unauthorized(metadataUrl, false);
    const principal = (await runTokens.verify(token)) ?? (await verifyUserToken(token));
    if (!principal) return unauthorized(metadataUrl, true);
    return serve(request, token, principal);
  };
}
