import {
  type GateKind,
  type ReviewGate,
  type ReviewPhase,
  type ReviewWorkflow,
  type RuleCheck,
  reviewPhase,
  WORKFLOW_PRESETS,
  type WorkflowInput,
  type WorkflowPreset,
  workflowInput,
} from "@xdev-hive/contracts";
import type { Dict, Lang } from "@/lib/i18n.ts";

export type ReviewerRole = NonNullable<ReviewGate["reviewers"]>["roles"][number];
export type PassAction = ReviewGate["onPass"];

/** Quy trình đang sửa trên màn: như WorkflowInput nhưng giữ cấu hình của mọi loại gate để đổi loại qua lại không mất. */
export interface WorkflowDraft {
  id: string | null;
  name: string;
  preset: WorkflowPreset;
  teamId: string | null;
  docPrefixes: string[];
  phases: ReviewPhase[];
  enabled: boolean;
}

export const GATE_KINDS: readonly GateKind[] = ["ai", "human", "rule", "ext"];
export const REVIEWER_ROLES: readonly ReviewerRole[] = ["org-admin", "team-admin", "team-member"];
export const RULE_CHECKS: readonly RuleCheck[] = ["sections", "requirements", "no-secrets", "max-diff"];
export const PRESETS: readonly WorkflowPreset[] = ["aidlc", "speckit", "bmad", "custom"];

/** Màu loại checkpoint theo Workflows.dc.html (badge trên thẻ gate và hàng chờ duyệt). */
export const KIND_CLASS: Record<GateKind, string> = {
  ai: "bg-accent text-accent-foreground",
  human: "bg-warning-soft text-warning",
  rule: "bg-secondary text-secondary-foreground",
  ext: "bg-success-soft text-success",
};

export const KIND_LABEL: Dict<Record<GateKind, string>> = {
  vi: { ai: "AI tự kiểm", human: "Người duyệt", rule: "Quy tắc", ext: "Cổng CI" },
  en: { ai: "AI check", human: "Human", rule: "Rule", ext: "CI gate" },
};

export const ROLE_LABEL: Dict<Record<ReviewerRole, string>> = {
  vi: { "org-admin": "Quản trị tổ chức", "team-admin": "Quản trị đội", "team-member": "Thành viên đội" },
  en: { "org-admin": "Org admin", "team-admin": "Team admin", "team-member": "Team member" },
};

export const PRESET_LABEL: Dict<Record<WorkflowPreset, string>> = {
  vi: { aidlc: "AI-DLC (AWS)", speckit: "Spec Kit", bmad: "BMAD", custom: "Tự tạo" },
  en: { aidlc: "AI-DLC (AWS)", speckit: "Spec Kit", bmad: "BMAD", custom: "Custom" },
};

/** Mô tả mặc định của giai đoạn khung mẫu (Workflows.dc.html), hiện khi giai đoạn chưa có mô tả riêng. */
export const PHASE_DESC: Record<string, Dict<string>> = {
  Inception: { vi: "Ý định → yêu cầu, story", en: "Intent → requirements, stories" },
  Construction: { vi: "Thiết kế, ADR, kế hoạch task, code", en: "Design, ADR, task plan, code" },
  Operations: { vi: "Phát hành, runbook, vận hành", en: "Release, runbook, operations" },
  Specify: { vi: "Mô tả tính năng, user story", en: "Feature and user stories" },
  Plan: { vi: "Kỹ thuật, ràng buộc constitution", en: "Tech plan, constitution checks" },
  Tasks: { vi: "Task có mã T001…", en: "Tasks with T001 ids" },
  "Analysis · PM": { vi: "Brief → PRD", en: "Brief → PRD" },
  "Architect · UX": { vi: "Kiến trúc, UX", en: "Architecture, UX" },
  "Scrum master · Dev": { vi: "Story sẵn sàng → code", en: "Ready stories → code" },
};

const DEFAULT_AI_CHECKS: Dict<string[]> = {
  vi: ["Đủ mục theo mẫu", "Không có dữ liệu nhạy cảm"],
  en: ["All template sections present", "No sensitive data"],
};

/** Giai đoạn của khung mẫu, đã điền mặc định của hợp đồng. "Tự tạo" bắt đầu với một giai đoạn trống. */
export function presetPhases(preset: WorkflowPreset, lang: Lang): ReviewPhase[] {
  if (preset === "custom") return [{ name: lang === "en" ? "Phase 1" : "Giai đoạn 1", outputs: [], gates: [] }];
  return WORKFLOW_PRESETS[preset].map((p) => reviewPhase.parse(p));
}

