import {
  type ArtifactOrigin,
  type ArtifactToolResult,
  artifactToolCreate,
  artifactToolGet,
  artifactToolList,
  artifactToolUpdate,
  artifactWebPath,
} from "@xdev-hive/contracts";
import type pg from "pg";
import { findProject } from "../catalog/index.ts";
import type { McpPrincipal, McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ForbiddenError, type Jobs, type Tx } from "../platform/index.ts";
import { artifactError, type Reader, readerFor } from "./access.ts";
import { terminalHostOf, threadHostOf } from "./hooks.ts";
import { createArtifact, getArtifact, linkInternal, listArtifacts, updateArtifact } from "./service.ts";
import { isSecretBlocked, recordSecretBlocked } from "./versions.ts";

/*
 * Bốn tool MCP `artifact_*` (plan.md D9, FR-030…FR-033). Tool chỉ đổi principal MCP về `Reader` rồi gọi cùng hàm
 * nghiệp vụ với route, nên quyền và giới hạn đi một đường (SC-002).
 */

export interface ArtifactMcpDeps {
  /** Ghi audit `artifact.secret.blocked` bằng transaction riêng, vì transaction của tool rollback cùng lỗi. */
  pool?: pg.Pool | undefined;
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
}

/** Run có đầu ra riêng (kết quả doccheck, bản nháp docassist, bản tóm tắt brief), không tạo hay sửa artifact. */
const RUN_KINDS_WITHOUT_ARTIFACTS = new Set(["doccheck", "docassist", "brief"]);

// Run `leader` tạo và sửa theo cuộc trò chuyện nhưng hub không lưu run ↔ cuộc trò chuyện, nên `get`/`update` nhận thêm
// `threadId` (kiểm bằng assertRunThread) để đọc được artifact liên kết `chat_thread` của cuộc trò chuyện đó (FR-032).
const threadId = artifactToolCreate.shape.threadId;
const updateInput = artifactToolUpdate.extend({ threadId });
const getInput = artifactToolGet.extend({ threadId });

interface Caller {
  reader: Reader;
  /** Cuộc trò chuyện đã kiểm của run `leader`; null khi không truyền. */
  threadId: string | null;
  /** Phiên terminal đã kiểm của principal; null khi không có. */
  terminalSessionId: string | null;
  origin: ArtifactOrigin;
}

const linkForbidden = (message?: string) => artifactError("ARTIFACT_LINK_FORBIDDEN", message);

/**
 * `strict`: tạo/sửa/đọc — `threadId` và `terminalSessionId` phải thuộc principal (FR-033). Danh sách chỉ dùng chúng làm
 * bộ lọc nên người không phải Leader truyền `threadId` vẫn được lọc, không được thêm quyền.
 */
async function callerOf(
  tx: Tx,
  principal: McpPrincipal,
  input: { threadId?: string | undefined; terminalSessionId?: string | undefined },
  strict = true,
): Promise<Caller> {
  if (principal.kind === "run") {
    if (!principal.runId || !principal.runKind || !principal.projectId)
      throw new ForbiddenError("RUN_TOKEN_INVALID", "Run token thiếu run hoặc dự án.");
    if (RUN_KINDS_WITHOUT_ARTIFACTS.has(principal.runKind)) throw artifactError("ARTIFACT_RUN_KIND");
    if (input.terminalSessionId && strict) throw linkForbidden("Run không gắn artifact vào phiên terminal.");
    let owner = principal.userId;
    let thread: string | null = null;
    if (input.threadId && (strict || principal.runKind === "leader")) {
      const host = threadHostOf();
      if (principal.runKind !== "leader" || !host)
        throw linkForbidden("Chỉ run leader gắn artifact vào cuộc trò chuyện.");
      // Chủ của artifact riêng là người mở cuộc trò chuyện, không phải người chạy run (FR-032).
      owner = (await host.assertRunThread(tx, principal.runId, input.threadId)).userId;
      thread = input.threadId;
    }
    const reader = await readerFor(tx, {
      kind: "run",
      runId: principal.runId,
      runKind: principal.runKind,
      projectId: principal.projectId,
      userId: owner,
      taskId: principal.taskId ?? null,
      threadId: thread,
    });
    return {
      reader,
      threadId: thread,
      terminalSessionId: null,
      origin: principal.runKind === "leader" ? "leader" : "run",
    };
  }
  if (input.threadId && strict) throw linkForbidden("Chỉ run leader gắn artifact vào cuộc trò chuyện.");
  const terminalSessionId = input.terminalSessionId ?? principal.terminal?.sessionId ?? null;
  if (terminalSessionId && strict) {
    // Token của chính phiên đã chứng minh quyền sở hữu; phiên khác phải do module terminal xác nhận.
    if (principal.terminal?.sessionId !== terminalSessionId) {
      const host = terminalHostOf();
      if (!host) throw linkForbidden("Chưa hỗ trợ gắn artifact vào phiên terminal.");
      await host.assertOwner(tx, terminalSessionId, principal.userId);
    }
  }
  return {
    reader: await readerFor(tx, { kind: "user", userId: principal.userId }),
    threadId: null,
    terminalSessionId: strict ? terminalSessionId : null,
    origin: terminalSessionId ? "terminal" : "mcp",
  };
}

