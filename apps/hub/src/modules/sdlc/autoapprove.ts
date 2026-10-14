import {
  type FindingSeverity,
  foldText,
  isHeavySdlc,
  matchGlob,
  type OrgSdlcPolicy,
  type ProjectSdlcSettings,
  type SdlcArtifactScope,
  type SdlcAutoApprove,
  type SdlcPhaseKind,
  type SdlcSize,
} from "@xdev-hive/contracts";

// Tự duyệt AI (specs/011 D25, D26). File này giữ phần thuần: điều kiện nào cho phép hub thay người duyệt một checkpoint.
// Phần đọc DB, ghi `sdlc_auto_approvals` và thu hồi nối vào đây sau khi hạng mục (T012) và cổng chặn run (T013) có.

/** Một dự án có tiếng nói trong quyết định: dự án của checkpoint, hoặc mọi dự án tham gia khi cổng là cổng chung. */
export interface AutoProjectInput {
  key: string;
  autoApprove: ProjectSdlcSettings["autoApprove"];
}

/** Một reviewer AI của checkpoint `ai` đã đạt trong phiên. */
export interface AutoReviewerInput {
  cli: string;
  model: string | null;
  score: number | null;
}

export interface AutoDecideInput {
  org: OrgSdlcPolicy["autoApprove"];
  projects: AutoProjectInput[];
  mode: { sizes: readonly SdlcSize[] };
  item: { size?: SdlcSize | undefined };
  phase: { id: string; kind: SdlcPhaseKind; autoApprove?: SdlcAutoApprove | undefined };
  /** Id checkpoint người đang chờ. */
  gateId: string;
  artifact: { scope: SdlcArtifactScope };
  /** `null`: phiên chưa có checkpoint AI nào đạt. */
  ai: {
    reviewers: AutoReviewerInput[];
    /** Mức nặng nhất trong các phát hiện của reviewer; `null` là không có phát hiện. */
    worstFinding: FindingSeverity | null;
    /** Mục kiểm không đạt (nhãn). */
    failedChecks: string[];
  } | null;
  /** CLI và model của run viết bản nháp; `null` khi người viết tay. */
  author: { cli: string; model: string | null } | null;
  /** Chữ đổi so với baseline (bản đầu thì cả tài liệu) để dò từ khoá nhạy cảm. */
  changedText: string;
  /** Đường dẫn repo nêu trong tài liệu hoặc file của task, để khớp `denyPaths`. */
  paths: string[];
}

export type AutoDecision =
  | { approve: true; score: number; threshold: number; revokeHours: number; reasons: [] }
  | {
      approve: false;
      /** Chế độ không cho tự duyệt cổng này: không phải lý do để hiện cho người duyệt. */
      silent: boolean;
      reasons: string[];
    };

const refuse = (...reasons: string[]): AutoDecision => ({ approve: false, silent: false, reasons });

// So khi thiếu dữ liệu: một bên chưa rõ model thì không chứng minh được là khác tác giả, nên coi là trùng.
const sameAgent = (a: { cli: string; model: string | null }, b: { cli: string; model: string | null }) =>
  a.cli === b.cli && (a.model === null || b.model === null || a.model === b.model);

const normalizePath = (p: string) =>
  p
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");

const SEVERE: readonly FindingSeverity[] = ["critical", "major"];

/**
 * Điều kiện cấu trúc (tổ chức, chế độ, dự án, loại tài liệu) dừng ngay: có một điều kiện trượt là phần còn lại vô nghĩa.
 * Điều kiện chất lượng (điểm, phát hiện, reviewer, nhạy cảm) gom hết để người duyệt thấy đủ lý do trong một lần.
 */
export function decide(input: AutoDecideInput): AutoDecision {
  const { org, phase, projects } = input;
  if (!org.allowed) return refuse("Tổ chức đã tắt tự duyệt.");
  const rule = phase.autoApprove;
  if (!rule?.gates.includes(input.gateId)) return { approve: false, silent: true, reasons: [] };

  const off = projects.filter((p) => {
    const only = p.autoApprove.phases;
    return !p.autoApprove.enabled || (only !== undefined && only.length > 0 && !only.includes(phase.id));
  });
  if (projects.length === 0 || off.length > 0)
    return refuse(
      off.length > 0
        ? `Dự án ${off.map((p) => p.key).join(", ")} chưa bật tự duyệt cho giai đoạn này.`
        : "Hạng mục chưa có dự án nào bật tự duyệt.",
    );
  if (input.artifact.scope === "contract") return refuse("Contract luôn cần người duyệt.");
  if (phase.kind === "requirements" && isHeavySdlc(input.mode.sizes, input.item.size))
    return refuse("Yêu cầu của hạng mục nặng luôn cần người duyệt.");
  if (!input.ai || input.ai.reviewers.length === 0) return refuse("Chưa có điểm review AI.");

  const reasons: string[] = [];
  const scores = input.ai.reviewers.map((r) => r.score);
  // Mức thấp nhất của các reviewer (injection vào một reviewer không kéo điểm chung lên); thiếu điểm của ai là chưa chấm xong.
  const score = scores.includes(null) ? null : Math.min(...(scores as number[]));
  const threshold = Math.max(rule.minScore, org.minScoreFloor, ...projects.map((p) => p.autoApprove.minScore ?? 0));
  if (score === null) reasons.push("Chưa có điểm review AI.");
  else if (score < threshold) reasons.push(`Điểm ${score} < ngưỡng ${threshold}.`);
  if (input.ai.worstFinding && SEVERE.includes(input.ai.worstFinding))
    reasons.push(`Review AI có phát hiện mức ${input.ai.worstFinding}.`);
  if (input.ai.failedChecks.length > 0) reasons.push(`Mục kiểm không đạt: ${input.ai.failedChecks.join("; ")}.`);

  const { author } = input;
  if (author && input.ai.reviewers.some((r) => sameAgent(r, author))) reasons.push("Reviewer trùng tác giả.");

  const folded = foldText(input.changedText);
  const keywords = [...org.denyKeywords, ...projects.flatMap((p) => p.autoApprove.denyKeywords)];
  const keyword = keywords.find((k) => folded.includes(foldText(k)));
  if (keyword) reasons.push(`Từ khoá nhạy cảm '${keyword}'.`);

  const globs = [...org.denyPaths, ...projects.flatMap((p) => p.autoApprove.denyPaths)];
  for (const path of input.paths.map(normalizePath)) {
    if (globs.some((g) => matchGlob(g, path))) {
      reasons.push(`Đường dẫn nhạy cảm ${path}.`);
      break;
    }
  }

  if (reasons.length > 0 || score === null) return refuse(...reasons);
  const revokeHours = Math.max(rule.revokeHours, ...projects.map((p) => p.autoApprove.revokeHours ?? 0));
  return { approve: true, score, threshold, revokeHours, reasons: [] };
}
