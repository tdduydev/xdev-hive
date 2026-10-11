import type { CheckOutcome, OutcomeCheck } from "@xdev-hive/contracts";
import type { DiffStats } from "@xdev-hive/contracts/worker-protocol";

export type Outcome = "succeeded" | "no_changes" | "needs_review" | "failed";

export interface Evidence {
  exit: number;
  headSha: string | null;
  /** Báo cáo của worker trong run_result: `commitCount`, `changedFiles`, `error`. */
  report: Record<string, unknown> | null;
  /** Có run_event `agent_report` trong lần thử này. */
  hasAgentReport: boolean;
  diffStats?: DiffStats | undefined;
  /** Kết quả review chéo cho kiểm tra `review`. Bỏ trống khi dự án tắt tính năng: kiểm tra đó cần người xem như cũ. */
  review?: ReviewEvidence | undefined;
}

/**
 * Trạng thái review chéo của run code. `pending`: chưa có run review, chính sách chờ nó. `unavailable`: không review
 * được (vd. không có PR), cần người xem. `done`: run review đã nộp điểm. `failed`: run review lỗi, hết lượt, bị huỷ
 * hoặc không gọi review_submit.
 */
export type ReviewEvidence =
  | { status: "pending" }
  | { status: "unavailable"; reason: string }
  | { status: "done"; score: number; by: string | null }
  | { status: "failed"; reason: string };

export interface Evaluation {
  outcome: Outcome;
  checks: CheckOutcome[];
  reasons: string[];
  commitCount: number | null;
  changedFiles: string[];
  /** Có commit để mở PR. */
  hasChanges: boolean;
  /**
   * Mọi kiểm tra khác không chặn run và còn chờ review chéo: hub mở PR, tạo run review rồi chạy lại chính sách khi
   * run review xong. `outcome` lúc này chỉ là tạm (needs_review).
   */
  awaitingReview: boolean;
}

const UNSUPPORTED: Record<string, string> = {
  command: "chạy lệnh trong worktree",
  review: "review chéo bởi agent khác",
  ci: "chờ CI trên PR",
};

const SKIPPED_REVIEW = "Bỏ qua review chéo vì run không đạt kiểm tra khác.";

export function reviewSkipReason(c: Extract<OutcomeCheck, { check: "review" }>, stats?: DiffStats): string | null {
  // Thiếu số liệu (worker cũ) thì giữ review, kể cả khi cấu hình chỉ xét đường dẫn.
  if (!c.when || !stats) return null;
  const changedLines = stats.addedLines + stats.deletedLines;
  if (c.when.minChangedLines !== undefined && changedLines >= c.when.minChangedLines) return null;
  if (stats.changedFiles.some((f) => (c.when?.paths ?? []).some((g) => matchGlob(g, f)))) return null;
  const details = [`diff ${changedLines} dòng`];
  if (c.when.minChangedLines !== undefined) details.push(`dưới ngưỡng ${c.when.minChangedLines}`);
  if (c.when.paths) details.push("không đụng đường dẫn quan trọng");
  return `Bỏ qua review chéo: ${details.join(", ")}.`;
}

function reviewOutcome(c: Extract<OutcomeCheck, { check: "review" }>, r: ReviewEvidence): CheckOutcome {
  const base = { check: c.check, required: c.required };
  switch (r.status) {
    case "pending":
      return { ...base, passed: null, message: `Đang chờ review chéo bởi ${c.by}.` };
    case "unavailable":
      return { ...base, passed: null, message: r.reason };
    case "done": {
      const passed = r.score >= c.minScore;
      const who = r.by ? ` của ${r.by}` : "";
      return {
        ...base,
        passed,
        message: `Điểm review chéo${who}: ${r.score}/10 (ngưỡng ${c.minScore})${passed ? "." : ", chưa đạt."}`,
      };
    }
    case "failed":
      return { ...base, passed: false, message: `Review chéo không có kết quả: ${r.reason}` };
  }
}

/**
 * Chính sách kết quả ở bước verifying (docs/decisions.md, "điều kiện thành công của run cấu hình động"). Kiểm tra bắt
 * buộc không đạt → failed; không có commit khi chính sách có `changes` → no_changes; kiểm tra mềm không đạt hoặc hub
 * chưa hỗ trợ → needs_review; còn lại succeeded.
 */