/**
 * Lỗi nghiệp vụ mang chi tiết (bản mới nhất khi xung đột, dòng bí mật, giới hạn) được ghép vào câu lỗi, vì cổng MCP chỉ
 * trả `message` cho agent. Bí mật còn được ghi audit ngay đây vì transaction của tool sắp rollback.
 */
async function withDetail<T>(
  ctx: { orgId: string; principal: McpPrincipal },
  deps: ArtifactMcpDeps,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isSecretBlocked(error) && deps.pool)
      await recordSecretBlocked(
        deps.pool,
        { orgId: ctx.orgId, userId: ctx.principal.userId, runId: ctx.principal.runId },
        error,
      );
    const detail = (error as { detail?: unknown }).detail;
    if (error instanceof Error && detail) error.message = `${error.message} ${JSON.stringify(detail)}`;
    throw error;
  }
}

const result = (written: {
  artifact: { id: string };
  version: { version: number };
  compileError: string | null;
}): ArtifactToolResult => ({
  id: written.artifact.id,
  version: written.version.version,
  url: artifactWebPath(written.artifact.id, written.version.version),
  ...(written.compileError ? { compileError: written.compileError } : {}),
});

/**
 * Cả bốn tool khai `readOnly`: ghi artifact là ghi dữ liệu hub chứ không ghi repo, và run leader, plan, review chạy Claude
 * Code ở chế độ plan, nơi tool MCP chỉ gọi được khi có readOnlyHint (như `leader_reply`, `plan_submit`). Quyền ghi thật
 * nằm ở `Reader`, không ở gợi ý này.
 */
