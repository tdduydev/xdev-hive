import { z } from "zod";
import { id, orgRoute, queryFlag } from "./common.ts";
import { DOC_MAX_CHARS, docKey } from "./knowledge.ts";
import { projectKey, projectSdlcSettings, sdlcBlocking } from "./projects.ts";
import { runState } from "./runs.ts";
import { taskChecklistItem, taskStatus } from "./tasks.ts";
import { cli } from "./worker-protocol.ts";
import { checklistItem, findingSeverity, type ReviewGate, reviewPhase } from "./workflows.ts";

/**
 * Chế độ AI SDLC (specs/011-ai-sdlc-mode, ADR 0021). Một hạng mục đi từ ý tưởng tới tài liệu đã duyệt, task có phụ
 * thuộc, PR đã review và merge. Vòng đời mô tả bằng dữ liệu (`sdlcMode`); mỗi phương pháp (AI-DLC, Spec Kit, BMAD, Kiro,
 * OpenSpec) là một hay nhiều preset của cùng mô hình, không có code riêng ngoài bộ đọc bản tách task.
 *
 * Vài phần nằm ở file khác để tránh vòng import: cài đặt dự án `projectSdlcSettings` ở projects.ts, chính sách tổ chức
 * `orgSdlcPolicy` ở policies.ts, mã lỗi `SDLC_GATE_BLOCKED`, `TASK_DEPENDENCIES_OPEN` ở runs.ts.
 */

export const sdlcMethod = z.enum(["aidlc", "speckit", "bmad", "kiro", "openspec", "hive"]);
export type SdlcMethod = z.output<typeof sdlcMethod>;

/** Bảy loại giai đoạn chuẩn: cột của bảng tiến độ và đơn vị của chỉ số, dù mỗi chế độ đặt tên riêng. */
export const SDLC_PHASE_KINDS = [
  "intake",
  "requirements",
  "design",
  "decomposition",
  "implementation",
  "verification",
  "release",
] as const;
export const sdlcPhaseKind = z.enum(SDLC_PHASE_KINDS);
export type SdlcPhaseKind = z.output<typeof sdlcPhaseKind>;

export const sdlcSize = z.enum(["S", "M", "L", "XL"]);
export type SdlcSize = z.output<typeof sdlcSize>;
/** Cỡ "nặng" (D26): giai đoạn yêu cầu của chế độ hoặc hạng mục cỡ này luôn cần người duyệt. */
export const SDLC_HEAVY_SIZES: readonly SdlcSize[] = ["L", "XL"];

export const sdlcStepAction = z.enum(["size", "draft", "analyze", "converge", "release-notes", "retro", "archive"]);
export type SdlcStepAction = z.output<typeof sdlcStepAction>;

export const breakdownParser = z.enum([
  "hive-tasks",
  "speckit-tasks",
  "kiro-tasks",
  "openspec-tasks",
  "bmad-stories",
  "aidlc-units",
]);
export type BreakdownParser = z.output<typeof breakdownParser>;
/** `item`: mỗi dòng task là một task hub; `heading`: mỗi phần là một task, dòng task thành checklist; `single`: một task. */
export const breakdownGranularity = z.enum(["item", "heading", "single"]);
export type BreakdownGranularity = z.output<typeof breakdownGranularity>;
/**
 * Độ mịn mỗi bộ đọc hiểu được. Kiro, BMAD, AI-DLC không chia phần nên không có `heading`; OpenSpec nhóm mục theo phần
 * đánh số nên chỉ tách theo phần. `single` đọc nguyên văn nên bộ đọc nào cũng dùng được.
 */
export const BREAKDOWN_GRANULARITIES: Readonly<Record<BreakdownParser, readonly BreakdownGranularity[]>> = {
  "hive-tasks": ["item", "heading", "single"],
  "speckit-tasks": ["item", "heading", "single"],
  "kiro-tasks": ["item", "single"],
  "openspec-tasks": ["heading", "single"],
  "bmad-stories": ["item", "single"],
  "aidlc-units": ["item", "single"],
};

export const sdlcArtifactScope = z.enum(["item", "project", "contract"]);
export type SdlcArtifactScope = z.output<typeof sdlcArtifactScope>;
export const contractFormat = z.enum(["openapi", "asyncapi", "graphql", "proto", "jsonschema", "markdown"]);
export type ContractFormat = z.output<typeof contractFormat>;
/** Đuôi file của `{ext}` trong đường dẫn contract. */
export const CONTRACT_FORMAT_EXT: Record<ContractFormat, string> = {
  openapi: "yaml",
  asyncapi: "yaml",
  graphql: "graphql",
  proto: "proto",
  jsonschema: "json",
  markdown: "md",
};

/** Id giai đoạn, tài liệu, bước trong chế độ; nằm trong key tài liệu hub nên chỉ chữ thường không dấu. */
export const sdlcSlugId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Mã gồm chữ thường không dấu, số và -.");

// ---- Đường dẫn trong repo -----------------------------------------------------------------------------------------

/** Biến khuôn đường dẫn (FR-003); `{name}`, `{ext}` chỉ cho contract. */
export const SDLC_PATH_VARS = ["{NNN}", "{slug}", "{date}", "{unit}"] as const;
const CONTRACT_PATH_VARS = ["{name}", "{ext}"] as const;
/** Chỗ agent hay người sửa chế độ không được ghi: lịch sử Git và cấu hình CI (chạy code khi merge). */
export const SDLC_FORBIDDEN_PATHS = [".git/", ".github/workflows/", ".gitlab-ci.yml"] as const;
export const SDLC_PATH_ERROR = "Đường dẫn tài liệu phải nằm trong repo và không thuộc thư mục bị cấm.";

/** Đường dẫn tương đối trong repo, có thể có biến khuôn; kiểm thêm thư mục cấm và biến ở `checkRepoPath`. */
export const repoPathTemplate = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._{}/-]+$/, SDLC_PATH_ERROR);

/**
 * Lỗi của một đường dẫn tài liệu (khuôn hoặc đã điền biến), null khi hợp lệ. Hub dùng lại khi nhận thư mục có sẵn và
 * khi agent báo contract, nên tách khỏi `sdlcMode`.
 */
export function checkRepoPath(path: string, opts: { contract?: boolean } = {}): string | null {
  if (!repoPathTemplate.safeParse(path).success) return SDLC_PATH_ERROR;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === ".")) return SDLC_PATH_ERROR;
  // Hệ tệp của macOS, Windows không phân biệt hoa thường: `.GitHub/Workflows` vẫn là thư mục workflow.
  const lower = path.toLowerCase();
  if (segments.some((s) => s.toLowerCase() === ".git")) return SDLC_PATH_ERROR;
  if (lower.startsWith(".github/workflows/") || lower === ".gitlab-ci.yml") return SDLC_PATH_ERROR;
  const allowed: readonly string[] = opts.contract ? [...SDLC_PATH_VARS, ...CONTRACT_PATH_VARS] : SDLC_PATH_VARS;
  const rest = path.replace(/\{[A-Za-z]+\}/g, (v) => (allowed.includes(v) ? "" : "\0"));
  if (rest.includes("\0") || rest.includes("{") || rest.includes("}"))
    return `Biến trong đường dẫn chỉ gồm ${allowed.join(", ")}.`;
  return null;
}

/** Số hạng mục ba chữ số (`012`); trên 999 thì giữ nguyên. */
export const sdlcItemRef = (number: number) => String(number).padStart(3, "0");

