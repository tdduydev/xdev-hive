import { type CallToolResult, McpServer, type Tool } from "@modelcontextprotocol/server";
import type pg from "pg";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, withTenant } from "../platform/index.ts";
import { disabledTools, requireActivePersonalToken, requireEnabledTool } from "./admin-service.ts";
import type { McpPrincipal } from "./principal.ts";
import type { McpOrgMembership, McpTool, McpToolRegistry } from "./registry.ts";

export interface McpServerDeps {
  pool: pg.Pool;
  registry: McpToolRegistry;
  version: string;
}

const ORG_PARAM = z.string().min(1).optional().describe("Mã hoặc slug tổ chức khi thuộc nhiều tổ chức.");

/** Lỗi trả về cho agent dưới dạng kết quả tool (isError), không phải lỗi giao thức. */
class McpToolError extends Error {}

const describe = (orgs: McpOrgMembership[]) => orgs.map((o) => `${o.slug} (${o.name})`).join(", ");

function pickOrg(orgs: McpOrgMembership[], requested: string | undefined): McpOrgMembership {
  if (requested) {
    const found = orgs.find((o) => o.id === requested || o.slug === requested);
    if (!found) throw new McpToolError(`Bạn không phải thành viên của tổ chức "${requested}".`);
    return found;
  }
  const [only, ...rest] = orgs;
  if (!only) throw new McpToolError("Bạn chưa thuộc tổ chức nào trên hub.");
  if (rest.length > 0)
    throw new McpToolError(`Bạn thuộc nhiều tổ chức, hãy truyền tham số org. Các tổ chức: ${describe(orgs)}.`);
  return only;
}

/**
 * Chạy một tool trong withTenant của tổ chức thuộc principal, rồi ghi audit trong cùng transaction. Lời gọi bị từ
 * chối trước khi chọn được tổ chức thì không có dòng audit, vì audit_log luôn thuộc một tổ chức.
 */
async function runTool(
  deps: McpServerDeps,
  principal: McpPrincipal,
  tool: McpTool<z.ZodObject, unknown>,
  raw: Record<string, unknown>,
) {
  const { org, ...args } = raw as { org?: string } & Record<string, unknown>;
  const { pool, registry } = deps;
  let orgId: string;
  if (principal.kind === "run" || principal.personalTokenId) {
    if (!principal.orgId) throw new McpToolError("Token thiếu tổ chức.");
    if (org && org !== principal.orgId) throw new McpToolError("Token chỉ được làm việc trong tổ chức của nó.");
    orgId = principal.orgId;
  } else {
    // Chưa có tổ chức trong context: RLS chỉ cho thấy tư cách thành viên của chính người gọi.
    const orgs = await withTenant(pool, { userId: principal.userId }, (tx) =>
      registry.memberships(tx, principal.userId),
    );
    orgId = pickOrg(orgs, org).id;
  }
  const auditData = {
    via: principal.kind,
    clientId: principal.clientId ?? null,
    ...(principal.runId ? { runId: principal.runId } : {}),
    ...(principal.personalTokenId ? { tokenId: principal.personalTokenId } : {}),
  };
  try {
    // Kiểm trước prepare để tool bị tắt không gọi dịch vụ ngoài; kiểm lại lúc thực thi để không dùng trạng thái cũ.
    await withTenant(pool, { userId: principal.userId, orgId }, (tx) => requireEnabledTool(tx, tool.name));
    const prepared = tool.prepare ? await tool.prepare(args) : undefined;
    return await withTenant(pool, { userId: principal.userId, orgId }, async (tx) => {
      // Xét lại trong transaction sẽ chạy tool: RLS chỉ lọc theo tổ chức trong context, không theo tư cách thành viên,
      // và người dùng có thể vừa bị khoá giữa hai transaction.
      if (
        principal.kind === "user" &&
        !(await registry.memberships(tx, principal.userId)).some((o) => o.id === orgId)
      ) {
        throw new McpToolError("Bạn không còn là thành viên của tổ chức này.");
      }
      await requireActivePersonalToken(tx, principal);
      await requireEnabledTool(tx, tool.name);
      const result = await tool.handler(args, { tx, orgId, principal }, prepared);
      await recordAudit(tx, {
        action: `mcp.${tool.name}`,
        targetType: "mcp_tool",
        targetId: tool.name,
        data: {
          args,
          ...auditData,
          outcome: "success",
        },
      });
      return result;
    });
  } catch (error) {
    // Transaction lỗi đã rollback; ghi số lỗi riêng, không lưu thông báo nội bộ hay tham số có thể chứa secret.
    await withTenant(pool, { userId: principal.userId, orgId }, (tx) =>
      recordAudit(tx, {
        action: `mcp.${tool.name}`,
        targetType: "mcp_tool",
        targetId: tool.name,
        data: { ...auditData, outcome: "error" },
      }),
    );
    throw error;
  }
}

function toResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toError(error: unknown): CallToolResult {
  const known =
    error instanceof McpToolError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError;
  if (!known) console.error("Tool MCP lỗi:", error);
  // Lỗi lạ có thể chứa chi tiết nội bộ (câu SQL, đường dẫn); agent chỉ cần biết là hỏng.
  const text = known ? error.message : "Lỗi nội bộ khi chạy tool. Thử lại sau hoặc báo quản trị hub.";
  return { isError: true, content: [{ type: "text", text }] };
}

/** Một McpServer cho một request: cổng chạy stateless nên mỗi request dựng server riêng, gắn sẵn principal. */
export async function buildMcpServer(deps: McpServerDeps, principal: McpPrincipal): Promise<McpServer> {
  const server = new McpServer({ name: "xdev-hive", version: deps.version });
  const orgs = principal.orgId
    ? [{ id: principal.orgId }]
    : await withTenant(deps.pool, { userId: principal.userId }, (tx) =>
        deps.registry.memberships(tx, principal.userId),
      );
  const disabled = new Set<string>();
  // tools/list không có tham số org: OAuth nhiều tổ chức chỉ quảng bá tool được bật trong mọi tổ chức của người gọi.
  for (const org of orgs) {
    const names = await withTenant(deps.pool, { userId: principal.userId, orgId: org.id }, disabledTools);
    for (const name of names) disabled.add(name);
  }
  const tools = deps.registry.list(principal);
  const inputFor = (tool: McpTool<z.ZodObject, unknown>) =>
    principal.kind === "run" ? tool.input : tool.input.extend({ org: ORG_PARAM });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: inputFor(tool),
        annotations: { readOnlyHint: tool.readOnly ?? false },
      },
      async (args) => {
        try {
          return toResult(await runTool(deps, principal, tool, args as Record<string, unknown>));
        } catch (error) {
          return toError(error);
        }
      },
    );
  }
  // Giữ handler để lời gọi trực tiếp bị tắt vẫn được kiểm quyền, trả lỗi tiếng Việt và ghi audit.
  // Chỉ thay danh sách quảng bá qua API công khai của SDK; SDK vẫn kiểm schema đầu vào cho tools/call.
  server.server.setRequestHandler("tools/list", () => ({
    tools: tools
      .filter((tool) => !disabled.has(tool.name))
      .map(
        (tool): Tool => ({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: z.toJSONSchema(inputFor(tool), { io: "input" }) as Tool["inputSchema"],
          annotations: { readOnlyHint: tool.readOnly ?? false },
        }),
      ),
  }));
  return server;
}
