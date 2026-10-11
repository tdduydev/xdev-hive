import type { CheckOutcome, OutcomeCheck } from "@xdev-hive/contracts";

export type Outcome = "succeeded" | "no_changes" | "needs_review" | "failed";

export interface Evidence {
  exit: number;
  headSha: string | null;
  /** Báo cáo của worker trong run_result: `commitCount`, `changedFiles`, `error`. */
  report: Record<string, unknown> | null;
  /** Có run_event `agent_report` trong lần thử này. */
  hasAgentReport: boolean;
}

export interface Evaluation {
  outcome: Outcome;
  checks: CheckOutcome[];
  reasons: string[];
  commitCount: number | null;
  changedFiles: string[];
  /** Có commit để mở PR. */
  hasChanges: boolean;
}

const UNSUPPORTED: Record<string, string> = {
  command: "chạy lệnh trong worktree",
  review: "review chéo bởi agent khác",
  ci: "chờ CI trên PR",
};

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
  const base = { commitCount, changedFiles, hasChanges };

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
  if (failedRequired.length) {
    return { ...base, outcome: "failed", checks, reasons: failedRequired.map((c) => c.message) };
  }
  if (noChanges)
    return { ...base, outcome: "no_changes", checks, reasons: ["Agent chạy xong nhưng không có commit mới."] };
  const soft = checks.filter((c) => c.passed !== true);
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