/**
 * Điền biến vào khuôn đường dẫn. Ở repo không phải dự án chính, `{NNN}` thành `<home>-<NNN>` để không trùng số hạng mục
 * của chính repo đó (D20).
 */
export function renderRepoPath(
  template: string,
  vars: {
    number: number;
    slug: string;
    /** YYYY-MM-DD, ngày tạo hạng mục. */
    date: string;
    unit?: string;
    name?: string;
    format?: ContractFormat;
    /** Key dự án chính, khi ghi vào repo của dự án tham gia. */
    homeKey?: string;
  },
): string {
  const ref = vars.homeKey ? `${vars.homeKey}-${sdlcItemRef(vars.number)}` : sdlcItemRef(vars.number);
  return template
    .replaceAll("{NNN}", ref)
    .replaceAll("{slug}", vars.slug)
    .replaceAll("{date}", vars.date)
    .replaceAll("{unit}", vars.unit ?? "")
    .replaceAll("{name}", vars.name ?? "")
    .replaceAll("{ext}", vars.format ? CONTRACT_FORMAT_EXT[vars.format] : "");
}

/**
 * Slug ASCII từ tiêu đề (bỏ dấu tiếng Việt), dùng trong thư mục repo và key tài liệu hub. Cắt ở gạch ngang gần nhất
 * dưới `max` để không cụt giữa từ.
 */
export function sdlcSlug(title: string, max = 48): string {
  const ascii = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length <= max) return ascii || "hang-muc";
  const cut = ascii.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > 0 ? cut.slice(0, at) : ascii.slice(0, max)).replace(/-+$/, "");
}

/**
 * Key tài liệu hub của hạng mục (D20, D23). Tài liệu chung và contract nằm ở dự án chính; tài liệu riêng một dự án nằm
 * ở dự án đó, thư mục mang key dự án chính để không trùng hạng mục của dự án đó.
 */
export function sdlcDocKey(input: {
  homeKey: string;
  number: number;
  slug: string;
  artifactId: string;
  scope: SdlcArtifactScope;
  /** Key dự án (scope `project`) hoặc tên contract (scope `contract`). */
  instance?: string;
}): string {
  const dir = `${sdlcItemRef(input.number)}-${input.slug}`;
  if (input.scope === "project" && input.instance && input.instance !== input.homeKey)
    return `project/${input.instance}/sdlc/${input.homeKey}-${dir}/${input.artifactId}`;
  if (input.scope === "contract") return `project/${input.homeKey}/sdlc/${dir}/contracts/${input.instance ?? ""}`;
  return `project/${input.homeKey}/sdlc/${dir}/${input.artifactId}`;
}

// ---- Chế độ ---------------------------------------------------------------------------------------------------

export const sdlcArtifact = z.object({
  /** "spec", "plan", "tasks", "contract". */
  id: sdlcSlugId,
  name: z.string().trim().min(1).max(80),
  /** "specs/{NNN}-{slug}/spec.md"; contract: "specs/{NNN}-{slug}/contracts/{name}.{ext}". */
  path: repoPathTemplate,
  required: z.boolean().default(true),
  /** Khuôn Markdown cho bản đầu. */
  template: z.string().max(20_000).optional(),
  /** Mục bắt buộc (luật `sections`). */
  sections: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** AI-DLC: một file mỗi unit (để sau MVP). */
  perUnit: z.boolean().default(false),
  /**
   * `item`: tài liệu chung, ở dự án chính; `project`: một bản cho mỗi dự án tham gia; `contract`: 0..n bản, mỗi bản có
   * bên cung cấp và bên dùng (D20, D23). Hạng mục một dự án: `project` và `item` trùng nhau.
   */
  scope: sdlcArtifactScope.default("item"),
  /** Chỉ cho contract: hạng mục có bao nhiêu contract cũng được. */
  repeatable: z.boolean().default(false),
});
export type SdlcArtifact = z.output<typeof sdlcArtifact>;

/** Tự duyệt AI ở lớp chế độ (D25, D26). Điều kiện kiểm ở `sdlcMode` (FR-056). */
export const sdlcAutoApprove = z.object({
  /** Id checkpoint người của cổng giai đoạn được tự duyệt. */
  gates: z.array(z.string().max(40)).min(1).max(5),
  minScore: z.number().min(0).max(10),
  revokeHours: z.number().int().min(1).max(168).default(24),
});
export type SdlcAutoApprove = z.output<typeof sdlcAutoApprove>;

export const sdlcStep = z.object({
  id: sdlcSlugId,
  action: sdlcStepAction,
  /** Id tài liệu bước thu về (`draft`) hoặc đọc (`analyze`, `converge`). */
  artifacts: z.array(sdlcSlugId).max(10).default([]),
  /** Tự chạy khi giai đoạn bắt đầu hoặc khi đủ câu trả lời. */
  auto: z.boolean().default(true),
  /** Bỏ trống là CLI mặc định của dự án. */
  cli: cli.optional(),
  model: z.string().trim().min(1).max(80).optional(),
  /** "speckit-specify": prompt gọi skill này nếu repo có. */
  skill: z.string().trim().min(1).max(80).optional(),
  /** Markdown có biến {idea} {artifacts} {answers} {feedback} {constitution} {projects} {release}. */
  prompt: z.string().min(1).max(20_000),
  maxQuestions: z.number().int().min(0).max(5).default(5),
  autoSubmit: z.boolean().default(false),
});
export type SdlcStep = z.output<typeof sdlcStep>;

export const sdlcPhase = z.object({
  id: sdlcSlugId,
  name: z.string().trim().min(1).max(80),
  kind: sdlcPhaseKind,
  optional: z.boolean().default(false),
  /** Cỡ hạng mục có giai đoạn này; rỗng là mọi cỡ, ngoài cỡ thì giai đoạn tự `skipped`. */
  sizes: z.array(sdlcSize).max(4).default([]),
  artifacts: z.array(sdlcArtifact).max(10).default([]),
  steps: z.array(sdlcStep).max(6).default([]),
  /** Cổng duyệt theo schema của spec 004; rỗng là không cổng (tài liệu thành baseline ngay khi lưu). */
  gate: z.array(reviewPhase).max(3).default([]),
  /** D21: id checkpoint người được nhân thành một checkpoint cho mỗi đội có dự án tham gia. */
  perProjectGates: z.array(z.string().max(40)).max(5).default([]),
  autoApprove: sdlcAutoApprove.optional(),
});
export type SdlcPhase = z.output<typeof sdlcPhase>;

export const sdlcDecomposition = z.object({
  /** Tài liệu tách việc. */
  phase: sdlcSlugId,
  artifact: sdlcSlugId,
  parser: breakdownParser,
  granularity: breakdownGranularity,
  /** Regex mã requirement: `R-\d+` (hive), `FR-\d{3}` (speckit)… (D18). */
  requirementId: z.string().min(1).max(200),
  /** Tài liệu chứa requirement để tính độ phủ. */
  requirementSource: z.array(z.object({ phase: sdlcSlugId, artifact: sdlcSlugId })).max(5),
  maxTasks: z.number().int().min(1).max(100).default(30),
  maxChecklist: z.number().int().min(1).max(50).default(20),
});
export type SdlcDecomposition = z.output<typeof sdlcDecomposition>;

type Issue = (message: string, path: (string | number)[]) => void;

/** Checkpoint của cổng giai đoạn theo thứ tự chạy, kèm đường dẫn để báo lỗi đúng chỗ. */
function gatesOf(phase: SdlcPhase): { gate: ReviewGate; path: (string | number)[] }[] {
  return phase.gate.flatMap((p, pi) => p.gates.map((gate, gi) => ({ gate, path: ["gate", pi, "gates", gi] })));
}

