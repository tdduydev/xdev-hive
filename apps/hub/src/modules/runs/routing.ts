import {
  type PlanContent,
  type RoutingSettings,
  type RunRouting,
  TASK_TIERS,
  type TaskTier,
  taskTier,
} from "@xdev-hive/contracts";

export const TIER_LABEL: Record<TaskTier, string> = { light: "nhẹ", medium: "vừa", heavy: "nặng" };

// Từ khoá nhãn/loại: danh sách ngắn, cố ý bảo thủ. Nhãn lạ không đẩy task xuống nhẹ; chỉ nhãn chắc chắn là việc nhỏ.
const LIGHT_LABELS = new Set(["docs", "documentation", "typo", "chore", "good first issue"]);
const HEAVY_LABELS = new Set([
  "security",
  "architecture",
  "refactor",
  "performance",
  "breaking-change",
  "migration",
  "epic",
]);
const LIGHT_TYPES = new Set(["docs", "chore", "typo"]);
const HEAVY_TYPES = new Set(["security", "architecture", "epic"]);

// Ngưỡng cỡ kế hoạch: file/bước ít là việc nhỏ; nhiều file, nhiều bước hay trải nhiều module là việc nặng.
const LIGHT_PLAN = { files: 2, steps: 3 };
const HEAVY_PLAN = { files: 8, steps: 8, modules: 3 };
// Mô tả dài thường là yêu cầu nhiều mảng; đủ dài mới coi là nặng vì mô tả ngắn không nói gì về độ khó.
const HEAVY_TEXT_CHARS = 4000;

export interface TierInput {
  /** Cấp độ người đặt tay cho run (runs.tier). */
  manual: TaskTier | null;
  type: string | null;
  /** Nhãn của task (issue GitHub/GitLab ghi vào source.labels). */
  labels: string[];
  title: string;
  body: string;
  /** Kế hoạch đã duyệt của run code; null nếu run không qua bước lập kế hoạch. */
  plan: PlanContent | null;
  /** Run này thử lại sau lỗi: đã có lần thử hay run code thất bại trước của task. */
  retried: boolean;
}

export interface TierPick {
  tier: TaskTier;
  baseTier: TaskTier;
  source: RunRouting["source"];
  reasons: string[];
}

/** Nhãn `tier:light|medium|heavy` đặt cấp độ trực tiếp; trả về cấp đầu tiên hợp lệ. */
function labelTier(labels: string[]): TaskTier | null {
  for (const label of labels) {
    const m = /^tier[:/]\s*(\S+)$/i.exec(label.trim());
    const parsed = m ? taskTier.safeParse(m[1]?.toLowerCase()) : null;
    if (parsed?.success) return parsed.data;
  }
  return null;
}

/** Số thư mục gốc khác nhau của file kế hoạch (hai cấp đầu: `apps/hub`, `packages/contracts`) để ước số module. */
function moduleCount(plan: PlanContent): number {
  const roots = new Set(plan.files.map((f) => f.path.split("/").slice(0, 2).join("/")));
  return roots.size;
}

function fromPlan(plan: PlanContent): { tier: TaskTier; reason: string } | null {
  const files = plan.files.length;
  const steps = plan.steps.length;
  const modules = moduleCount(plan);
  const size = `${files} file, ${steps} bước, ${modules} module`;
  if (files >= HEAVY_PLAN.files || steps >= HEAVY_PLAN.steps || modules >= HEAVY_PLAN.modules) {
    return { tier: "heavy", reason: `Kế hoạch lớn (${size}).` };
  }
  if (files <= LIGHT_PLAN.files && steps <= LIGHT_PLAN.steps && modules <= 1 && plan.risks.length === 0) {
    return { tier: "light", reason: `Kế hoạch nhỏ (${size}, không có rủi ro nêu ra).` };
  }
  return { tier: "medium", reason: `Kế hoạch cỡ vừa (${size}).` };
}

/** Bậc cao hơn một cấp, dừng ở nặng. */
export function raiseTier(tier: TaskTier): TaskTier {
  return TASK_TIERS[Math.min(TASK_TIERS.indexOf(tier) + 1, TASK_TIERS.length - 1)] ?? tier;
}

