import { type CallToolResult, McpServer, type Tool } from "@modelcontextprotocol/server";
import { type ClientEventResult, MCP_IDEMPOTENCY_META } from "@xdev-hive/contracts";
import type pg from "pg";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import {
  BadRequestError,
  type ClientRequest,
  ConflictError,
  ForbiddenError,
  INVALID_KEY_MESSAGE,
  NotFoundError,
  noteMissingKey,
  rejectionOf,
  type Tx,
  withClientEvent,
  withMetaKey,
  withTenant,
} from "../platform/index.ts";
import { disabledTools, requireActivePersonalToken, requireEnabledTool } from "./admin-service.ts";
import { rejectedResult, sourceOf, type ToolOutput, targetOf, toResult } from "./client-event.ts";
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

/** Lần ghi có khoá bị hub từ chối (hay gửi lại lần đã bị từ chối): client đọc `_meta` để không gửi lại nữa. */
class RejectedToolCall extends McpToolError {
  readonly event: ClientEventResult;

  constructor(event: ClientEventResult) {
    super(event.reason ?? "Hub không nhận lần ghi này.");
    this.event = event;
  }
}

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

const NO_CLIENT: ClientRequest = { invalidKey: false, source: "unknown" };

/**
 * Chạy một tool trong withTenant của tổ chức thuộc principal, rồi ghi audit trong cùng transaction. Lời gọi bị từ
 * chối trước khi chọn được tổ chức thì không có dòng audit, vì audit_log luôn thuộc một tổ chức.
 *
 * Tool có ghi mà lời gọi mang khoá chống trùng thì chạy qua `withClientEvent` (specs/027 FR-001): gửi lại cùng khoá
 * nhận kết quả đã lưu thay vì ghi lần hai. Chỉ lỗi handler ném vì trạng thái dữ liệu mới thành lần từ chối được lưu;
 * lỗi quyền, token hay tool bị tắt xảy ra trước handler thì không để lại dòng, để client sửa xong gửi lại được.
 */
async function runTool(
  deps: McpServerDeps,
  principal: McpPrincipal,
  tool: McpTool<z.ZodObject, unknown>,
  raw: Record<string, unknown>,
  request: ClientRequest = NO_CLIENT,
): Promise<ToolOutput> {
  const { org, ...args } = raw as { org?: string } & Record<string, unknown>;
  const { pool, registry } = deps;
  // Chạy như client cũ khi khoá sai dạng thì lần gửi lại sẽ ghi thêm một lần nữa.
  if (tool.writes && request.invalidKey) throw new McpToolError(INVALID_KEY_MESSAGE);
  const key = tool.writes ? request.key : undefined;
  if (tool.writes && !key) noteMissingKey(tool.name, request.client);
  let orgId: string;
  if (principal.kind === "run" || principal.personalTokenId || principal.terminal) {
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
    // Mỗi lần Leader trong terminal gọi tool đều có dòng audit gắn phiên và chế độ (Bypass không qua duyệt).
    ...(principal.terminal
      ? { terminalSessionId: principal.terminal.sessionId, terminalMode: principal.terminal.mode }
      : {}),
  };
  const tenant = { userId: principal.userId, orgId };
  try {
    // Kiểm trước prepare để tool bị tắt không gọi dịch vụ ngoài; kiểm lại lúc thực thi để không dùng trạng thái cũ.
    const machineId = await withTenant(pool, tenant, async (tx) => {
      await requireEnabledTool(tx, tool.name);
      // Máy client tự khai chỉ được ghi khi là máy của người gọi; máy lạ thì bỏ, không từ chối lần ghi.
      return key && request.machineId ? registry.clientMachine(tx, principal.userId, request.machineId) : null;
    });
    const prepared = tool.prepare ? await tool.prepare(args) : undefined;
    const after: Array<() => void> = [];
    const execute = async (tx: Tx) => {
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
      let result: unknown;
      try {
        result = await tool.handler(
          args,
          { tx, orgId, principal, afterCommit: (fn: () => void) => after.push(fn) },
          prepared,
        );
      } catch (error) {
        throw (key && rejectionOf(error)) || error;
      }
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
    };
    if (!key) {
      const value = await withTenant(pool, tenant, execute);
      for (const fn of after) fn();
      return { value };
    }
    const { response, ...event } = await withClientEvent(
      pool,
      tenant,
      {
        key,
        source: sourceOf(principal, request),
        kind: tool.name,
        machineId: machineId ?? undefined,
        userId: principal.userId,
        ...targetOf(principal, args),
        clientCreatedAt: request.clientCreatedAt,
      },
      execute,
    );
    // Lần từ chối đã rollback cả phần handler ghi; lần trùng không chạy handler: việc sau commit chỉ của lần nhận.
    if (event.outcome === "accepted") for (const fn of after) fn();
    if (event.code) throw new RejectedToolCall(event);
    return { value: response, event };
  } catch (error) {
    // Transaction lỗi đã rollback; ghi số lỗi riêng, không lưu thông báo nội bộ hay tham số có thể chứa secret.
    await withTenant(pool, tenant, (tx) =>
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

function toError(error: unknown): CallToolResult {
  if (error instanceof RejectedToolCall) {
    return rejectedResult(error.event, error.message);
  }
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
export async function buildMcpServer(
  deps: McpServerDeps,
  principal: McpPrincipal,
  client: ClientRequest = NO_CLIENT,
): Promise<McpServer> {
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
    principal.kind === "run" || principal.terminal ? tool.input : tool.input.extend({ org: ORG_PARAM });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: inputFor(tool),
        annotations: { readOnlyHint: tool.readOnly ?? false },
      },
      async (args, ctx) => {
        try {
          const request = withMetaKey(client, ctx.mcpReq._meta?.[MCP_IDEMPOTENCY_META]);
          return toResult(await runTool(deps, principal, tool, args as Record<string, unknown>, request));
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
