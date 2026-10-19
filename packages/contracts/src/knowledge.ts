import { z } from "zod";
import { id, orgRoute, queryFlag } from "./common.ts";
import { secretFinding } from "./secret-scan.ts";

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
  /**
   * `machine`: memory lấy từ thư mục memory cục bộ của app trên máy người dùng. Hub luôn đặt chờ duyệt như memory agent
   * đề xuất, vì nội dung do agent ghi trên máy, chưa ai trong đội xem. `user` là người gõ trực tiếp.
   */
  source: z.enum(["user", "machine"]).default("user"),
});
export type MemoryWriteInput = z.input<typeof memoryWriteInput>;

/**
 * `pending`: agent ghi trong run khi chính sách tổ chức đặt `agentMemory.mode = propose`; chỉ hiện khi tìm sau khi
 * thành viên đội duyệt (ADR 0022).
 */
export const memoryStatus = z.enum(["approved", "pending"]);
export type MemoryStatus = z.output<typeof memoryStatus>;

export const memory = z.object({
  id,
  kind: memoryKind,
  status: memoryStatus,
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
  /** `pending` liệt kê memory agent đề xuất đang chờ duyệt. */
  status: memoryStatus.default("approved"),
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
export const docTitle = z
  .string()
  .trim()
  .min(1, "Tiêu đề không được để trống.")
  .max(200, "Tiêu đề dài tối đa 200 ký tự.");
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
  acknowledgeSecrets: z.boolean().optional(),
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
  /** Bỏ trống hoặc false chỉ lấy tài liệu đang dùng; true chỉ lấy tài liệu đã lưu trữ. */
  archived: queryFlag.optional(),
});
export type DocListInput = z.input<typeof docListInput>;

export const docSecretErrorData = z.object({
  code: z.literal("DOC_SECRET_FOUND"),
  findings: z.array(secretFinding).min(1),
});
export const docSecretErrors = {
  DOC_SECRET_FOUND: {
    status: 400,
    message: "Có chuỗi giống bí mật trong tài liệu. Xoá hoặc xác nhận trước khi lưu.",
    data: docSecretErrorData,
  },
};
export const docSearchInput = z.object({
  query: z.string().trim().min(1).max(2000),
  scope: scopeLevel.optional(),
  project: projectRef.optional(),
  limit: queryInt(1, 20).default(10),
});
export const docSearchHit = z.object({
  key: docKey,
  title: z.string(),
  headingPath: z.array(z.string()),
  snippet: z.string(),
  repoPath: z.string().nullable(),
  extractId: id.nullable(),
});
export const docSearchOutput = z.object({
  mode: z.enum(["keyword", "hybrid"]),
  hits: z.array(docSearchHit),
});
export type DocSearchInput = z.input<typeof docSearchInput>;
export type DocSearchHit = z.output<typeof docSearchHit>;
export type DocSearchOutput = z.output<typeof docSearchOutput>;
export const docSearchMcpInput = docSearchInput;
export const docAssetGetInput = z.object({ docKey, path: z.string().min(1).max(1000) });

/** Nguồn của một phiên bản, cùng ràng buộc `doc_versions_source` của hub. `word`: nhập từ file Word (spec 019). */
export const docVersionSource = z.enum(["hub", "repo", "import", "merge", "word"]);
export type DocVersionSource = z.output<typeof docVersionSource>;

export const docVersion = z.object({
  version: z.number().int(),
  title: z.string(),
  author: knowledgeAuthor,
  message: z.string().nullable(),
  /** Đề xuất đã được duyệt để tạo ra phiên bản này, nếu có. */
  proposalId: id.nullable(),
  chars: z.number().int(),
  createdAt: z.iso.datetime(),
  /** Hub cũ không trả. */
  source: docVersionSource.optional(),
});
export type DocVersion = z.output<typeof docVersion>;

// ---------------------------------------------------------------------------------------------------------------
// Brief dự án (ADR 0022)

/** Đủ cho khoảng 3k token; dài hơn thì mọi prompt phình theo, mất ý nghĩa tóm tắt. */
export const BRIEF_MAX_CHARS = 12_000;
export const briefContent = z
  .string()
  .trim()
  .min(1, "Brief không được để trống.")
  .max(BRIEF_MAX_CHARS, `Brief dài tối đa ${BRIEF_MAX_CHARS} ký tự.`);
const commitSha = z.string().regex(/^[0-9a-f]{40,64}$/, "Commit SHA không hợp lệ.");