/**
 * Cấp độ của task. Thứ tự thắng: người đặt tay, nhãn `tier:`, cỡ kế hoạch, loại task và nhãn, độ dài mô tả; không có tín
 * hiệu nào thì cấp vừa. Thử lại sau lỗi thì lên một cấp, vì lần trước model hiện tại đã không làm xong.
 */
export function pickTier(input: TierInput): TierPick {
  const base = ((): Omit<TierPick, "baseTier"> => {
    if (input.manual) {
      return {
        tier: input.manual,
        source: "manual",
        reasons: [`Người giao việc đặt cấp ${TIER_LABEL[input.manual]}.`],
      };
    }
    const byLabel = labelTier(input.labels);
    if (byLabel) {
      return { tier: byLabel, source: "label", reasons: [`Nhãn tier của task chỉ định cấp ${TIER_LABEL[byLabel]}.`] };
    }
    if (input.plan) {
      const p = fromPlan(input.plan);
      if (p) return { tier: p.tier, source: "plan", reasons: [p.reason] };
    }
    const type = input.type?.toLowerCase() ?? "";
    const labels = input.labels.map((l) => l.trim().toLowerCase());
    // Tín hiệu nặng thắng tín hiệu nhẹ: task vừa "docs" vừa "security" cần model mạnh.
    const heavy = labels.find((l) => HEAVY_LABELS.has(l)) ?? (HEAVY_TYPES.has(type) ? type : undefined);
    if (heavy) return { tier: "heavy", source: "type", reasons: [`Task thuộc loại/nhãn "${heavy}" nên coi là nặng.`] };
    const light = labels.find((l) => LIGHT_LABELS.has(l)) ?? (LIGHT_TYPES.has(type) ? type : undefined);
    if (light) return { tier: "light", source: "type", reasons: [`Task thuộc loại/nhãn "${light}" nên coi là nhẹ.`] };
    const chars = input.title.length + input.body.length;
    if (chars >= HEAVY_TEXT_CHARS) {
      return { tier: "heavy", source: "description", reasons: [`Mô tả dài ${chars} ký tự nên coi là nặng.`] };
    }
    return { tier: "medium", source: "default", reasons: ["Không có tín hiệu về độ khó nên dùng cấp vừa."] };
  })();
  if (!input.retried) return { ...base, baseTier: base.tier };
  const tier = raiseTier(base.tier);
  const reasons = [...base.reasons];
  reasons.push(
    tier === base.tier
      ? "Thử lại sau lỗi nhưng đã ở cấp cao nhất."
      : `Thử lại sau lỗi nên nâng từ cấp ${TIER_LABEL[base.tier]} lên ${TIER_LABEL[tier]}.`,
  );
  return { ...base, tier, baseTier: base.tier, reasons };
}

export type RoutedRun = RunRouting;

/**
 * Chọn model, effort, cố vấn và số lượt theo cấp độ. Chỉ Claude Code và Codex nhận effort; chỉ Claude Code nhận model,
 * cố vấn và --max-turns (tên model của mỗi CLI một kiểu, Codex tự giữ model đã cấu hình). CLI khác: null, giữ cách cũ.
 */
export function routeRun(cli: string, cfg: RoutingSettings, input: TierInput): RoutedRun | null {
  if (!cfg.enabled || (cli !== "claude" && cli !== "codex")) return null;
  const pick = pickTier(input);
  const route = cfg.tiers[pick.tier];
  const claude = cli === "claude";
  const reasons = [...pick.reasons];
  reasons.push(
    claude
      ? `Cấp ${TIER_LABEL[pick.tier]}: model ${route.model}, effort ${route.effort}${route.advisor ? `, cố vấn ${route.advisor}` : ""}, tối đa ${route.maxTurns} lượt.`
      : `Cấp ${TIER_LABEL[pick.tier]}: effort ${route.effort} (Codex giữ model đã cấu hình).`,
  );
  return {
    tier: pick.tier,
    baseTier: pick.baseTier,
    source: pick.source,
    model: claude ? route.model : null,
    effort: route.effort,
    advisor: claude ? route.advisor : null,
    maxTurns: claude ? route.maxTurns : null,
    reasons,
  };
}
