import { z } from "zod";
import { id, orgRoute, queryFlag } from "./common.ts";

// Tri thức dùng chung cho agent (docs/architecture.md mục 2, module knowledge): memory, tài liệu, skill, đề xuất sửa.

/**
 * Phạm vi của một mục tri thức: cả tổ chức, một đội, hoặc một dự án. Agent trong run của dự án thấy mục của dự án,
 * của đội sở hữu dự án và của tổ chức.
 */
export const knowledgeScope = z.discriminatedUnion("level", [
  z.object({ level: z.literal("org") }),
  z.object({ level: z.literal("team"), teamId: id }),
  z.object({ level: z.literal("project"), projectId: id }),
]);
export type KnowledgeScope = z.output<typeof knowledgeScope>;

export const scopeLevel = z.enum(["org", "team", "project"]);
export const scopeView = z.object({ level: scopeLevel, teamId: id.nullable(), projectId: id.nullable() });
export type ScopeView = z.output<typeof scopeView>;

/** Người hoặc run đã ghi; đúng một trong hai khác null. */
export const knowledgeAuthor = z.object({ userId: z.string().nullable(), runId: id.nullable() });
export type KnowledgeAuthor = z.output<typeof knowledgeAuthor>;

/** Project key (agent biết từ AGENTS.md) hoặc id dự án. */
export const projectRef = z.string().trim().min(1).max(64);

// GET đọc tham số từ query string nên số và cờ đến dưới dạng chuỗi; RPC thì gửi đúng kiểu.
const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const version = z.number().int().min(0, "Phiên bản không hợp lệ.");

// ---------------------------------------------------------------------------------------------------------------
// Memory

export const memoryKind = z.enum(["decision", "convention", "gotcha", "note"]);
export type MemoryKind = z.output<typeof memoryKind>;

export const MEMORY_MAX_CHARS = 2000;
export const memoryContent = z
  .string()
  .trim()
  .min(1, "Nội dung không được để trống.")
  .max(MEMORY_MAX_CHARS, `Nội dung memory dài tối đa ${MEMORY_MAX_CHARS} ký tự.`);
export const memoryFiles = z
  .array(z.string().trim().min(1).max(500, "Đường dẫn file dài tối đa 500 ký tự."))
  .max(50, "Tối đa 50 file.");

export const memoryWriteInput = z.object({
  scope: knowledgeScope,
  kind: memoryKind,
  content: memoryContent,
  files: memoryFiles.default([]),
});
export type MemoryWriteInput = z.input<typeof memoryWriteInput>;

export const memory = z.object({
  id,
  kind: memoryKind,
  content: z.string(),
  files: z.array(z.string()),
  scope: scopeView,
  author: knowledgeAuthor,
  createdAt: z.iso.datetime(),
  supersededBy: id.nullable(),
});
export type Memory = z.output<typeof memory>;

export const memorySearchInput = z.object({
  /** Có dự án thì tìm trong memory của dự án, của đội sở hữu và của tổ chức; không có thì mọi memory mình thấy. */
  project: projectRef.optional(),
  query: z.string().trim().min(1, "Câu tìm không được để trống.").max(500, "Câu tìm dài tối đa 500 ký tự."),
  limit: queryInt(1, 50).default(10),
});
export type MemorySearchInput = z.input<typeof memorySearchInput>;

export const memorySearchHit = memory.extend({
  score: z.number(),
  /** Kết quả khớp theo từ (full-text), theo nghĩa (vector), hoặc cả hai. */
  matchedBy: z.array(z.enum(["text", "vector"])),
});
export type MemorySearchHit = z.output<typeof memorySearchHit>;

export const memoryListInput = z.object({
  project: projectRef.optional(),
  kind: memoryKind.optional(),
  includeSuperseded: queryFlag.default(false),
  limit: queryInt(1, 200).default(50),
  offset: queryInt(0, 100_000).default(0),
});
export type MemoryListInput = z.input<typeof memoryListInput>;

export const memorySupersedeInput = z.object({
  id,
  kind: memoryKind.optional(),
  content: memoryContent,
  files: memoryFiles.optional(),
});
export type MemorySupersedeInput = z.input<typeof memorySupersedeInput>;

// ---------------------------------------------------------------------------------------------------------------
// Tài liệu

/**
 * Key quyết định phạm vi: `org/<đường-dẫn>`, `team/<slug đội>/<đường-dẫn>`, `project/<project key>/<đường-dẫn>`.
 * Chỉ chữ thường không dấu để key dùng được trong URL và lệnh MCP.
 */