export function newDraft(preset: WorkflowPreset, name: string, lang: Lang): WorkflowDraft {
  return { id: null, name, preset, teamId: null, docPrefixes: [], phases: presetPhases(preset, lang), enabled: true };
}

export function draftOf(w: ReviewWorkflow): WorkflowDraft {
  return {
    id: w.id,
    name: w.name,
    preset: w.preset,
    teamId: w.teamId,
    docPrefixes: [...w.docPrefixes],
    phases: structuredClone(w.phases),
    enabled: w.enabled,
  };
}

/** Bỏ cấu hình của loại gate khác (giữ trong bản nháp để đổi loại qua lại) trước khi gửi hub. */
export function gateInput(g: ReviewGate): ReviewGate {
  const base: ReviewGate = {
    id: g.id,
    name: g.name,
    kind: g.kind,
    conditions: g.conditions,
    slaHours: g.slaHours,
    onReject: g.onReject,
    onPass: g.onPass,
  };
  if (g.onPass === "task" && g.nextTaskTitle?.trim()) base.nextTaskTitle = g.nextTaskTitle.trim();
  if (g.kind === "human" && g.reviewers) base.reviewers = g.reviewers;
  if (g.kind === "ai" && g.ai) {
    // Ô model để trống nghĩa là dùng model review của dự án; hợp đồng không nhận chuỗi rỗng.
    const model = g.ai.model?.trim();
    base.ai = { checks: g.ai.checks, passScore: g.ai.passScore, ...(model ? { model } : {}) };
  }
  if (g.kind === "ext") base.ext = g.ext ?? { check: "ci" };
  if (g.kind === "rule") {
    base.rules = g.rules ?? [];
    if (base.rules.includes("sections")) base.sections = g.sections ?? [];
    if (base.rules.includes("max-diff") && g.maxDiffLines) base.maxDiffLines = g.maxDiffLines;
  }
  return base;
}

export function toInput(d: WorkflowDraft): WorkflowInput {
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    preset: d.preset,
    teamId: d.teamId,
    docPrefixes: d.docPrefixes,
    phases: d.phases.map((p) => {
      const description = p.description?.trim();
      return {
        name: p.name.trim(),
        ...(description ? { description } : {}),
        outputs: p.outputs,
        gates: p.gates.map(gateInput),
      };
    }),
    enabled: d.enabled,
  };
}