export function registerMcpTools(registry: McpToolRegistry, deps: ArtifactMcpDeps = {}): void {
  const write = { jobs: deps.jobs, publicUrl: deps.publicUrl };

  registry.register({
    name: "artifact_create",
    title: "Tạo artifact",
    description:
      "Tạo artifact (markdown, mã, html, mermaid, react) cho người dùng xem. Mặc định riêng tư; run có thể `scope: project`. Run leader truyền `threadId` để hiện thẻ trong chat; `duplicateOf` để sửa bản chỉ đọc. Không đưa bí mật vào nội dung.",
    input: artifactToolCreate,
    forLeader: true,
    readOnly: true,
    handler: async (input, { tx, orgId, principal }) =>
      withDetail({ orgId, principal }, deps, async () => {
        const caller = await callerOf(tx, principal, input);
        const { reader } = caller;
        if (reader.kind === "user" && input.scope === "project")
          throw new BadRequestError(
            "ARTIFACT_SCOPE_PROJECT_RUN_ONLY",
            "Tool chỉ tạo artifact riêng tư cho người dùng; chia sẻ cho dự án bằng giao diện web.",
          );
        // Phạm vi dự án của run lấy từ run, không từ tham số (FR-032); contract đòi khoá dự án nên tra từ id.
        const projectKey =
          reader.kind === "run" && input.scope === "project" && !input.duplicateOf
            ? (await findProject(tx, reader.projectId))?.key
            : undefined;
        const written = await createArtifact(
          tx,
          reader,
          {
            type: input.type,
            title: input.title,
            content: input.content,
            ...(input.language ? { language: input.language } : {}),
            // Bản nhân bản luôn riêng tư của người mở cuộc trò chuyện, người xem chỉ đọc sửa bản của mình (US9-5).
            scope: input.duplicateOf ? "private" : (input.scope ?? "private"),
            ...(projectKey ? { projectKey } : {}),
            ...(input.message ? { message: input.message } : {}),
            ...(input.duplicateOf ? { duplicateOf: input.duplicateOf } : {}),
          },
          {
            ...write,
            origin: caller.origin,
            ...(principal.terminal ? { originProjectId: principal.terminal.projectId } : {}),
          },
        );
        const artifact = { id: written.artifact.id, orgId };
        // Liên kết run do createArtifact tự thêm; ở đây thêm task, cuộc trò chuyện, phiên terminal của chính người gọi.
        if (reader.kind === "run" && reader.taskId)
          await linkInternal(tx, reader, artifact, { kind: "task", id: reader.taskId });
        if (caller.threadId) {
          await linkInternal(tx, reader, artifact, { kind: "chat_thread", id: caller.threadId });
          // threadHostOf() có giá trị vì callerOf đã dùng nó để kiểm cuộc trò chuyện.
          await threadHostOf()?.postArtifactCard(tx, {
            threadId: caller.threadId,
            artifactId: written.artifact.id,
            version: written.version.version,
            title: written.artifact.title,
            runId: reader.kind === "run" ? reader.runId : null,
          });
        }
        if (caller.terminalSessionId)
          await linkInternal(tx, reader, artifact, { kind: "terminal_session", id: caller.terminalSessionId });
        return result(written);
      }),
  });

  registry.register({
    name: "artifact_update",
    title: "Sửa artifact",
    description:
      "Lưu phiên bản mới (nội dung đầy đủ). Truyền `baseVersion` đã đọc; có bản mới hơn thì lỗi kèm bản mới nhất để gộp rồi lưu lại. Run leader truyền `threadId`.",
    input: updateInput,
    forLeader: true,
    readOnly: true,
    handler: async (input, { tx, orgId, principal }) =>
      withDetail({ orgId, principal }, deps, async () => {
        const { reader, origin, threadId } = await callerOf(tx, principal, input);
        const { threadId: _thread, ...rest } = input;
        const written = await updateArtifact(tx, reader, rest, { ...write, origin });
        // FR-040: sửa từ cuộc trò chuyện cũng thêm thẻ phiên bản mới và gắn cuộc trò chuyện (gắn trùng thì bỏ qua).
        if (threadId) {
          await linkInternal(tx, reader, { id: written.artifact.id, orgId }, { kind: "chat_thread", id: threadId });
          await threadHostOf()?.postArtifactCard(tx, {
            threadId,
            artifactId: written.artifact.id,
            version: written.version.version,
            title: written.artifact.title,
            runId: reader.kind === "run" ? reader.runId : null,
          });
        }
        return result(written);
      }),
  });

  registry.register({
    name: "artifact_get",
    title: "Đọc artifact",
    description: "Đọc một phiên bản artifact (mặc định mới nhất) và quyền của bạn trên nó.",
    input: getInput,
    forLeader: true,
    readOnly: true,
    handler: async (input, { tx, principal }) => {
      const { reader } = await callerOf(tx, principal, input);
      return getArtifact(tx, reader, { id: input.id, ...(input.version ? { version: input.version } : {}) });
    },
  });

  registry.register({
    name: "artifact_list",
    title: "Liệt kê artifact",
    description:
      "Liệt kê artifact bạn đọc được, mới sửa trước; lọc bằng `query`, `type`, `scope`, `mine`…; `cursor` để đọc trang sau.",
    input: artifactToolList,
    forLeader: true,
    readOnly: true,
    handler: async (input, { tx, principal }) => {
      const { reader } = await callerOf(tx, principal, input, false);
      return listArtifacts(tx, reader, input);
    },
  });
}