/** Một chế độ có cỡ nặng thì giai đoạn yêu cầu của nó luôn cần người (D26), bất kể cỡ của hạng mục. */
export const isHeavySdlc = (modeSizes: readonly SdlcSize[], itemSize?: SdlcSize) =>
  modeSizes.some((s) => SDLC_HEAVY_SIZES.includes(s)) ||
  (itemSize !== undefined && SDLC_HEAVY_SIZES.includes(itemSize));

/** FR-056: tự duyệt chỉ cho cổng người, có checkpoint AI đứng trước, ngưỡng không thấp hơn điểm đạt của AI. */
function checkAutoApprove(phase: SdlcPhase, heavy: boolean, base: (string | number)[], issue: Issue) {
  const auto = phase.autoApprove;
  if (!auto) return;
  const path = [...base, "autoApprove"];
  if (phase.kind === "requirements" && heavy) issue("Giai đoạn yêu cầu của chế độ nặng luôn cần người duyệt.", path);
  const gates = gatesOf(phase).map((g) => g.gate);
  for (const [i, gateId] of auto.gates.entries()) {
    const at = gates.findIndex((g) => g.id === gateId);
    const gate = gates[at];
    if (!gate) {
      issue(`Không có checkpoint “${gateId}” trong cổng của giai đoạn.`, [...path, "gates", i]);
      continue;
    }
    if (gate.kind !== "human") {
      issue(`Chỉ tự duyệt được checkpoint người duyệt; “${gate.name}” không phải.`, [...path, "gates", i]);
      continue;
    }
    const ai = gates.slice(0, at).filter((g) => g.kind === "ai" && g.ai);
    if (!ai.length) {
      issue(`Cần checkpoint AI trước “${gate.name}” để có điểm tự duyệt.`, [...path, "gates", i]);
      continue;
    }
    const passScore = Math.max(...ai.map((g) => g.ai?.passScore ?? 0));
    if (auto.minScore < passScore)
      issue(`Ngưỡng tự duyệt không được thấp hơn điểm đạt ${passScore} của checkpoint AI.`, [...path, "minScore"]);
  }
}

/** Kiểm tham chiếu và luật của chế độ (FR-003, FR-056). Xuất riêng để hub báo lỗi khi đọc chế độ đã lưu. */
export function checkSdlcMode(m: z.output<typeof sdlcModeShape>, ctx: z.RefinementCtx) {
  const issue: Issue = (message, path) => ctx.addIssue({ code: "custom", message, path });
  const heavy = isHeavySdlc(m.sizes);
  const phaseIds = new Set<string>();
  // Id tài liệu nằm trong key tài liệu hub và trong `decomposition`, nên duy nhất trong cả chế độ, không chỉ giai đoạn.
  const artifacts = new Map<string, { phase: string; index: number }>();
  for (const [pi, phase] of m.phases.entries()) {
    const base = ["phases", pi];
    if (phaseIds.has(phase.id)) issue(`Mã giai đoạn “${phase.id}” trùng.`, [...base, "id"]);
    phaseIds.add(phase.id);
    for (const [ai, a] of phase.artifacts.entries()) {
      const path = [...base, "artifacts", ai];
      if (artifacts.has(a.id)) issue(`Mã tài liệu “${a.id}” trùng.`, [...path, "id"]);
      artifacts.set(a.id, { phase: phase.id, index: pi });
      const err = checkRepoPath(a.path, { contract: a.scope === "contract" });
      if (err) issue(err, [...path, "path"]);
      if (a.repeatable && a.scope !== "contract") issue("Chỉ contract mới lặp được.", [...path, "repeatable"]);
      if (a.scope === "contract" && !a.repeatable)
        issue("Contract phải lặp được (mỗi hạng mục 0..n contract).", [...path, "repeatable"]);
    }
  }
  for (const [pi, phase] of m.phases.entries()) {
    const base = ["phases", pi];
    const stepIds = new Set<string>();
    for (const [si, step] of phase.steps.entries()) {
      if (stepIds.has(step.id)) issue(`Mã bước “${step.id}” trùng trong giai đoạn.`, [...base, "steps", si, "id"]);
      stepIds.add(step.id);
      for (const [ai, ref] of step.artifacts.entries())
        if (!artifacts.has(ref))
          issue(`Bước “${step.id}” trỏ tới tài liệu “${ref}” không có.`, [...base, "steps", si, "artifacts", ai]);
    }
    const gates = gatesOf(phase);
    const gateIds = new Set<string>();
    for (const { gate, path } of gates) {
      if (gateIds.has(gate.id)) issue(`Mã checkpoint “${gate.id}” trùng trong giai đoạn.`, [...base, ...path, "id"]);
      gateIds.add(gate.id);
      if (
        gate.kind === "human" &&
        !(gate.reviewers?.users.length || gate.reviewers?.roles.length || gate.reviewers?.teams.length)
      )
        issue(`Checkpoint “${gate.name}” cần người duyệt.`, [...base, ...path]);
      if (gate.kind === "rule" && !gate.rules?.length)
        issue(`Checkpoint “${gate.name}” cần ít nhất một quy tắc.`, [...base, ...path]);
      if (gate.kind === "ai" && !gate.ai) issue(`Checkpoint “${gate.name}” cần danh sách AI kiểm.`, [...base, ...path]);
      if (gate.reviewers?.teamScope)
        issue("Đội của người duyệt do hub điền, không đặt trong chế độ.", [...base, ...path, "reviewers"]);
    }
    for (const [i, gateId] of phase.perProjectGates.entries()) {
      const gate = gates.find((g) => g.gate.id === gateId)?.gate;
      if (gate?.kind !== "human")
        issue(`Cổng theo dự án “${gateId}” phải là checkpoint người duyệt của giai đoạn.`, [
          ...base,
          "perProjectGates",
          i,
        ]);
    }
    checkAutoApprove(phase, heavy, base, issue);
  }
  const d = m.decomposition;
  if (d) {
    const target = artifacts.get(d.artifact);
    if (!target || target.phase !== d.phase)
      issue(`Tài liệu tách việc “${d.artifact}” không thuộc giai đoạn “${d.phase}”.`, ["decomposition", "artifact"]);
    for (const [i, src] of d.requirementSource.entries())
      if (artifacts.get(src.artifact)?.phase !== src.phase)
        issue(`Tài liệu requirement “${src.artifact}” không thuộc giai đoạn “${src.phase}”.`, [
          "decomposition",
          "requirementSource",
          i,
        ]);
    if (!BREAKDOWN_GRANULARITIES[d.parser].includes(d.granularity))
      issue(`Bộ đọc “${d.parser}” không tách theo độ mịn “${d.granularity}”.`, ["decomposition", "granularity"]);
    try {
      new RegExp(d.requirementId);
    } catch {
      issue("Mẫu mã requirement không phải regex hợp lệ.", ["decomposition", "requirementId"]);
    }
    const impl = m.phases.findIndex((p) => p.kind === "implementation");
    if (target && impl >= 0 && target.index >= impl)
      issue("Tài liệu tách việc phải ở giai đoạn trước giai đoạn triển khai.", ["decomposition", "phase"]);
  }
}