/** Mã gate từ tên: chữ thường không dấu, số và -, không trùng mã đã có (hub dùng mã để nối phiên duyệt với gate). */
export function uniqueGateId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "gate";
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const id = `${slug}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** Đổi loại gate, thêm cấu hình tối thiểu mà hợp đồng đòi cho loại mới. */
export function withKind(g: ReviewGate, kind: GateKind, lang: Lang): ReviewGate {
  const next: ReviewGate = { ...g, kind };
  if (kind === "human" && !next.reviewers) next.reviewers = { users: [], roles: ["team-admin"], teams: [], quorum: 1 };
  if (kind === "ai" && !next.ai) next.ai = { checks: [...DEFAULT_AI_CHECKS[lang]], passScore: 7 };
  if (kind === "rule" && !next.rules?.length) next.rules = ["requirements"];
  if (kind === "ext" && !next.ext) next.ext = { check: "ci" };
  return next;
}

export function newGate(name: string, taken: Iterable<string>, lang: Lang): ReviewGate {
  return withKind(
    {
      id: uniqueGateId(name, taken),
      name,
      kind: "human",
      conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false },
      slaHours: 24,
      onReject: "author",
      onPass: "next",
    },
    "human",
    lang,
  );
}

export function allGateIds(phases: readonly ReviewPhase[]): string[] {
  return phases.flatMap((p) => p.gates.map((g) => g.id));
}

/** Dời gate lên hoặc xuống một bậc; ở đầu hoặc cuối giai đoạn thì sang giai đoạn kề bên. */
export function moveGate(phases: readonly ReviewPhase[], gateId: string, delta: -1 | 1): ReviewPhase[] {
  const next = phases.map((p) => ({ ...p, gates: [...p.gates] }));
  const pi = next.findIndex((p) => p.gates.some((g) => g.id === gateId));
  const phase = next[pi];
  if (!phase) return next;
  const gi = phase.gates.findIndex((g) => g.id === gateId);
  const target = gi + delta;
  const other = next[pi + delta];
  const inside = target >= 0 && target < phase.gates.length;
  if (!inside && !other) return next;
  const [gate] = phase.gates.splice(gi, 1);
  if (!gate) return next;
  if (inside) phase.gates.splice(target, 0, gate);
  else if (delta === -1) other?.gates.push(gate);
  else other?.gates.unshift(gate);
  return next;
}

export type QuorumMode = "any" | "all" | "n";
export const quorumMode = (quorum: number): QuorumMode => (quorum === 0 ? "all" : quorum === 1 ? "any" : "n");

export interface WorkflowIssue {
  /** Gate bị lỗi, để tô đỏ thẻ của nó. */
  gateId: string | null;
  where: string;
  message: string;
}

const WHERE: Dict<{
  name: string;
  prefixes: string;
  phases: string;
  phase: (n: number, name: string) => string;
  gate: (name: string) => string;
  field: Record<string, string>;
}> = {
  vi: {
    name: "Tên quy trình",
    prefixes: "Áp cho",
    phases: "Giai đoạn",
    phase: (n, name) => (name ? `Giai đoạn “${name}”` : `Giai đoạn ${n}`),
    gate: (name) => `Checkpoint “${name}”`,
    field: {
      name: "tên",
      description: "mô tả",
      outputs: "tài liệu đầu ra",
      gates: "checkpoint",
      ai: "AI kiểm",
      reviewers: "người duyệt",
      sections: "mục bắt buộc",
      maxDiffLines: "số dòng tối đa",
      conditions: "điều kiện",
      slaHours: "SLA",
      nextTaskTitle: "tiêu đề việc",
      id: "mã",
    },
  },
  en: {
    name: "Workflow name",
    prefixes: "Applies to",
    phases: "Phases",
    phase: (n, name) => (name ? `Phase “${name}”` : `Phase ${n}`),
    gate: (name) => `Checkpoint “${name}”`,
    field: {
      name: "name",
      description: "description",
      outputs: "outputs",
      gates: "checkpoints",
      ai: "AI checks",
      reviewers: "approvers",
      sections: "required sections",
      maxDiffLines: "max lines",
      conditions: "conditions",
      slaHours: "SLA",
      nextTaskTitle: "task title",
      id: "id",
    },
  },
};

/**
 * Lỗi của quy trình theo đúng hợp đồng (cùng schema hub kiểm), kèm chỗ sai đọc được: giai đoạn, checkpoint, ô. Câu lỗi
 * của zod và của hub là tiếng Việt (contracts đặt locale vi), chỉ phần chỉ chỗ đổi theo ngôn ngữ.
 */
export function workflowIssues(
  draft: WorkflowDraft,
  lang: Lang,
  issues: readonly { path?: readonly unknown[]; message: string; code?: string }[] = workflowInput.safeParse(
    toInput(draft),
  ).error?.issues ?? [],
): WorkflowIssue[] {
  const w = WHERE[lang];
  return issues.map((issue) => {
    const path = (issue.path ?? []).map((p) => (typeof p === "object" && p !== null && "key" in p ? p.key : p));
    const [top, pi, sub, gi, field] = path;
    if (top === "name") return { gateId: null, where: w.name, message: issue.message };
    if (top === "docPrefixes") return { gateId: null, where: w.prefixes, message: issue.message };
    if (top === "phases" && typeof pi === "number") {
      const phase = draft.phases[pi];
      if (sub === "gates" && typeof gi === "number") {
        const gate = phase?.gates[gi];
        const label = w.gate(gate?.name ?? String(gi + 1));
        const where = typeof field === "string" && w.field[field] ? `${label} · ${w.field[field]}` : label;
        // Lỗi tự viết của hợp đồng đã nêu tên checkpoint trong câu.
        return { gateId: gate?.id ?? null, where: issue.code === "custom" ? "" : where, message: issue.message };
      }
      const where = w.phase(pi + 1, phase?.name ?? "");
      return {
        gateId: null,
        where: typeof sub === "string" && w.field[sub] ? `${where} · ${w.field[sub]}` : where,
        message: issue.message,
      };
    }
    return { gateId: null, where: top === "phases" ? w.phases : "", message: issue.message };
  });
}