export function evaluatePolicy(policy: OutcomeCheck[], ev: Evidence): Evaluation {
  const report = ev.report ?? {};
  const changedFiles = Array.isArray(report.changedFiles)
    ? report.changedFiles.filter((f): f is string => typeof f === "string")
    : [];
  const commitCount = typeof report.commitCount === "number" ? report.commitCount : null;
  // Worker cũ có thể không đếm commit; khi đó có headSha là có thay đổi.
  const hasChanges = ev.headSha !== null && (commitCount === null || commitCount > 0);
  const base = { commitCount, changedFiles, hasChanges, awaitingReview: false };

  if (ev.exit !== 0) {
    const detail = typeof report.error === "string" && report.error ? `: ${report.error}` : "";
    return {
      ...base,
      outcome: "failed",
      checks: [],
      reasons: [`Agent kết thúc với mã lỗi ${ev.exit}${detail}.`],
    };
  }

  const checks: CheckOutcome[] = [];
  let noChanges = false;
  for (const c of policy) {
    if (c.check === "changes") {
      if (!hasChanges) {
        noChanges = true;
        checks.push({ check: c.check, required: c.required, passed: false, message: "Không có commit mới." });
        continue;
      }
      const problems: string[] = [];
      if (c.maxFiles !== undefined && changedFiles.length > c.maxFiles) {
        problems.push(`Đổi ${changedFiles.length} file, vượt giới hạn ${c.maxFiles}.`);
      }
      const denied = changedFiles.filter((f) => (c.deny ?? []).some((g) => matchGlob(g, f)));
      if (denied.length) problems.push(`Đụng đường dẫn cấm: ${denied.slice(0, 10).join(", ")}.`);
      checks.push({
        check: c.check,
        required: c.required,
        passed: problems.length === 0,
        message: problems.length ? problems.join(" ") : `${commitCount ?? "Có"} commit, ${changedFiles.length} file.`,
      });
    } else if (c.check === "review") {
      const reason = reviewSkipReason(c, ev.diffStats);
      checks.push(
        reason
          ? { check: c.check, required: c.required, passed: null, skipped: true, message: reason }
          : ev.review
            ? reviewOutcome(c, ev.review)
            : {
                check: c.check,
                required: c.required,
                passed: null,
                message: `Hub chưa hỗ trợ kiểm tra ${UNSUPPORTED.review}; cần người xem.`,
              },
      );
    } else if (c.check === "agentReport") {
      checks.push({
        check: c.check,
        required: c.required,
        passed: ev.hasAgentReport,
        message: ev.hasAgentReport ? "Agent đã gửi báo cáo." : "Agent chưa gửi báo cáo (task_update).",
      });
    } else {
      checks.push({
        check: c.check,
        required: c.required,
        passed: null,
        message: `Hub chưa hỗ trợ kiểm tra ${UNSUPPORTED[c.check] ?? c.check}; cần người xem.`,
      });
    }
  }

  const failedRequired = checks.filter(
    (c) => c.required && c.passed === false && !(c.check === "changes" && noChanges),
  );
  const pending = ev.review?.status === "pending" && checks.some((c) => c.check === "review" && !c.skipped);
  // Run đã chắc không đạt thì không tốn một run review nữa.
  const settled = (list: CheckOutcome[]) =>
    pending ? list.map((c) => (c.check === "review" && !c.skipped ? { ...c, message: SKIPPED_REVIEW } : c)) : list;
  if (failedRequired.length) {
    return { ...base, outcome: "failed", checks: settled(checks), reasons: failedRequired.map((c) => c.message) };
  }
  if (noChanges) {
    return {
      ...base,
      outcome: "no_changes",
      checks: settled(checks),
      reasons: ["Agent chạy xong nhưng không có commit mới."],
    };
  }
  const soft = checks.filter((c) => !c.skipped && c.passed !== true);
  if (pending) {
    return { ...base, awaitingReview: true, outcome: "needs_review", checks, reasons: soft.map((c) => c.message) };
  }
  if (soft.length) return { ...base, outcome: "needs_review", checks, reasons: soft.map((c) => c.message) };
  return { ...base, outcome: "succeeded", checks, reasons: [] };
}

/** Glob kiểu gitignore rút gọn: `**` khớp nhiều cấp thư mục, `*` và `?` không vượt qua `/`. */
export function matchGlob(glob: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` khớp cả không cấp nào.
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Glob trỏ vào thư mục (`infra/prod`) cũng chặn mọi thứ bên trong.
  return new RegExp(`^${re}(?:/.*)?$`).test(path);
}

/**
 * Chính sách cố định của run review: tương đương `agentReport` bắt buộc, nhưng trên báo cáo `review_report` (agent gọi
 * review_submit). Run review không nộp code nên không xét commit.
 */
export function evaluateReviewRun(ev: {
  exit: number;
  report: Record<string, unknown> | null;
  score: number | null;
}): Evaluation {
  const base = { commitCount: null, changedFiles: [], hasChanges: false, awaitingReview: false };
  if (ev.exit !== 0) {
    const error = ev.report?.error;
    const detail = typeof error === "string" && error ? `: ${error}` : "";
    return {
      ...base,
      outcome: "failed",
      checks: [],
      reasons: [`Agent review kết thúc với mã lỗi ${ev.exit}${detail}.`],
    };
  }
  const passed = ev.score !== null;
  const check = {
    check: "reviewReport",
    required: true,
    passed,
    message: passed ? `Agent đã nộp review, điểm ${ev.score}/10.` : "Agent review chưa gọi review_submit.",
  };
  return passed
    ? { ...base, outcome: "succeeded", checks: [check], reasons: [] }
    : { ...base, outcome: "failed", checks: [check], reasons: [check.message] };
}