const sdlcModeShape = z.object({
  /** Id preset hoặc slug chế độ tự tạo. */
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(""),
  method: sdlcMethod,
  /** "express", "feature", "bugfix"… */
  profile: z.string().max(40),
  /** Cỡ phù hợp, dùng cho gợi ý và để xét chế độ "nặng" (D26). */
  sizes: z.array(sdlcSize).min(1).max(4),
  phases: z.array(sdlcPhase).min(1).max(12),
  /** null: một task (chế độ nhẹ). */
  decomposition: sdlcDecomposition.nullable(),
  blocking: sdlcBlocking.default("hard"),
  converge: z.object({ maxRounds: z.number().int().min(0).max(5).default(0) }).prefault({}),
  /** Số lượt agent sửa khi người duyệt trả lại hướng `agent` (FR-019). */
  maxAgentRevisions: z.number().int().min(0).max(5).default(2),
});

export const sdlcMode = sdlcModeShape.superRefine(checkSdlcMode);
export type SdlcMode = z.output<typeof sdlcMode>;
export type SdlcModeInput = z.input<typeof sdlcMode>;

/**
 * Cảnh báo không chặn lưu (US8-3): chặn cứng mà không có tài liệu bắt buộc nào trước giai đoạn triển khai thì không có
 * tác dụng.
 */
export function sdlcModeWarnings(mode: SdlcMode): string[] {
  const warnings: string[] = [];
  const impl = mode.phases.findIndex((p) => p.kind === "implementation");
  const before = impl < 0 ? mode.phases : mode.phases.slice(0, impl);
  if (mode.blocking === "hard" && !before.some((p) => p.artifacts.some((a) => a.required)))
    warnings.push("Chặn cứng không có tác dụng: chưa có tài liệu bắt buộc.");
  return warnings;
}

// ---- Hạng mục ---------------------------------------------------------------------------------------------------

export const SDLC_MAX_PROJECTS = 8;

export const sdlcSuggestion = z.object({
  size: sdlcSize,
  modeRef: z.string().max(80),
  /** "Đụng thanh toán, nhiều màn → L → Spec Kit". */
  reason: z.string().max(1000),
  alternatives: z.array(z.object({ modeRef: z.string().max(80), reason: z.string().max(1000) })).max(10),
});
export type SdlcSuggestion = z.output<typeof sdlcSuggestion>;

export const sdlcSuggestInput = z.object({
  projectId: id,
  title: z.string().trim().min(3).max(200),
  idea: z.string().trim().min(20, "Ý tưởng cần ít nhất 20 ký tự.").max(20_000),
  issueUrl: z.url().max(500).optional(),
});

export const sdlcItemCreate = z
  .object({
    /** Dự án chính: giữ số `NNN` và tài liệu chung. */
    projectId: id,
    /** Dự án tham gia khác, cùng tổ chức, đã bật AI SDLC (D19). */
    participants: z
      .array(id)
      .max(SDLC_MAX_PROJECTS - 1, `Hạng mục có tối đa ${SDLC_MAX_PROJECTS} dự án.`)
      .default([]),
    title: z.string().trim().min(3).max(200),
    idea: z.string().trim().min(20, "Ý tưởng cần ít nhất 20 ký tự.").max(20_000),
    issueUrl: z.url().max(500).optional(),
    modeRef: z.string().min(1).max(80),
    size: sdlcSize,
    /** Gợi ý hub đã trả, để audit ghi cả gợi ý và lựa chọn (FR-007). */
    suggestion: sdlcSuggestion.optional(),
  })
  .refine((d) => !d.participants.includes(d.projectId) && new Set(d.participants).size === d.participants.length, {
    message: "Dự án tham gia trùng nhau hoặc trùng dự án chính.",
    path: ["participants"],
  });
export type SdlcItemCreate = z.input<typeof sdlcItemCreate>;

export const sdlcItemStatus = z.enum(["active", "paused", "done", "cancelled"]);
export type SdlcItemStatus = z.output<typeof sdlcItemStatus>;
export const sdlcPhaseStatus = z.enum(["pending", "drafting", "awaiting_answers", "in_review", "approved", "skipped"]);
export type SdlcPhaseStatus = z.output<typeof sdlcPhaseStatus>;

export const sdlcItemSource = z.object({
  kind: z.enum(["manual", "issue", "leader", "repo"]),
  url: z.string().nullable().default(null),
  issueNumber: z.number().int().nullable().default(null),
  /** Thư mục trong repo khi nhận từ thư mục có sẵn. */
  path: z.string().nullable().default(null),
});

const projectRef = z.object({ id, key: z.string(), name: z.string() });
const personRef = z.object({ userId: z.string(), name: z.string() });

/** Dự án của hạng mục, kể cả dự án chính (D19). */
export const sdlcItemProject = projectRef.extend({
  teamId: id,
  teamName: z.string(),
  role: z.enum(["home", "participant"]),
  /** Dự án đã tắt AI SDLC hoặc bị lưu trữ: task của nó bị chặn. */
  enabled: z.boolean(),
  /** Bản chụp cài đặt lúc thêm; chặn, đồng bộ, song song, nhãn, nơi chạy, tự duyệt theo bản này. */
  settings: projectSdlcSettings,
  addedBy: z.string(),
  addedAt: z.iso.datetime(),
});
export type SdlcItemProject = z.output<typeof sdlcItemProject>;

/** Độ phủ ba mức (FR-034), phần trăm 0–100. */
export const sdlcCoverage = z.object({
  requirements: z.number().int(),
  /** Có task. */
  planned: z.number(),
  /** Mọi task chứa requirement đã merge. */
  done: z.number(),
  /** Có test hoặc CI chứng minh. */
  verified: z.number(),
});
export type SdlcCoverage = z.output<typeof sdlcCoverage>;

