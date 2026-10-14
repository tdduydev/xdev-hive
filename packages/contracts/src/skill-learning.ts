import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { scopeLevel, scopeView, skillName } from "./knowledge.ts";

// Agent đề xuất skill sau việc khó (specs/014-skill-learning, ADR 0025). Hub chọn run đáng học, gom lô mỗi ngày mỗi
// dự án, giao một run `skill_proposal` chỉ đọc; đề xuất agent nộp chờ quản trị đội duyệt ở trang Skills.

/** Run đáng học khi đã thử lại từng này lần (số lần chạy lại của task, hoặc số lần thử của chính run). */
export const SKILL_LEARNING_MIN_RETRIES = 2;
/** Run đáng học khi chi phí vượt phân vị này của dự án (chỉ tính khi dự án có đủ run để so). */
export const SKILL_LEARNING_COST_PERCENTILE = 0.9;
/** Số run tối đa trong một lô, để lời nhắc gọn: chọn run đáng học nhất trước. */
export const SKILL_LEARNING_MAX_RUNS = 8;
/** Số đề xuất tối đa một run `skill_proposal` được nộp. */
export const SKILL_LEARNING_MAX_PER_RUN = 3;
export const SKILL_PROPOSAL_MAX_CHARS = 20_000;

export const learnTrigger = z.enum(["retries", "cost", "marked"]);
export type LearnTrigger = z.output<typeof learnTrigger>;

export const skillProposalKind = z.enum(["new", "edit"]);
export const skillProposalStatus = z.enum(["pending", "approved", "rejected"]);
export type SkillProposalStatus = z.output<typeof skillProposalStatus>;

const proposalDescription = z.string().trim().min(1, "Mô tả không được để trống.").max(1024);

/** Một đề xuất trong lần nộp của agent (tool MCP `skill_proposal_submit`). */
export const skillProposalDraft = z.object({
  /** `new`: skill chưa có; `edit`: sửa skill đã có (cùng tên, hub tìm bản áp dụng cho dự án). */
  kind: skillProposalKind,
  name: skillName,
  description: proposalDescription,
  /** SKILL.md không gồm frontmatter: hub tự ghép từ name và description. */
  content: z
    .string()
    .trim()
    .min(1, "Nội dung skill không được để trống.")
    .max(SKILL_PROPOSAL_MAX_CHARS, `Skill đề xuất dài tối đa ${SKILL_PROPOSAL_MAX_CHARS} ký tự.`),
  /** Vì sao đáng thành skill: gặp lỗi gì, mất bao nhiêu lần thử. Người duyệt đọc dòng này đầu tiên. */
  reason: z.string().trim().min(1, "Cần ghi lý do.").max(1000),
});
export type SkillProposalDraft = z.output<typeof skillProposalDraft>;

/** Rỗng là hợp lệ: agent thấy không có gì đáng thành skill. */
export const skillProposalSubmitInput = z.object({
  proposals: z.array(skillProposalDraft).max(SKILL_LEARNING_MAX_PER_RUN),
});
export type SkillProposalSubmitInput = z.input<typeof skillProposalSubmitInput>;

export const skillProposalDelivery = z.object({
  /** `pr`: đã mở (hoặc đang mở) PR vào kho skill Git; `saved`: lưu thành skill của tổ chức vì chưa nối kho. */
  mode: z.enum(["pr", "saved"]),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  /** Lỗi mở PR lần gần nhất; hub thử lại, nên chỉ để người duyệt biết vì sao PR chưa có. */
  error: z.string().nullable(),
  skillId: id.nullable(),
  version: z.number().int().nullable(),
});