export const projectBrief = z.object({
  projectId: id,
  content: z.string(),
  version: z.number().int(),
  /** Commit của nhánh chính agent đã đọc khi viết; null khi người sửa tay brief chưa từng có. */
  commitSha: z.string().nullable(),
  source: z.enum(["agent", "user"]),
  updatedBy: knowledgeAuthor,
  updatedAt: z.iso.datetime(),
  /** Nhánh chính mới nhất worker thấy, và số commit nó đi trước `commitSha`; null khi chưa có run nào báo. */
  headSha: z.string().nullable(),
  commitsBehind: z.number().int().nullable(),
  /** Run `brief` đang chờ hoặc đang chạy, để web không cho bấm "Làm mới" hai lần. */
  refreshRunId: id.nullable(),
});
export type ProjectBrief = z.output<typeof projectBrief>;

export const briefGetInput = z.object({ project: projectRef });
export type BriefGetInput = z.input<typeof briefGetInput>;
export const briefSaveInput = z.object({
  project: projectRef,
  content: briefContent,
  /** Phiên bản mình đã đọc; 0 là tạo mới. Lệch thì CONFLICT để không ghi đè brief agent vừa viết. */
  baseVersion: version,
});
export type BriefSaveInput = z.input<typeof briefSaveInput>;
export const briefSubmitInput = z.object({ content: briefContent, commitSha });

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

/**
 * Skill trong bộ mặc định của Hive (packages/skill-pack): chỉ đọc, mỗi tổ chức và dự án bật/tắt riêng. Skill cùng tên
 * của tổ chức, đội hay dự án được dùng thay bản mặc định.
 */
export const packSkill = z.object({
  name: z.string(),
  description: z.string(),
  /** Nhóm trong danh mục: ui, engineering, testing, security, tools, sdlc, hive. */
  group: z.string(),
  /** SPDX của giấy phép, vd. `MIT`, `Apache-2.0`, `CC-BY-SA-4.0`. */
  license: z.string(),
  /** Repo gốc; null là skill viết riêng cho Hive. */
  upstream: z.object({ repo: z.string(), commit: z.string(), path: z.string(), url: z.string() }).nullable(),
  /** Hive bật sẵn khi tổ chức chưa chỉnh. */
  defaultOn: z.boolean(),
  /** Tổ chức đặt riêng; null là theo mặc định của Hive. */
  org: z.boolean().nullable(),
  /** Dự án đặt riêng (chỉ có khi hỏi theo dự án); null là theo tổ chức. */
  project: z.boolean().nullable(),
  /** Bật ở phạm vi đang hỏi: dự án nếu có, không thì tổ chức. */
  enabled: z.boolean(),
  /** Phạm vi có skill cùng tên đang được dùng thay bản mặc định; null là không bị che. */
  shadowedBy: scopeLevel.nullable(),
  /** Tăng mỗi lần nội dung skill trong gói đổi. */
  version: z.number().int(),
  files: z.number().int(),
  bytes: z.number().int(),
});
export type PackSkill = z.output<typeof packSkill>;

export const skillPack = z.object({
  /** Kho và commit của bản đang đóng gói, để ghi nguồn trên trang Skills. */
  source: z.object({ repo: z.string(), commit: z.string() }),
  skills: z.array(packSkill),
});
export type SkillPack = z.output<typeof skillPack>;

export const skillPackListInput = z.object({ project: projectRef.optional() });
export type SkillPackListInput = z.input<typeof skillPackListInput>;
export const skillPackGetInput = z.object({ name: skillName, project: projectRef.optional() });
export type SkillPackGetInput = z.input<typeof skillPackGetInput>;
export const skillPackSetInput = z.object({
  name: skillName,
  /** Có dự án thì đặt cho dự án (quản trị đội), không thì cho cả tổ chức (quản trị tổ chức). */
  project: projectRef.optional(),
  /** null: bỏ đặt riêng, theo phạm vi rộng hơn. */
  enabled: z.boolean().nullable(),
});
export type SkillPackSetInput = z.input<typeof skillPackSetInput>;

export const packSkillFile = z.object({ path: z.string(), text: z.string() });
export const packSkillDetail = packSkill.extend({ content: z.string(), paths: z.array(z.string()) });
export const packSkillFiles = z.object({ name: z.string(), hash: z.string(), files: z.array(packSkillFile) });
export type PackSkillFiles = z.output<typeof packSkillFiles>;

// ---------------------------------------------------------------------------------------------------------------
// Đề xuất sửa