export const sdlcItemSummary = z.object({
  id,
  /** Dự án chính. */
  project: projectRef,
  number: z.number().int(),
  /** "012". */
  ref: z.string(),
  slug: z.string(),
  title: z.string(),
  modeRef: z.string(),
  modeName: z.string(),
  method: sdlcMethod,
  size: sdlcSize,
  status: sdlcItemStatus,
  /** Giai đoạn hiện tại; null khi đã xong mọi giai đoạn. */
  phase: z
    .object({
      id: z.string(),
      name: z.string(),
      kind: sdlcPhaseKind,
      status: sdlcPhaseStatus,
      index: z.number().int(),
      total: z.number().int(),
    })
    .nullable(),
  /** "Chờ An (PO) · quá hạn 3 giờ", "Chờ máy AI SDLC", "Chờ trả lời (2)"; null khi không chờ ai. */
  waitingFor: z.string().nullable(),
  waitingMachine: z.boolean(),
  openQuestions: z.number().int(),
  /** Dự án chính đứng đầu. */
  projects: z.array(projectRef.extend({ role: z.enum(["home", "participant"]) })),
  coverage: sdlcCoverage.nullable(),
  costUsd: z.number().nullable(),
  owner: personRef,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SdlcItemSummary = z.output<typeof sdlcItemSummary>;

export const sdlcItemPhase = z.object({
  id: z.string(),
  index: z.number().int(),
  name: z.string(),
  kind: sdlcPhaseKind,
  optional: z.boolean(),
  status: sdlcPhaseStatus,
  /** Lý do bỏ qua, lý do chờ. */
  note: z.string().nullable(),
  /** "1/2 tài liệu đã duyệt". */
  requiredApproved: z.number().int(),
  requiredTotal: z.number().int(),
  startedAt: z.iso.datetime().nullable(),
  approvedAt: z.iso.datetime().nullable(),
});
export type SdlcItemPhase = z.output<typeof sdlcItemPhase>;

export const sdlcSyncState = z.enum(["none", "pending", "synced", "failed", "drifted", "deleted"]);
export type SdlcSyncState = z.output<typeof sdlcSyncState>;

/** Trạng thái đồng bộ của một tài liệu với một repo: file nguồn hoặc bản sao contract (D23). */
export const sdlcArtifactSync = z.object({
  projectId: id,
  projectKey: z.string(),
  kind: z.enum(["source", "copy"]),
  repoPath: z.string(),
  state: sdlcSyncState,
  syncedVersion: z.number().int().nullable(),
  syncedCommit: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  syncedAt: z.iso.datetime().nullable(),
  /** PR đồng bộ đang mở (cách `pr`). */
  prUrl: z.string().nullable(),
});
export type SdlcArtifactSync = z.output<typeof sdlcArtifactSync>;

/** Cách tài liệu có baseline hiện tại (D26); `revoked`: đang duyệt lại sau khi thu hồi tự duyệt. */
export const sdlcApproval = z.enum(["none", "human", "auto", "revoked", "reaffirmed"]);
export type SdlcApproval = z.output<typeof sdlcApproval>;

export const sdlcArtifactView = z.object({
  /** Id dòng `sdlc_artifacts`. */
  id,
  phaseId: z.string(),
  artifactId: z.string(),
  name: z.string(),
  scope: sdlcArtifactScope,
  /** '' (item), key dự án (project), tên contract (contract). */
  instance: z.string(),
  required: z.boolean(),
  docKey: z.string(),
  repoPath: z.string(),
  /** Dự án giữ file nguồn: dự án chính, dự án đó, hoặc bên cung cấp contract. */
  projectId: id,
  /** Chỉ contract. */
  consumerProjectIds: z.array(id),
  contractFormat: contractFormat.nullable(),
  baselineVersion: z.number().int().nullable(),
  approval: sdlcApproval,
  /** Phiên duyệt đang mở; null khi không có. */
  reviewId: id.nullable(),
  hasDraft: z.boolean(),
  syncs: z.array(sdlcArtifactSync),
});
export type SdlcArtifactView = z.output<typeof sdlcArtifactView>;

export const sdlcQuestionStatus = z.enum(["open", "answered", "withdrawn"]);
export const sdlcQuestion = z.object({
  id,
  itemId: id,
  /** Để "Câu hỏi chờ tôi" hiện hạng mục mà không gọi thêm. */
  item: z.object({ ref: z.string(), title: z.string(), projectKey: z.string() }),
  phaseId: z.string(),
  round: z.number().int(),
  position: z.number().int(),
  text: z.string(),
  options: z.array(z.string()),
  recommended: z.string().nullable(),
  context: z.string().nullable(),
  status: sdlcQuestionStatus,
  answer: z.string().nullable(),
  usedRecommended: z.boolean(),
  answeredBy: personRef.nullable(),
  answeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type SdlcQuestion = z.output<typeof sdlcQuestion>;

export const sdlcStepStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const sdlcStepRun = z.object({
  id,
  phaseId: z.string(),
  stepId: z.string(),
  action: sdlcStepAction,
  round: z.number().int(),
  status: sdlcStepStatus,
  run: z.object({ id, state: runState }).nullable(),
  /** Lý do chờ máy ("Không máy nào có nhãn sdlc"). */
  waitingReason: z.string().nullable(),
  instructions: z.string().nullable(),
  /** Kết quả có cấu trúc (`size`, `findings`…). */
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type SdlcStepRun = z.output<typeof sdlcStepRun>;

/** Task hub của hạng mục, theo dự án của task (D24). */
export const sdlcItemTask = z.object({
  taskId: id,
  key: z.string(),
  title: z.string(),
  status: taskStatus,
  projectId: id,
  projectKey: z.string(),
  sliceKey: z.string(),
  wave: z.number().int(),
  requirementIds: z.array(z.string()),
  checklist: z.array(taskChecklistItem),
  dependsOn: z.array(id),
  /** Task phụ thuộc chưa `done` (có thể ở dự án khác). */
  blockedBy: z.array(z.object({ taskId: id, key: z.string(), projectKey: z.string(), status: taskStatus })),
  /** Đã bỏ khỏi tasks.md nhưng đã chạy: giữ và cảnh báo (FR-026). */
  removed: z.boolean(),
  run: z.object({ id, state: runState, prUrl: z.string().nullable() }).nullable(),
});
export type SdlcItemTask = z.output<typeof sdlcItemTask>;

export const sdlcOverride = z.object({
  id,
  itemId: id,
  /** Phạm vi: task (có `taskId`), dự án trong hạng mục (chỉ `projectId`), cả hạng mục (cả hai null). */
  taskId: id.nullable(),
  projectId: id.nullable(),
  reason: z.string(),
  decidedBy: personRef,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: personRef.nullable(),
  active: z.boolean(),
});
export type SdlcOverride = z.output<typeof sdlcOverride>;

/** Một điều kiện đã xét khi tự duyệt hoặc từ chối tự duyệt (US18-1). */
export const sdlcAutoCheck = z.object({ check: z.string(), passed: z.boolean(), detail: z.string() });

export const sdlcAutoApproval = z.object({
  id,
  itemId: id,
  artifactId: id,
  docKey: z.string(),
  artifactName: z.string(),
  reviewId: id,
  gateId: z.string(),
  gateName: z.string(),
  /** Phiên bản baseline tạo ra; null khi phiên chưa xong. */
  version: z.number().int().nullable(),
  score: z.number(),
  threshold: z.number(),
  reasons: z.array(sdlcAutoCheck),
  reviewer: z.object({ cli: z.string(), model: z.string().nullable() }).nullable(),
  decidedAt: z.iso.datetime(),
  revocableUntil: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: personRef.nullable(),
  revokeReason: z.string().nullable(),
  /** Phiên duyệt lại sau thu hồi. */
  rereviewId: id.nullable(),
  /** Người xem thu hồi được: còn hạn và là người đủ điều kiện duyệt, chủ hạng mục hoặc có `sdlc.override`. */
  canRevoke: z.boolean(),
});
export type SdlcAutoApproval = z.output<typeof sdlcAutoApproval>;

export const sdlcItemDetail = sdlcItemSummary.extend({
  idea: z.string(),
  source: sdlcItemSource,
  /** Bản chụp chế độ lúc tạo; sửa chế độ không đổi hạng mục đang mở. */
  mode: sdlcMode,
  sizeSuggested: sdlcSize.nullable(),
  suggestion: sdlcSuggestion.nullable(),
  /** Bản chụp cài đặt của dự án chính. */
  settings: projectSdlcSettings,
  /** Dự án chính đứng đầu. */
  projectsDetail: z.array(sdlcItemProject),
  phases: z.array(sdlcItemPhase),
  /** Tài liệu của mọi giai đoạn, cả contract. */
  artifacts: z.array(sdlcArtifactView),
  questions: z.array(sdlcQuestion),
  steps: z.array(sdlcStepRun),
  tasks: z.array(sdlcItemTask),
  overrides: z.array(sdlcOverride),
  autoApprovals: z.array(sdlcAutoApproval),
  /** "Contract refund-api đổi sau khi task T-41 chạy", "Dựa trên tài liệu đang duyệt lại". */
  warnings: z.array(z.string()),
  convergeRound: z.number().int(),
  convergedAt: z.iso.datetime().nullable(),
  can: z.object({
    write: z.boolean(),
    /** Tạm dừng, tiếp tục, huỷ, bỏ qua giai đoạn: chủ hạng mục hoặc `sdlc.override` ở đội chủ trì. */
    manage: z.boolean(),
    override: z.boolean(),
    runWaves: z.boolean(),
    /** Thêm/bỏ dự án tham gia: chủ hoặc quản trị đội chủ trì. */
    editProjects: z.boolean(),
    /** Đổi chế độ: chỉ khi giai đoạn đầu chưa có baseline. */
    changeMode: z.boolean(),
  }),
});
export type SdlcItemDetail = z.output<typeof sdlcItemDetail>;

// ---- Bản tách task ---------------------------------------------------------------------------------------------

/**
 * Một task hub trong bản tách (D8, D24): một run, một PR, trong đúng một dự án. Bộ đọc ở breakdown.ts; schema ở đây vì
 * nó là một phần của API.
 */
export const breakdownTask = z.object({
  /** Khoá lát ổn định giữa các lần duyệt: `T003`, `2.1`, `unit-billing`, hoặc tiêu đề phần đã bỏ dấu. */
  sliceKey: z.string().min(1).max(120),
  title: z.string().max(200),
  body: z.string().max(20_000),
  /** Key dự án của task; mặc định dự án chính. */
  project: z.string().max(40),
  requirementIds: z.array(z.string().max(40)).max(100),
  checklist: z
    .array(z.object({ id: z.string().max(40), text: z.string().max(500), requirementIds: z.array(z.string().max(40)) }))
    .max(50),
  /** Khoá lát của task phải xong trước. */
  dependsOn: z.array(z.string().max(120)).max(50),
  /** Đường dẫn file nêu trong task, cho luật nhạy cảm của tự duyệt (FR-058). */
  files: z.array(z.string().max(300)).max(200),
  /** Có thể chạy song song với task khác cùng đợt (`[P]`). */
  parallel: z.boolean(),
  /** Dòng bắt đầu task trong tài liệu nguồn, để báo lỗi đúng chỗ. */
  line: z.number().int().min(1),
});
export type BreakdownTaskSchema = z.output<typeof breakdownTask>;

export const breakdownError = z.object({ line: z.number().int().min(0), message: z.string() });
export type BreakdownError = z.output<typeof breakdownError>;

export const sdlcBreakdown = z.object({
  parser: breakdownParser,
  granularity: breakdownGranularity,
  tasks: z.array(breakdownTask).max(100),
  /** Đợt theo thứ tự topo: mỗi phần tử là khoá lát chạy được cùng lúc. */
  waves: z.array(z.array(z.string())),
  /** Requirement tìm thấy trong tài liệu yêu cầu. */
  requirements: z.array(z.string()),
});
export type SdlcBreakdown = z.output<typeof sdlcBreakdown>;

export const sdlcBreakdownView = z.object({
  itemId: id,
  source: z.enum(["draft", "baseline"]),
  docKey: z.string(),
  /** Phiên bản nội dung đã đọc; gửi lại khi lưu để hub từ chối khi tài liệu đã đổi. */
  revision: z.number().int(),
  /** null khi đọc lỗi. */
  breakdown: sdlcBreakdown.nullable(),
  errors: z.array(breakdownError),
  coverage: z.object({
    total: sdlcCoverage,
    byProject: z.array(z.object({ projectKey: z.string(), coverage: sdlcCoverage })),
    /** Requirement chưa có task. */
    missing: z.array(z.string()),
  }),
});
export type SdlcBreakdownView = z.output<typeof sdlcBreakdownView>;

// ---- Truy vết, chỉ số --------------------------------------------------------------------------------------------

export const sdlcTraceKind = z.enum(["task", "run", "pr", "commit", "test", "ci", "finding"]);
export const sdlcTraceRow = z.object({
  requirementId: z.string(),
  text: z.string(),
  /** Một dòng mỗi task chứa requirement; requirement "Chưa có task" có mảng rỗng. */
  tasks: z.array(
    z.object({
      taskId: id,
      key: z.string(),
      projectKey: z.string(),
      status: taskStatus,
      runId: id.nullable(),
      prUrl: z.string().nullable(),
      mergeSha: z.string().nullable(),
      tests: z.array(z.string()),
      ci: z.enum(["success", "failure", "pending", "none"]),
    }),
  ),
  findings: z.array(
    z.object({ status: z.enum(["met", "partial", "missing", "contradicts"]), evidence: z.string(), round: z.number() }),
  ),
  planned: z.boolean(),
  done: z.boolean(),
  verified: z.boolean(),
});
export type SdlcTraceRow = z.output<typeof sdlcTraceRow>;

export const sdlcTrace = z.object({
  itemId: id,
  rows: z.array(sdlcTraceRow),
  total: sdlcCoverage,
  byProject: z.array(z.object({ projectKey: z.string(), coverage: sdlcCoverage })),
  /** Có khi `format = csv`: một dòng mỗi (requirement, task), có cột dự án. */
  csv: z.string().nullable(),
});
export type SdlcTrace = z.output<typeof sdlcTrace>;

const duration = z.object({ p50: z.number().nullable(), p90: z.number().nullable(), count: z.number().int() });

export const sdlcMetrics = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  items: z.number().int(),
  /** Giờ, theo loại giai đoạn chuẩn. */
  leadTimeHours: z.array(z.object({ kind: sdlcPhaseKind, duration })),
  gateWaitHours: duration,
  /** Tỉ lệ phiên duyệt bị trả lại, 0–1. */
  returnRate: z.number().nullable(),
  questionsPerItem: z.number().nullable(),
  coverage: sdlcCoverage.nullable(),
  convergeRounds: z.number().nullable(),
  codeReviewRoundsPerPr: z.number().nullable(),
  costUsdPerItem: z.number().nullable(),
  autoApproval: z.array(
    z.object({
      modeRef: z.string(),
      projectKey: z.string().nullable(),
      /** Tỉ lệ cổng người được tự duyệt và tỉ lệ bị thu hồi, 0–1. */
      autoRate: z.number().nullable(),
      revokeRate: z.number().nullable(),
    }),
  ),
});
export type SdlcMetrics = z.output<typeof sdlcMetrics>;

// ---- Chế độ: danh sách, lưu, chạy thử ----------------------------------------------------------------------------

export const sdlcModeView = z.object({
  /** Id preset hoặc id dòng `sdlc_modes`. */
  ref: z.string(),
  preset: z.boolean(),
  /** Chế độ của đội; null là của tổ chức (hoặc preset). */
  teamId: id.nullable(),
  slug: z.string(),
  basePreset: z.string().nullable(),
  version: z.number().int(),
  enabled: z.boolean(),
  definition: sdlcMode,
  /** Số hạng mục mở đang dùng bản chụp của chế độ này. */
  openItems: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
});
export type SdlcModeView = z.output<typeof sdlcModeView>;

export const sdlcModeSaveInput = z.object({
  /** Bỏ trống là tạo mới. */
  id: id.optional(),
  teamId: id.nullable(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/, "Mã chế độ gồm chữ thường không dấu, số và -."),
  basePreset: z.string().max(80).nullable().default(null),
  definition: sdlcMode,
  enabled: z.boolean().default(true),
});
export type SdlcModeSaveInput = z.input<typeof sdlcModeSaveInput>;

export const sdlcModeDryRunInput = z.object({
  mode: sdlcMode,
  projectKey,
  title: z.string().trim().min(3).max(200),
  size: sdlcSize.optional(),
  participants: z
    .array(projectKey)
    .max(SDLC_MAX_PROJECTS - 1)
    .default([]),
});

export const sdlcModeDryRun = z.object({
  phases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: sdlcPhaseKind,
      /** Bị bỏ vì cỡ ngoài `sizes`. */
      skipped: z.boolean(),
      artifacts: z.array(z.object({ artifactId: z.string(), path: z.string(), docKey: z.string() })),
      gates: z.array(
        z.object({
          gateId: z.string(),
          name: z.string(),
          runs: z.boolean(),
          reason: z.string(),
          autoApprove: z.boolean(),
        }),
      ),
    }),
  ),
  warnings: z.array(z.string()),
});
export type SdlcModeDryRun = z.output<typeof sdlcModeDryRun>;

// ---- Đầu vào route -----------------------------------------------------------------------------------------------

const reasonText = (min: number, message: string) => z.string().trim().min(min, message).max(2000);

export const sdlcItemListInput = z.object({
  /** `mine`: hạng mục tôi là chủ hoặc đang chờ tôi. */
  scope: z.enum(["mine", "all"]).default("all"),
  /** Khớp mọi dự án tham gia, không chỉ dự án chính. */
  projectId: id.optional(),
  status: sdlcItemStatus.optional(),
  phaseKind: sdlcPhaseKind.optional(),
  modeRef: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const sdlcItemGetInput = z
  .object({ id: id.optional(), projectKey: projectKey.optional(), number: z.coerce.number().int().min(1).optional() })
  .refine((d) => d.id || (d.projectKey && d.number), { message: "Cần id hoặc dự án và số hạng mục." });

export const sdlcContractInput = z
  .object({
    itemId: id,
    name: sdlcSlugId,
    format: contractFormat,
    providerProjectId: id,
    consumerProjectIds: z
      .array(id)
      .min(1)
      .max(SDLC_MAX_PROJECTS - 1),
  })
  .refine((d) => !d.consumerProjectIds.includes(d.providerProjectId), {
    message: "Bên cung cấp không đồng thời là bên dùng.",
    path: ["consumerProjectIds"],
  });
export type SdlcContractInput = z.input<typeof sdlcContractInput>;

export const sdlcAnswerInput = z.object({
  itemId: id,
  answers: z
    .array(
      z
        .object({ id, answer: z.string().trim().min(1).max(4000).optional(), useRecommended: z.boolean().optional() })
        .refine((a) => !!a.answer !== !!a.useRecommended, { message: "Trả lời hoặc chọn dùng đề xuất." }),
    )
    .min(1)
    .max(50),
});

export const sdlcOverrideInput = z
  .object({
    itemId: id,
    taskId: id.optional(),
    projectId: id.optional(),
    reason: reasonText(10, "Lý do ngoại lệ cần ít nhất 10 ký tự."),
    expiresAt: z.iso.datetime().optional(),
  })
  .refine((d) => !(d.taskId && d.projectId), {
    message: "Chọn một phạm vi: task, dự án, hoặc cả hạng mục.",
    path: ["projectId"],
  });

const itemPage = z.object({ items: z.array(sdlcItemSummary), nextCursor: z.string().nullable() });
const okOutput = z.object({ ok: z.literal(true) });

export const sdlcContract = {
  modes: {
    list: orgRoute("GET", "/v1/sdlc/modes", "Preset và chế độ AI SDLC tự tạo trong phạm vi", "sdlc")
      .input(z.object({ teamId: id.optional() }))
      .output(z.array(sdlcModeView)),
    save: orgRoute("POST", "/v1/sdlc/modes/save", "Lưu chế độ AI SDLC tự tạo (sdlc.modes.write)", "sdlc")
      .input(sdlcModeSaveInput)
      .output(sdlcModeView),
    remove: orgRoute("POST", "/v1/sdlc/modes/remove", "Xoá chế độ AI SDLC tự tạo (sdlc.modes.write)", "sdlc")
      .input(z.object({ id }))
      .output(okOutput),
    dryRun: orgRoute("POST", "/v1/sdlc/modes/dry-run", "Chạy thử chế độ: đường dẫn, cổng, checkpoint bỏ qua", "sdlc")
      .input(sdlcModeDryRunInput)
      .output(sdlcModeDryRun),
  },
  suggest: orgRoute("POST", "/v1/sdlc/suggest", "Gợi ý cỡ việc và chế độ bằng luật tất định", "sdlc")
    .input(sdlcSuggestInput)
    .output(sdlcSuggestion),
  items: {
    create: orgRoute("POST", "/v1/sdlc/items/create", "Tạo hạng mục (sdlc.write ở đội của mọi dự án chọn)", "sdlc")
      .input(sdlcItemCreate)
      .output(sdlcItemDetail),
    import: orgRoute("POST", "/v1/sdlc/items/import", "Nhận thư mục tài liệu có sẵn trong repo làm hạng mục", "sdlc")
      .input(z.object({ projectId: id, path: repoPathTemplate, modeRef: z.string().min(1).max(80), size: sdlcSize }))
      .output(sdlcItemDetail),
    list: orgRoute("GET", "/v1/sdlc/items", "Hạng mục AI SDLC mình thấy được", "sdlc")
      .input(sdlcItemListInput)
      .output(itemPage),
    get: orgRoute("GET", "/v1/sdlc/items/item", "Chi tiết hạng mục", "sdlc")
      .input(sdlcItemGetInput)
      .output(sdlcItemDetail),
    step: orgRoute("POST", "/v1/sdlc/items/step", "Chạy hoặc chạy lại bước agent", "sdlc")
      .input(
        z.object({ id, phaseId: sdlcSlugId, stepId: sdlcSlugId, instructions: z.string().trim().max(4000).optional() }),
      )
      .output(sdlcItemDetail),
    skipPhase: orgRoute("POST", "/v1/sdlc/items/skip-phase", "Bỏ qua giai đoạn tuỳ chọn", "sdlc")
      .input(z.object({ id, phaseId: sdlcSlugId, reason: reasonText(3, "Ghi lý do bỏ qua giai đoạn.") }))
      .output(sdlcItemDetail),
    pause: orgRoute("POST", "/v1/sdlc/items/pause", "Tạm dừng hạng mục: không tạo run mới", "sdlc")
      .input(z.object({ id }))
      .output(sdlcItemDetail),
    resume: orgRoute("POST", "/v1/sdlc/items/resume", "Tiếp tục hạng mục", "sdlc")
      .input(z.object({ id }))
      .output(sdlcItemDetail),
    cancel: orgRoute("POST", "/v1/sdlc/items/cancel", "Huỷ hạng mục", "sdlc")
      .input(z.object({ id, reason: reasonText(3, "Ghi lý do huỷ.").optional() }))
      .output(sdlcItemDetail),
    changeMode: orgRoute("POST", "/v1/sdlc/items/change-mode", "Đổi chế độ khi giai đoạn đầu chưa có baseline", "sdlc")
      .input(z.object({ id, modeRef: z.string().min(1).max(80) }))
      .output(sdlcItemDetail),
    projects: {
      add: orgRoute("POST", "/v1/sdlc/items/projects/add", "Thêm dự án tham gia", "sdlc")
        .input(z.object({ id, projectId: id }))
        .output(sdlcItemDetail),
      remove: orgRoute("POST", "/v1/sdlc/items/projects/remove", "Bỏ dự án tham gia chưa có task đã chạy", "sdlc")
        .input(z.object({ id, projectId: id }))
        .output(sdlcItemDetail),
    },
  },
  board: orgRoute("GET", "/v1/sdlc/board", "Bảng hạng mục theo loại giai đoạn chuẩn", "sdlc")
    .input(z.object({ projectId: id.optional(), modeRef: z.string().max(80).optional() }))
    .output(z.object({ columns: z.array(z.object({ kind: sdlcPhaseKind, items: z.array(sdlcItemSummary) })) })),
  contracts: {
    create: orgRoute("POST", "/v1/sdlc/contracts/create", "Thêm contract liên repo", "sdlc")
      .input(sdlcContractInput)
      .output(sdlcArtifactView),
    update: orgRoute("POST", "/v1/sdlc/contracts/update", "Đổi bên dùng contract chưa có baseline", "sdlc")
      .input(
        z.object({
          id,
          consumerProjectIds: z
            .array(id)
            .min(1)
            .max(SDLC_MAX_PROJECTS - 1),
        }),
      )
      .output(sdlcArtifactView),
  },
  autoApprovals: {
    list: orgRoute("GET", "/v1/sdlc/auto-approvals", "Lần tự duyệt AI của hạng mục và hạn thu hồi", "sdlc")
      .input(z.object({ itemId: id }))
      .output(z.array(sdlcAutoApproval)),
    revoke: orgRoute("POST", "/v1/sdlc/auto-approvals/revoke", "Thu hồi tự duyệt AI trong hạn", "sdlc")
      .input(z.object({ id, reason: reasonText(10, "Lý do thu hồi cần ít nhất 10 ký tự.") }))
      .output(sdlcAutoApproval),
  },
  questions: {
    list: orgRoute("GET", "/v1/sdlc/questions", "Câu hỏi của agent", "sdlc")
      .input(
        z.object({
          /** `mine`: câu hỏi của hạng mục tôi là chủ hoặc người tạo. */
          scope: z.enum(["mine", "all"]).default("mine"),
          projectId: id.optional(),
          itemId: id.optional(),
          openOnly: queryFlag.default(true),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().max(200).optional(),
        }),
      )
      .output(z.object({ items: z.array(sdlcQuestion), nextCursor: z.string().nullable() })),
    count: orgRoute("GET", "/v1/sdlc/questions/count", "Số câu hỏi đang chờ tôi", "sdlc").output(
      z.object({ open: z.number().int().nonnegative() }),
    ),
    answer: orgRoute("POST", "/v1/sdlc/questions/answer", "Trả lời câu hỏi hoặc dùng đề xuất", "sdlc")
      .input(sdlcAnswerInput)
      .output(z.array(sdlcQuestion)),
  },
  breakdown: {
    get: orgRoute("GET", "/v1/sdlc/breakdown", "Bản tách task đọc từ tài liệu tách việc", "sdlc")
      .input(z.object({ id, source: z.enum(["draft", "baseline"]).default("draft") }))
      .output(sdlcBreakdownView),
    save: orgRoute(
      "POST",
      "/v1/sdlc/breakdown/save",
      "Ghi lại tài liệu tách việc vào bản nháp từ bản tách đã sửa",
      "sdlc",
    )
      .input(z.object({ id, breakdown: sdlcBreakdown, baseRevision: z.number().int().min(0) }))
      .output(sdlcBreakdownView),
  },
  waves: {
    run: orgRoute("POST", "/v1/sdlc/waves/run", "Chạy đợt task sẵn sàng", "sdlc")
      .input(z.object({ id, projectId: id.optional() }))
      .output(
        z.object({
          started: z.array(z.object({ taskId: id, runId: id })),
          /** Task sẵn sàng nhưng không chạy: thiếu quyền ở dự án, chạm mức song song, bị chặn. */
          skipped: z.array(z.object({ taskId: id, key: z.string(), reason: z.string() })),
        }),
      ),
  },
  overrides: {
    create: orgRoute("POST", "/v1/sdlc/overrides/create", "Tạo ngoại lệ chặn run code (sdlc.override)", "sdlc")
      .input(sdlcOverrideInput)
      .output(sdlcOverride),
    revoke: orgRoute("POST", "/v1/sdlc/overrides/revoke", "Thu hồi ngoại lệ chặn", "sdlc")
      .input(z.object({ id }))
      .output(sdlcOverride),
  },
  trace: orgRoute("GET", "/v1/sdlc/trace", "Ma trận truy vết và độ phủ", "sdlc")
    .input(z.object({ id, projectId: id.optional(), format: z.enum(["json", "csv"]).default("json") }))
    .output(sdlcTrace),
  metrics: orgRoute("GET", "/v1/sdlc/metrics", "Chỉ số AI SDLC", "sdlc")
    .input(
      z.object({
        projectId: id.optional(),
        modeRef: z.string().max(80).optional(),
        from: z.iso.datetime(),
        to: z.iso.datetime(),
      }),
    )
    .output(sdlcMetrics),
  sync: orgRoute("POST", "/v1/sdlc/sync", "Đồng bộ lại hoặc ghi đè repo bằng baseline (quản trị dự án)", "sdlc")
    .input(z.object({ id, projectId: id, action: z.enum(["retry", "overwrite-repo"]) }))
    .output(z.array(sdlcArtifactSync)),
};

// ---- MCP (run `sdlc` và run code của task hạng mục) ---------------------------------------------------------------

export const SDLC_MAX_QUESTIONS = 5;

/** `sdlc_ask`: tối đa 5 câu mỗi vòng; hub nhận 5 câu đầu và báo agent phần bị bỏ (US2-2). */
export const sdlcAskInput = z.object({
  questions: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(2000),
        options: z.array(z.string().trim().min(1).max(500)).max(6).default([]),
        recommended: z.string().trim().max(500).optional(),
        context: z.string().trim().max(2000).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const sdlcFinding = z.object({
  requirementId: z.string().max(40),
  status: z.enum(["met", "partial", "missing", "contradicts"]),
  evidence: z.string().max(4000),
  /** Task bổ sung đề xuất cho `missing`, `contradicts`. */
  suggestedTask: z.string().max(500).optional(),
});

/** `sdlc_report`: dữ liệu có cấu trúc theo loại bước (D6, D23). Contract theo key dự án tham gia. */
export const sdlcReportInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("size"),
    data: z.object({ size: sdlcSize, modeRef: z.string().max(80), reason: z.string().max(2000) }),
  }),
  z.object({ kind: z.literal("findings"), data: z.object({ findings: z.array(sdlcFinding).max(200) }) }),
  z.object({
    kind: z.literal("analysis"),
    data: z.object({
      score: z.number().min(0).max(10).optional(),
      findings: z
        .array(
          z.object({
            severity: findingSeverity,
            message: z.string().max(4000),
            artifact: z.string().max(40).optional(),
          }),
        )
        .max(200),
      checklist: z.array(checklistItem).max(30).default([]),
    }),
  }),
  z.object({ kind: z.literal("summary"), data: z.object({ summary: z.string().max(20_000) }) }),
  /**
   * Bài học của retro (FR-036): toàn bộ nội dung mới của constitution/steering; hub tạo đề xuất thường. Bỏ `key` là
   * `project/<dự án chính>/constitution`.
   */
  z.object({
    kind: z.literal("lessons"),
    data: z.object({
      key: docKey.optional(),
      content: z.string().min(1).max(DOC_MAX_CHARS),
      reason: z.string().trim().min(1).max(2000),
    }),
  }),
  z.object({
    kind: z.literal("contracts"),
    data: z.object({
      contracts: z
        .array(
          z.object({
            name: sdlcSlugId,
            format: contractFormat,
            provider: projectKey,
            consumers: z
              .array(projectKey)
              .min(1)
              .max(SDLC_MAX_PROJECTS - 1),
            content: z.string().max(200_000),
          }),
        )
        .max(20),
    }),
  }),
]);
export type SdlcReportInput = z.output<typeof sdlcReportInput>;