export const docKey = z
  .string()
  .max(200, "Key tài liệu dài tối đa 200 ký tự.")
  .regex(
    /^(?:org|team\/[a-z0-9-]+|project\/[a-z0-9-]+)(?:\/[a-z0-9][a-z0-9._-]*)+$/,
    "Key tài liệu có dạng org/..., team/<đội>/... hoặc project/<dự án>/..., gồm chữ thường không dấu, số, `-`, `_`, `.`.",
  );

export const DOC_MAX_CHARS = 200_000;
const docTitle = z.string().trim().min(1, "Tiêu đề không được để trống.").max(200, "Tiêu đề dài tối đa 200 ký tự.");
const docContent = z.string().max(DOC_MAX_CHARS, `Tài liệu dài tối đa ${DOC_MAX_CHARS} ký tự.`);
const changeNote = z.string().trim().max(500, "Ghi chú dài tối đa 500 ký tự.");

export const docSaveInput = z.object({
  key: docKey,
  /** Bỏ trống thì giữ tiêu đề cũ, tài liệu mới lấy đoạn cuối của key. */
  title: docTitle.optional(),
  content: docContent,
  /** Phiên bản mình đã đọc trước khi sửa; 0 là tạo mới. Lệch với phiên bản hiện tại thì CONFLICT, không ghi đè. */
  baseVersion: version,
  message: changeNote.optional(),
});
export type DocSaveInput = z.input<typeof docSaveInput>;

export const docSummary = z.object({
  id,
  key: z.string(),
  title: z.string(),
  scope: scopeView,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  updatedBy: knowledgeAuthor,
});
export type DocSummary = z.output<typeof docSummary>;

export const doc = docSummary.extend({ content: z.string() });
export type Doc = z.output<typeof doc>;

export const docGetInput = z.object({ key: docKey, version: queryInt(1, 1_000_000).optional() });
export type DocGetInput = z.input<typeof docGetInput>;
export const docListInput = z.object({
  project: projectRef.optional(),
  prefix: z.string().max(200).optional(),
});
export type DocListInput = z.input<typeof docListInput>;

export const docVersion = z.object({
  version: z.number().int(),
  title: z.string(),
  author: knowledgeAuthor,
  message: z.string().nullable(),
  /** Đề xuất đã được duyệt để tạo ra phiên bản này, nếu có. */
  proposalId: id.nullable(),
  chars: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type DocVersion = z.output<typeof docVersion>;

// ---------------------------------------------------------------------------------------------------------------
// Skill

/** Cùng quy ước tên thư mục skill của Claude Code, để xuất ra `.claude/skills/<tên>/SKILL.md` không phải đổi tên. */
export const skillName = z
  .string()
  .max(64, "Tên skill dài tối đa 64 ký tự.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Tên skill gồm chữ thường không dấu, số và gạch ngang.");
export const SKILL_MAX_CHARS = 100_000;
const skillDescription = z
  .string()
  .trim()
  .min(1, "Mô tả không được để trống.")
  .max(1024, "Mô tả dài tối đa 1024 ký tự.");
const skillContent = z
  .string()
  .min(1, "Nội dung SKILL.md không được để trống.")
  .max(SKILL_MAX_CHARS, `SKILL.md dài tối đa ${SKILL_MAX_CHARS} ký tự.`);

export const skillSaveInput = z.object({
  scope: knowledgeScope,
  name: skillName,
  description: skillDescription,
  content: skillContent,
  baseVersion: version,
  message: changeNote.optional(),
});
export type SkillSaveInput = z.input<typeof skillSaveInput>;

export const skillSummary = z.object({
  id,
  name: z.string(),
  description: z.string(),
  scope: scopeView,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  updatedBy: knowledgeAuthor,
  /** Đường dẫn SKILL.md trong kho skill Git; null khi skill mới chỉ có trên hub (SKILL-01). */
  repoPath: z.string().nullable().optional(),
});
export type SkillSummary = z.output<typeof skillSummary>;

export const skill = skillSummary.extend({ content: z.string() });
export type Skill = z.output<typeof skill>;

export const skillListInput = z.object({
  /** Có dự án thì trả bộ skill áp dụng cho dự án: trùng tên thì phạm vi hẹp hơn thắng (dự án > đội > tổ chức). */
  project: projectRef.optional(),
});
export type SkillListInput = z.input<typeof skillListInput>;
export const skillGetInput = z
  .object({
    id: id.optional(),
    name: skillName.optional(),
    project: projectRef.optional(),
    version: queryInt(1, 1_000_000).optional(),
  })
  .refine((v) => (v.id === undefined) !== (v.name === undefined), "Cần đúng một trong id hoặc name.");
export type SkillGetInput = z.input<typeof skillGetInput>;

// ---------------------------------------------------------------------------------------------------------------
// Đề xuất sửa

export const proposalKind = z.enum(["doc", "skill"]);
export const proposalStatus = z.enum(["pending", "approved", "rejected"]);
export type ProposalStatus = z.output<typeof proposalStatus>;
const reason = z.string().trim().max(2000, "Lý do dài tối đa 2000 ký tự.");

export const proposalCreateInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("doc"),
    key: docKey,
    title: docTitle.optional(),
    content: docContent,
    baseVersion: version,
    reason: reason.optional(),
  }),
  z.object({
    kind: z.literal("skill"),
    scope: knowledgeScope,
    name: skillName,
    description: skillDescription,
    content: skillContent,
    baseVersion: version,
    reason: reason.optional(),
  }),
]);
export type ProposalCreateInput = z.input<typeof proposalCreateInput>;

