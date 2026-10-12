import {
  DOC_MAX_CHARS,
  docKey,
  memoryContent,
  memoryFiles,
  memoryKind,
  projectRef,
  SKILL_MAX_CHARS,
  type SkillSummary,
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
import { createProposal } from "./proposals.ts";
import { proposeWithReview } from "./reviews.ts";
import { parseSkillFile } from "./skill-repo.ts";
import { getSkill, listSkillsWithHidden } from "./skills.ts";

/**
 * Giới hạn kết quả trả cho agent. Kết quả tool đi thẳng vào context của mô hình, nên trả có chừng mực và cho cách
 * đọc tiếp (offset) thay vì đổ nguyên tài liệu 200k ký tự.
 */
export const MCP_LIMITS = {
  searchDefault: 5,
  searchMax: 20,
  listDefault: 10,
  listMax: 50,
  pageChars: 8000,
  memoryChars: 500,
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

/** Giữ offset để client cũ vẫn đọc tiếp được tài liệu và skill. */
function page(content: string, offset: number, maxChars = MCP_LIMITS.pageChars as number) {
  const slice = content.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  return {
    content: slice,
    offset,
    totalChars: content.length,
    truncated: end < content.length,
    nextOffset: end < content.length ? end : null,
  };
}

function capped<T>(items: T[], limit = MCP_LIMITS.listDefault as number, offset = 0) {
  const end = offset + limit;
  const truncated = items.length > end;
  return { items: items.slice(offset, end), truncated, nextOffset: truncated ? end : null };
}

const PROJECT = projectRef.optional().describe("Dự án; mặc định là dự án của run.");
const OFFSET = z.number().int().min(0).optional().describe("Vị trí đọc tiếp từ nextOffset.");
const LIST_OFFSET = z.number().int().min(0).optional().describe("Vị trí bắt đầu danh sách.");
const LIMIT = z.number().int().min(1).max(MCP_LIMITS.listMax).optional().describe("Số mục; mặc định 10.");

/** Bỏ heading trong code fence để ví dụ Markdown không trở thành mục tài liệu. */
function sections(content: string) {
  const headings: { title: string; start: number; level: number }[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | undefined;
  for (const line of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const run = marker[1] ?? "";
      if (!fence) fence = { char: run[0] ?? "", length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && !marker[2]?.trim()) fence = undefined;
    } else if (!fence) {
      const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
      if (match)
        headings.push({
          title: (match[2] ?? "")
            .trim()
            .replace(/[ \t]+#+$/, "")
            .trim(),
          start: offset,
          level: match[1]?.length ?? 1,
        });
    }
    offset += line.length + 1;
  }
  return headings;
}

function docPage(content: string, section: string | undefined, offset: number, maxChars: number) {
  const headings = sections(content);
  if (section) {
    const index = headings.findIndex((h) => h.title === section);
    const selected = headings[index];
    if (!selected) throw new NotFoundError("DOC_SECTION_NOT_FOUND", "Không tìm thấy mục tài liệu.");
    const end = headings.slice(index + 1).find((h) => h.level <= selected.level)?.start ?? content.length;
    content = content.slice(selected.start, end);
  }
  const result = page(content, offset, maxChars);
  return { ...result, ...(result.truncated ? { headings: headings.map((h) => h.title) } : {}) };
}

const notFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");

/** Tool memory, tài liệu, skill cho agent. Cổng MCP đã chọn tổ chức, mở withTenant và sẽ ghi audit. */
export function registerMcpTools(registry: McpToolRegistry, deps: KnowledgeDeps = {}): void {
  registry.register({
    name: "memory_search",
    title: "Tìm memory",
    description: "Tìm memory liên quan trong dự án, đội và tổ chức.",
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
          content: m.content.slice(0, MCP_LIMITS.memoryChars),
          truncated: m.content.length > MCP_LIMITS.memoryChars,
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
    description: "Ghi một quyết định, quy ước, cái bẫy hoặc ghi chú cho dự án.",
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
    description: "Liệt kê tài liệu đọc được theo tiền tố key.",
    input: z.object({
      prefix: z.string().max(200).optional().describe("Tiền tố key tài liệu."),
      limit: LIMIT,
      offset: LIST_OFFSET,
    }),
    readOnly: true,
    handler: async ({ prefix, limit, offset }, { tx, principal }) => {
      const docs = await listDocs(tx, await knowledgePrincipal(tx, principal), { prefix });
      const { items, truncated, nextOffset } = capped(docs, limit, offset);
      return {
        docs: items.map((d) => ({ key: d.key, title: d.title, version: d.version, updatedAt: d.updatedAt })),
        truncated,
        nextOffset,
      };
    },
  });

  registry.register({
    name: "doc_get",
    title: "Đọc tài liệu",
    description: "Đọc tài liệu hoặc một mục theo tiêu đề.",
    input: z.object({
      key: docKey.describe("Key tài liệu."),
      offset: OFFSET,
      section: z.string().min(1).max(500).optional().describe("Tiêu đề mục cần đọc."),
      maxChars: z.number().int().min(1).max(40_000).optional().describe("Giới hạn ký tự; mặc định 8000."),
    }),
    readOnly: true,
    handler: async ({ key, offset, section, maxChars }, { tx, principal }) => {
      const d = await getDoc(tx, await knowledgePrincipal(tx, principal), { key });
      return {
        key: d.key,
        title: d.title,
        version: d.version,
        updatedAt: d.updatedAt,
        ...docPage(d.content, section, offset ?? 0, maxChars ?? MCP_LIMITS.pageChars),
      };
    },
  });

  registry.register({
    name: "doc_propose",
    title: "Đề xuất sửa tài liệu",
    description: "Đề xuất toàn bộ nội dung mới của tài liệu để quản trị duyệt.",
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
      const p = await proposeWithReview(
        tx,
        await knowledgePrincipal(tx, principal),
        { kind: "doc", key, baseVersion, content, reason: note },
        { jobs: deps.jobs, publicUrl: deps.publicUrl },
      );
      return { proposalId: p.id, status: p.status, key: p.target, baseVersion: p.baseVersion };
    },
  });

  registry.register({
    name: "skill_propose",
    title: "Đề xuất sửa skill",
    description: "Đề xuất toàn bộ SKILL.md mới của một skill đang áp cho dự án để quản trị duyệt.",
    input: z.object({
      name: skillName.describe("Tên skill, lấy từ skill_list."),
      project: PROJECT,
      baseVersion: z.number().int().min(1).describe("version đọc được từ skill_get."),
      content: z
        .string()
        .min(1)
        .max(SKILL_MAX_CHARS)
        .describe("Toàn bộ SKILL.md mới; có frontmatter thì lấy description từ đó."),
      note: z.string().trim().min(1).max(2000).describe("Vì sao cần sửa, cho người duyệt đọc."),
    }),
    handler: async ({ name, project, baseVersion, content, note }, { tx, principal }) => {
      const who = await knowledgePrincipal(tx, principal);
      // Đề xuất vào đúng phạm vi đang áp cho dự án (bản hẹp nhất), như skill mà agent đã đọc bằng skill_get.
      const current = await getSkill(tx, who, { name, project });
      const parsed = parseSkillFile(content);
      const { level, teamId, projectId } = current.scope;
      const scope =
        level === "project" && projectId
          ? { level, projectId }
          : level === "team" && teamId
            ? { level, teamId }
            : { level: "org" as const };
      const p = await createProposal(tx, who, {
        kind: "skill",
        scope,
        name,
        description: parsed.description || current.description,
        content: parsed.content,
        baseVersion,
        reason: note,
      });
      return { proposalId: p.id, status: p.status, name: p.target, baseVersion: p.baseVersion };
    },
  });

  registry.register({
    name: "skill_list",
    title: "Danh sách skill",
    description: "Liệt kê skill áp dụng cho dự án.",
    input: z.object({
      project: PROJECT,
      limit: LIMIT,
      offset: LIST_OFFSET,
    }),
    readOnly: true,
    handler: async ({ project, limit, offset }, { tx, principal }) => {
      const { skills, hidden } = await listSkillsWithHidden(tx, await knowledgePrincipal(tx, principal), { project });
      const { items, truncated, nextOffset } = capped(skills, limit, offset);
      const brief = (s: SkillSummary) => ({
        name: s.name,
        description: s.description,
        scope: s.scope.level,
        version: s.version,
        // Đội của skill phạm vi đội và đường dẫn trong kho Git: app desktop ghi nguồn "Đội · <tên>" và nơi lấy file.
        ...(s.scope.teamId ? { teamId: s.scope.teamId } : {}),
        ...(s.repoPath ? { repoPath: s.repoPath } : {}),
      });
      return {
        skills: items.map(brief),
        ...(hidden.length ? { hidden: hidden.map(brief) } : {}),
        truncated,
        nextOffset,
      };
    },
  });

  registry.register({
    name: "skill_get",
    title: "Đọc skill",
    description: "Đọc nội dung skill theo tên.",
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
