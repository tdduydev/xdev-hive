import { type CodeScope, matchGlob } from "@xdev-hive/contracts";

/** Run code vừa kết thúc, đủ để xét phạm vi của quy trình. */
export interface MatchRun {
  /** Đội sở hữu dự án: quy trình của đội khác không bao giờ khớp. */
  teamId: string;
  projectKey: string;
  /** Nhánh PR nhắm tới và nhánh mặc định của dự án (khi `baseBranches` rỗng chỉ nhánh mặc định khớp). */
  baseBranch: string;
  defaultBranch: string;
  taskType: string | null;
  /** null khi worker cũ không báo `diffStats`: điều kiện đường dẫn không kiểm được. */
  changedFiles: string[] | null;
}

export interface MatchCandidate {
  /** null với bản nháp chưa lưu (chạy thử). */
  id: string | null;
  name: string;
  /** null là quy trình của tổ chức. */
  teamId: string | null;
  scope: CodeScope;
  updatedAt: Date;
}

export interface ScopeVerdict {
  matches: boolean;
  reason: string;
}

/** Phạm vi có khớp run không, kèm lý do để chạy thử hiện cho quản trị. */
export function scopeMatches(scope: CodeScope, run: MatchRun, teamId: string | null): ScopeVerdict {
  if (teamId && teamId !== run.teamId) return { matches: false, reason: "Quy trình của đội khác." };
  if (scope.projects.length && !scope.projects.includes(run.projectKey))
    return { matches: false, reason: `Dự án ${run.projectKey} không thuộc ${scope.projects.join(", ")}.` };
  if (scope.baseBranches.length) {
    if (!scope.baseBranches.some((g) => matchGlob(g, run.baseBranch)))
      return { matches: false, reason: `Nhánh đích ${run.baseBranch} không khớp ${scope.baseBranches.join(", ")}.` };
  } else if (run.baseBranch !== run.defaultBranch) {
    return {
      matches: false,
      reason: `Nhánh đích ${run.baseBranch} không phải nhánh mặc định ${run.defaultBranch}.`,
    };
  }
  if (scope.taskTypes.length && !(run.taskType && scope.taskTypes.includes(run.taskType)))
    return {
      matches: false,
      reason: `Loại task ${run.taskType ?? "(không có)"} không thuộc ${scope.taskTypes.join(", ")}.`,
    };
  if (scope.paths.length) {
    // Thiếu số liệu thì thà review thừa còn hơn bỏ sót, giống `reviewSkipReason` của chính sách kết quả.
    if (run.changedFiles === null) return { matches: true, reason: "Chưa biết file đổi; coi như khớp đường dẫn." };
    if (!run.changedFiles.some((f) => scope.paths.some((g) => matchGlob(g, f))))
      return { matches: false, reason: `Không file nào đổi khớp ${scope.paths.join(", ")}.` };
  }
  return { matches: true, reason: "Khớp phạm vi." };
}

/** Độ cụ thể: liệt kê dự án > của đội > của tổ chức. */
const specificity = (c: MatchCandidate) => (c.scope.projects.length ? 2 : c.teamId ? 1 : 0);

/** Thứ tự ưu tiên: cụ thể hơn trước, cùng mức thì cập nhật gần nhất; id chốt thứ tự để kết quả không phụ thuộc đầu vào. */
function compare(a: MatchCandidate, b: MatchCandidate): number {
  return (
    specificity(b) - specificity(a) ||
    b.updatedAt.getTime() - a.updatedAt.getTime() ||
    (a.id ?? "").localeCompare(b.id ?? "")
  );
}

export interface MatchResult<T extends MatchCandidate> {
  chosen: T | null;
  /** Cũng khớp nhưng bị `chosen` lấn, theo thứ tự ưu tiên. */
  outranked: T[];
}

/** Chọn quy trình cho run trong số các quy trình đang bật. */
export function matchCodeWorkflow<T extends MatchCandidate>(candidates: T[], run: MatchRun): MatchResult<T> {
  const hits = candidates.filter((c) => scopeMatches(c.scope, run, c.teamId).matches).sort(compare);
  return { chosen: hits[0] ?? null, outranked: hits.slice(1) };
}