export const proposalKind = z.enum(["doc", "skill"]);
export const proposalStatus = z.enum(["pending", "approved", "rejected"]);
export type ProposalStatus = z.output<typeof proposalStatus>;
const reason = z.string().trim().max(2000, "Lý do dài tối đa 2000 ký tự.");

/**
 * Module khác tạo đề xuất thay người dùng, vd. nhập Word bằng quyền `propose` (spec 019, P2). Hub tự gắn, không nhận
 * từ input của API để không ai tự nhận đề xuất của mình đến từ Word.
 */
export const proposalOrigin = z.discriminatedUnion("kind", [z.object({ kind: z.literal("word"), importFileId: id })]);
export type ProposalOrigin = z.output<typeof proposalOrigin>;

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
  /** Không có là đề xuất người hoặc agent gửi thẳng; hub cũ không trả. */
  origin: proposalOrigin.nullable().optional(),
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
  approve: orgRoute("POST", "/v1/memories/{id}/approve", "Duyệt memory agent đề xuất (thành viên đội)", "knowledge")
    .input(z.object({ id }))
    .output(memory),
  reject: orgRoute("POST", "/v1/memories/{id}/reject", "Bỏ memory agent đề xuất (thành viên đội)", "knowledge")
    .input(z.object({ id }))
    .output(z.object({ ok: z.literal(true) })),
};

export const docsContract = {
  search: orgRoute("GET", "/v1/docs/search", "Tìm tài liệu và bản trích theo từ và theo nghĩa", "knowledge")
    .input(docSearchInput)
    .output(docSearchOutput),
  archive: orgRoute("POST", "/v1/docs/archive", "Lưu trữ tài liệu và xoá file khỏi repo (quản trị)", "knowledge")
    .input(z.object({ key: docKey, baseVersion: version.min(1) }))
    .output(z.object({ ok: z.literal(true) })),
  restore: orgRoute("POST", "/v1/docs/restore", "Khôi phục tài liệu đã lưu trữ (quản trị)", "knowledge")
    .input(z.object({ key: docKey, baseVersion: version.min(1) }))
    .output(doc),
  list: orgRoute("GET", "/v1/docs", "Tài liệu mình thấy được", "knowledge")
    .input(docListInput)
    .output(z.array(docSummary)),
  get: orgRoute("GET", "/v1/docs/item", "Đọc tài liệu theo key, mặc định phiên bản mới nhất", "knowledge")
    .input(docGetInput)
    .output(doc),
  save: orgRoute("POST", "/v1/docs", "Lưu phiên bản mới của tài liệu (quản trị đội)", "knowledge")
    .errors(docSecretErrors)
    .input(docSaveInput)
    .output(doc),
  history: orgRoute("GET", "/v1/docs/history", "Các phiên bản của tài liệu, mới nhất trước", "knowledge")
    .input(z.object({ key: docKey }))
    .output(z.array(docVersion)),
};

export const briefContract = {
  get: orgRoute("GET", "/v1/briefs", "Brief của dự án; null khi chưa có", "knowledge")
    .input(briefGetInput)
    .output(projectBrief.nullable()),
  save: orgRoute("POST", "/v1/briefs", "Sửa tay brief của dự án (thành viên đội)", "knowledge")
    .input(briefSaveInput)
    .output(projectBrief),
  refresh: orgRoute("POST", "/v1/briefs/refresh", "Giao run viết lại brief của dự án (thành viên đội)", "knowledge")
    .input(briefGetInput)
    .output(z.object({ runId: id })),
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
  pack: orgRoute(
    "GET",
    "/v1/skills/pack",
    "Bộ skill mặc định của Hive, kèm trạng thái bật của tổ chức hoặc dự án",
    "knowledge",
  )
    .input(skillPackListInput)
    .output(skillPack),
  packGet: orgRoute("GET", "/v1/skills/pack/item", "Đọc SKILL.md của một skill mặc định", "knowledge")
    .input(skillPackGetInput)
    .output(packSkillDetail),
  packFiles: orgRoute("GET", "/v1/skills/pack/files", "Mọi file của một skill mặc định, để cài vào máy", "knowledge")
    .input(skillPackGetInput)
    .output(packSkillFiles),
  packSet: orgRoute(
    "POST",
    "/v1/skills/pack",
    "Bật, tắt hoặc bỏ đặt riêng một skill mặc định cho tổ chức (quản trị tổ chức) hoặc dự án (quản trị đội)",
    "knowledge",
  )
    .input(skillPackSetInput)
    .output(packSkill),
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
