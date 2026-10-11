import {
  DOC_MAX_CHARS,
  docKey,
  memoryContent,
  memoryFiles,
  memoryKind,
  projectRef,
  skillName,
} from "@xdev-hive/contracts";
import { z } from "zod";
import { findProject } from "../catalog/index.ts";
import type { McpPrincipal, McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { loadTask } from "../tasks/index.ts";
import type { Principal } from "./access.ts";
import { getDoc, listDocs } from "./docs.ts";
import { embedQuery, type KnowledgeDeps, searchMemory, writeMemory } from "./memory.ts";
import { proposeDoc } from "./proposals.ts";
import { getSkill, listSkills } from "./skills.ts";

/**
 * Giới hạn kết quả trả cho agent. Kết quả tool đi thẳng vào context của mô hình, nên trả có chừng mực và cho cách
 * đọc tiếp (offset) thay vì đổ nguyên tài liệu 200k ký tự.
 */
export const MCP_LIMITS = {
  searchDefault: 8,
  searchMax: 20,
  listMax: 200,
  pageChars: 40_000,
} as const;

/**
 * Đổi principal của cổng MCP về principal của knowledge. Run làm việc trong dự án của task của nó: lấy dự án từ task
 * trong cùng transaction, để run không tự khai dự án khác.
 */
async function knowledgePrincipal(tx: Tx, p: McpPrincipal): Promise<Principal> {
  if (p.kind === "user") return { kind: "user", userId: p.userId };
  if (!p.runId || !p.taskId) throw new ForbiddenError("RUN_TOKEN_INVALID", "Run token thiếu run hoặc task.");
  const task = await loadTask(tx, p.taskId);
  if (!task) throw new ForbiddenError("RUN_PROJECT_MISSING", "Run không còn thuộc dự án nào trong tổ chức.");
  return { kind: "run", runId: p.runId, projectId: task.projectId };
}

/** Cắt nội dung dài thành trang; agent gọi lại với nextOffset để đọc tiếp. */
function page(content: string, offset: number) {
  const slice = content.slice(offset, offset + MCP_LIMITS.pageChars);
  const end = offset + slice.length;
  return { content: slice, offset, totalChars: content.length, nextOffset: end < content.length ? end : null };
}

function capped<T>(items: T[]) {
  return { items: items.slice(0, MCP_LIMITS.listMax), truncated: items.length > MCP_LIMITS.listMax };
}

const PROJECT = projectRef
  .optional()
  .describe("Project key (ghi trong AGENTS.md) hoặc id dự án. Trong run bỏ trống để dùng dự án của run.");
const OFFSET = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(`Đọc tiếp từ ký tự này (nextOffset của lần gọi trước). Mỗi lần trả tối đa ${MCP_LIMITS.pageChars} ký tự.`);

const notFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");

/** Tool memory, tài liệu, skill cho agent. Cổng MCP đã chọn tổ chức, mở withTenant và sẽ ghi audit. */
export function registerMcpTools(registry: McpToolRegistry, deps: KnowledgeDeps = {}): void {
  registry.register({
    name: "memory_search",
    title: "Tìm memory",
    description:
      "Tìm memory (quyết định, quy ước, cái bẫy, ghi chú) của dự án, đội và tổ chức, theo từ và theo nghĩa. Gọi ở " +
      "đầu phiên làm việc và trước khi quyết định điều gì. Trong run mặc định tìm trong dự án của run. " +
      `Trả tối đa ${MCP_LIMITS.searchMax} kết quả, mỗi memory tối đa 2000 ký tự.`,
    input: z.object({
      project: PROJECT,
      query: z.string().trim().min(1).max(500).describe("Câu hoặc từ khoá cần tìm."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MCP_LIMITS.searchMax)
        .optional()
        .describe(`Số kết quả, mặc định ${MCP_LIMITS.searchDefault}.`),
    }),
    readOnly: true,
    // Gọi API embeddings trước, ngoài transaction, như router của knowledge.
    prepare: ({ query }) => embedQuery(deps.embedder, query),
    handler: async ({ project, query, limit }, { tx, principal }, queryEmbedding) => {
      const hits = await searchMemory(
        tx,
        await knowledgePrincipal(tx, principal),
        { project, query, limit: limit ?? MCP_LIMITS.searchDefault },
        { embedder: deps.embedder, queryEmbedding },
      );
      return {
        hits: hits.map((m) => ({
          id: m.id,
          kind: m.kind,
          scope: m.scope.level,
          content: m.content,
          files: m.files,
          createdAt: m.createdAt,
          author: m.author,
        })),
      };
    },
  });

  registry.register({
    name: "memory_write",
    title: "Ghi memory",
    description:
      "Ghi một memory ngắn cho lần sau: quyết định đã chốt (decision), quy ước (convention), cái bẫy (gotcha), ghi " +
      "chú (note). Mỗi memory một ý, tối đa 2000 ký tự, nêu cả lý do. Trong run ghi vào dự án của run và không ghi " +
      "được sang dự án khác; ngoài run phải truyền project.",
    input: z.object({
      project: PROJECT,
      kind: memoryKind.describe("decision | convention | gotcha | note"),
      content: memoryContent.describe("Nội dung memory, tối đa 2000 ký tự."),
      files: memoryFiles.optional().describe("Đường dẫn file liên quan trong repo (tối đa 50)."),
    }),
    handler: async ({ project, kind, content, files }, { tx, principal }) => {
      const who = await knowledgePrincipal(tx, principal);
      let scope: { level: "project"; projectId: string } | undefined;
      if (project) {
        const p = await findProject(tx, project);
        if (!p) throw notFound();
        // writeMemory còn kiểm quyền: run chỉ được dự án của nó, người dùng phải là thành viên đội.
        scope = { level: "project", projectId: p.id };
      } else if (who.kind === "user") {
        throw new BadRequestError("PROJECT_REQUIRED", "Cần truyền project (project key) khi gọi ngoài run.");
      }
      const m = await writeMemory(tx, who, { scope, kind, content, files: files ?? [] }, deps);
      return { id: m.id, kind: m.kind, scope: m.scope, createdAt: m.createdAt, author: m.author };
    },
  });

  registry.register({
    name: "doc_list",
    title: "Danh sách tài liệu",
    description:
      "Liệt kê tài liệu đọc được (key, tiêu đề, phiên bản), không kèm nội dung. Key có dạng org/..., team/<đội>/..., " +
      `project/<project key>/...; lọc bằng prefix. Trong run chỉ có tài liệu áp dụng cho dự án của run. Tối đa ${MCP_LIMITS.listMax} mục.`,
    input: z.object({
      prefix: z.string().max(200).optional().describe("Tiền tố của key, vd. project/hoa-don/ hoặc org/."),
    }),
    readOnly: true,
    handler: async ({ prefix }, { tx, principal }) => {
      const docs = await listDocs(tx, await knowledgePrincipal(tx, principal), { prefix });
      const { items, truncated } = capped(docs);
      return {
        docs: items.map((d) => ({ key: d.key, title: d.title, version: d.version, updatedAt: d.updatedAt })),
        truncated,
      };
    },
  });

  registry.register({
    name: "doc_get",
    title: "Đọc tài liệu",
    description:
      "Đọc tài liệu theo key, bản mới nhất. Ghi lại version để làm baseVersion khi gọi doc_propose. Tài liệu dài " +
      `được chia trang ${MCP_LIMITS.pageChars} ký tự; gọi lại với offset = nextOffset để đọc tiếp.`,
    input: z.object({ key: docKey.describe("Key tài liệu, lấy từ doc_list."), offset: OFFSET }),
    readOnly: true,
    handler: async ({ key, offset }, { tx, principal }) => {
      const d = await getDoc(tx, await knowledgePrincipal(tx, principal), { key });
      return {
        key: d.key,
        title: d.title,
        version: d.version,
        updatedAt: d.updatedAt,
        ...page(d.content, offset ?? 0),
      };
    },
  });

  registry.register({
    name: "doc_propose",
    title: "Đề xuất sửa tài liệu",
    description:
      "Đề xuất nội dung mới cho một tài liệu (hoặc tạo tài liệu mới với baseVersion 0). Agent không sửa tài liệu " +
      "trực tiếp: quản trị đội duyệt rồi mới thành phiên bản mới. content là toàn bộ nội dung mới, không phải diff. " +
      "baseVersion lệch bản hiện tại thì bị từ chối: đọc lại bằng doc_get rồi đề xuất lại.",
    input: z.object({
      key: docKey.describe("Key tài liệu."),
      baseVersion: z.number().int().min(0).describe("version đọc được từ doc_get; 0 khi tạo tài liệu mới."),
      content: z
        .string()
        .max(DOC_MAX_CHARS)
        .describe(`Toàn bộ nội dung mới (Markdown), tối đa ${DOC_MAX_CHARS} ký tự.`),
      note: z.string().trim().min(1).max(2000).describe("Vì sao cần sửa, cho người duyệt đọc."),
    }),
    handler: async ({ key, baseVersion, content, note }, { tx, principal }) => {
      const p = await proposeDoc(tx, await knowledgePrincipal(tx, principal), {
        key,
        baseVersion,
        content,
        reason: note,
      });
      return { proposalId: p.id, status: p.status, key: p.target, baseVersion: p.baseVersion };
    },
  });

  registry.register({
    name: "skill_list",
    title: "Danh sách skill",
    description:
      "Liệt kê skill (tên, mô tả). Trong run trả bộ skill áp dụng cho dự án của run: trùng tên thì skill của dự án " +
      `thắng skill của đội, của đội thắng của tổ chức. Đọc nội dung bằng skill_get. Tối đa ${MCP_LIMITS.listMax} mục.`,
    input: z.object({
      project: PROJECT.describe("Ngoài run: project key để lấy bộ skill áp dụng cho dự án đó. Trong run bỏ trống."),
    }),
    readOnly: true,
    handler: async ({ project }, { tx, principal }) => {
      const skills = await listSkills(tx, await knowledgePrincipal(tx, principal), { project });
      const { items, truncated } = capped(skills);
      return {
        skills: items.map((s) => ({
          name: s.name,
          description: s.description,
          scope: s.scope.level,
          version: s.version,
        })),
        truncated,
      };
    },
  });

  registry.register({
    name: "skill_get",
    title: "Đọc skill",
    description:
      "Đọc nội dung SKILL.md theo tên. Trong run lấy skill áp dụng cho dự án của run; ngoài run truyền project, bỏ " +
      `trống thì chỉ tìm skill cấp tổ chức. Nội dung dài được chia trang ${MCP_LIMITS.pageChars} ký tự.`,
    input: z.object({
      name: skillName.describe("Tên skill, lấy từ skill_list."),
      project: PROJECT,
      offset: OFFSET,
    }),
    readOnly: true,
    handler: async ({ name, project, offset }, { tx, principal }) => {
      const s = await getSkill(tx, await knowledgePrincipal(tx, principal), { name, project });
      return {
        name: s.name,
        description: s.description,
        scope: s.scope.level,
        version: s.version,
        ...page(s.content, offset ?? 0),
      };
    },
  });
}