export const proposal = z.object({
  id,
  kind: proposalKind,
  /** Key tài liệu hoặc tên skill. */
  target: z.string(),
  scope: scopeView,
  baseVersion: z.number().int(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  content: z.string(),
  reason: z.string().nullable(),
  status: proposalStatus,
  author: knowledgeAuthor,
  createdAt: z.iso.datetime(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionNote: z.string().nullable(),
  /** Phiên bản được tạo khi duyệt. */
  resultVersion: z.number().int().nullable(),
});
export type Proposal = z.output<typeof proposal>;

export const proposalListInput = z.object({
  status: proposalStatus.optional(),
  kind: proposalKind.optional(),
  project: projectRef.optional(),
  limit: queryInt(1, 200).default(50),
  offset: queryInt(0, 100_000).default(0),
});
export type ProposalListInput = z.input<typeof proposalListInput>;
export const proposalDecideInput = z.object({ id, note: changeNote.optional() });
export type ProposalDecideInput = z.input<typeof proposalDecideInput>;

// ---------------------------------------------------------------------------------------------------------------

export const memoryContract = {
  write: orgRoute("POST", "/v1/memories", "Ghi memory (thành viên đội trở lên)", "knowledge")
    .input(memoryWriteInput)
    .output(memory),
  search: orgRoute("GET", "/v1/memories/search", "Tìm memory theo từ và theo nghĩa", "knowledge")
    .input(memorySearchInput)
    .output(z.array(memorySearchHit)),
  list: orgRoute("GET", "/v1/memories", "Memory mình thấy được, mới nhất trước", "knowledge")
    .input(memoryListInput)
    .output(z.array(memory)),
  supersede: orgRoute("POST", "/v1/memories/{id}/supersede", "Thay memory cũ bằng nội dung mới", "knowledge")
    .input(memorySupersedeInput)
    .output(memory),
};

export const docsContract = {
  list: orgRoute("GET", "/v1/docs", "Tài liệu mình thấy được", "knowledge")
    .input(docListInput)
    .output(z.array(docSummary)),
  get: orgRoute("GET", "/v1/docs/item", "Đọc tài liệu theo key, mặc định phiên bản mới nhất", "knowledge")
    .input(docGetInput)
    .output(doc),
  save: orgRoute("POST", "/v1/docs", "Lưu phiên bản mới của tài liệu (quản trị đội)", "knowledge")
    .input(docSaveInput)
    .output(doc),
  history: orgRoute("GET", "/v1/docs/history", "Các phiên bản của tài liệu, mới nhất trước", "knowledge")
    .input(z.object({ key: docKey }))
    .output(z.array(docVersion)),
};

export const skillsContract = {
  list: orgRoute("GET", "/v1/skills", "Skill mình thấy được, hoặc bộ skill áp dụng cho một dự án", "knowledge")
    .input(skillListInput)
    .output(z.array(skillSummary)),
  get: orgRoute("GET", "/v1/skills/item", "Đọc skill theo id, hoặc theo tên trong phạm vi dự án", "knowledge")
    .input(skillGetInput)
    .output(skill),
  save: orgRoute("POST", "/v1/skills", "Lưu phiên bản mới của skill (quản trị đội)", "knowledge")
    .input(skillSaveInput)
    .output(skill),
};

export const proposalsContract = {
  create: orgRoute("POST", "/v1/proposals", "Đề xuất sửa tài liệu hoặc skill (thành viên đội trở lên)", "knowledge")
    .input(proposalCreateInput)
    .output(proposal),
  list: orgRoute("GET", "/v1/proposals", "Đề xuất mình thấy được, mới nhất trước", "knowledge")
    .input(proposalListInput)
    .output(z.array(proposal)),
  approve: orgRoute(
    "POST",
    "/v1/proposals/{id}/approve",
    "Duyệt đề xuất, tạo phiên bản mới (quản trị đội)",
    "knowledge",
  )
    .input(proposalDecideInput)
    .output(proposal),
  reject: orgRoute("POST", "/v1/proposals/{id}/reject", "Từ chối đề xuất (quản trị đội)", "knowledge")
    .input(proposalDecideInput)
    .output(proposal),
};