export const learnedSkillProposal = z.object({
  id,
  kind: skillProposalKind,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  reason: z.string(),
  status: skillProposalStatus,
  projectId: id,
  projectKey: z.string(),
  /** Phạm vi của skill đang được sửa (`edit`), hoặc dự án nguồn (`new`, người duyệt chọn lại khi duyệt). */
  scope: scopeView,
  /** Phiên bản skill đề xuất sửa từ đó; 0 với skill mới. */
  baseVersion: z.number().int(),
  triggers: z.array(learnTrigger),
  sourceRunIds: z.array(id),
  /** Run `skill_proposal` đã viết đề xuất. */
  runId: id,
  createdAt: z.iso.datetime(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  /** Lý do từ chối (bắt buộc khi từ chối) hoặc ghi chú khi duyệt. */
  decisionNote: z.string().nullable(),
  delivery: skillProposalDelivery.nullable(),
});
export type LearnedSkillProposal = z.output<typeof learnedSkillProposal>;

export const learnedProposalListInput = z.object({
  status: skillProposalStatus.optional(),
  project: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LearnedProposalListInput = z.input<typeof learnedProposalListInput>;

export const learnedProposalApproveInput = z.object({
  id,
  /** Phạm vi của skill mới; mặc định dự án nguồn. `edit` luôn giữ phạm vi của skill đang sửa. */
  scope: scopeLevel.optional(),
  note: z.string().trim().max(1000).optional(),
});
export type LearnedProposalApproveInput = z.input<typeof learnedProposalApproveInput>;

export const learnedProposalRejectInput = z.object({
  id,
  /** Bắt buộc: hub lưu để không đề xuất lại đúng skill này. */
  reason: z.string().trim().min(3, "Cần ghi lý do từ chối.").max(1000),
});

export type LearnedProposalRejectInput = z.input<typeof learnedProposalRejectInput>;

export const skillLearningStatsInput = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export const skillLearningStats = z.object({
  /** Tổ chức đang bật tính năng (Chính sách agent). */
  enabled: z.boolean(),
  days: z.number().int(),
  batches: z.number().int(),
  /** Số run đáng học đã đưa vào lô. */
  candidateRuns: z.number().int(),
  proposals: z.number().int(),
  pending: z.number().int(),
  approved: z.number().int(),
  rejected: z.number().int(),
  /** Số đề xuất agent nộp nhưng hub bỏ vì trùng skill, memory hay đề xuất đã bị từ chối. */
  duplicates: z.number().int(),
  /** approved / (approved + rejected); null khi chưa ai quyết. */
  approvalRate: z.number().nullable(),
  /** Chi phí của các run `skill_proposal` trong kỳ; costUsd null khi CLI không báo USD. */
  costUsd: z.number().nullable(),
  tokens: z.number().int(),
  /** Hạn mức hôm nay (UTC): số đề xuất đã nhận và trần của Chính sách agent. */
  today: z.object({ used: z.number().int(), limit: z.number().int() }),
});
export type SkillLearningStats = z.output<typeof skillLearningStats>;

export const learnMarkInput = z.object({
  runId: id,
  /** false là bỏ đánh dấu. */
  marked: z.boolean().default(true),
  note: z.string().trim().max(500).optional(),
});
export type LearnMarkInput = z.input<typeof learnMarkInput>;

export const skillLearningContract = {
  list: orgRoute("GET", "/v1/skill-learning/proposals", "Skill agent đề xuất sau việc khó, mới nhất trước", "skills")
    .input(learnedProposalListInput)
    .output(z.array(learnedSkillProposal)),
  stats: orgRoute("GET", "/v1/skill-learning/stats", "Số đề xuất, tỉ lệ duyệt và chi phí của việc học", "skills")
    .input(skillLearningStatsInput)
    .output(skillLearningStats),
  approve: orgRoute(
    "POST",
    "/v1/skill-learning/proposals/{id}/approve",
    "Duyệt: mở PR vào kho skill Git, hoặc lưu thành skill của tổ chức khi chưa nối kho (quản trị đội)",
    "skills",
  )
    .input(learnedProposalApproveInput)
    .output(learnedSkillProposal),
  reject: orgRoute(
    "POST",
    "/v1/skill-learning/proposals/{id}/reject",
    "Từ chối kèm lý do; hub không đề xuất lại (quản trị đội)",
    "skills",
  )
    .input(learnedProposalRejectInput)
    .output(learnedSkillProposal),
  mark: orgRoute(
    "POST",
    "/v1/skill-learning/marks",
    "Đánh dấu run “nên thành skill” để lô sau xét (thành viên đội)",
    "skills",
  )
    .input(learnMarkInput)
    .output(z.object({ runId: id, marked: z.boolean() })),
};
