import {
  type AiReviewerResult,
  type ChecklistItem,
  type CodeReviewFinding,
  type FindingSeverity,
  matchGlob,
  type ReviewGate,
} from "@xdev-hive/contracts";
import type { CheckCommandResult, DiffStats } from "@xdev-hive/contracts/worker-protocol";

/** Số liệu diff của phiên; null khi worker cũ không báo `diffStats` (điều kiện và quy tắc cần số liệu sẽ chờ người). */
export interface GateContext {
  taskType: string | null;
  stats: DiffStats | null;
}

/** Điều kiện của checkpoint (FR-007): không thoả thì bỏ qua và ghi lý do. */
export function gateApplies(gate: ReviewGate, ctx: GateContext): { runs: boolean; reason: string } {
  const c = gate.conditions;
  if (c.taskTypes?.length && !(ctx.taskType && c.taskTypes.includes(ctx.taskType)))
    return { runs: false, reason: `Loại task ${ctx.taskType ?? "(không có)"} không thuộc ${c.taskTypes.join(", ")}.` };
  // Thiếu số liệu thì chạy checkpoint: bỏ sót tệ hơn chạy thừa.
  if (!ctx.stats) return { runs: true, reason: "Chưa có số liệu diff; chạy checkpoint." };
  if (c.paths?.length && !ctx.stats.changedFiles.some((f) => c.paths?.some((g) => matchGlob(g, f))))
    return { runs: false, reason: `Diff không đụng ${c.paths.join(", ")}.` };
  const changed = ctx.stats.addedLines + ctx.stats.deletedLines;
  if (c.minChangedLines !== null && changed < c.minChangedLines)
    return { runs: false, reason: `Đổi ${changed} dòng, dưới ngưỡng ${c.minChangedLines}.` };
  return { runs: true, reason: "Đủ điều kiện." };
}

// ---- Quy tắc (gate `rule`) ------------------------------------------------------------------------------------

/** Patch của một file trong PR; null khi file nhị phân hoặc quá lớn để nhà cung cấp trả patch. */
export interface PatchFile {
  path: string;
  patch: string | null;
}

export interface RuleContext extends GateContext {
  /** null khi chưa lấy được diff từ nhà cung cấp Git. */
  patches: PatchFile[] | null;
  hasAgentReport: boolean;
  /** `report.commands` của worker; null khi worker cũ không chạy lệnh kiểm. */
  commands: CheckCommandResult[] | null;
}

export interface RuleVerdict {
  /** `waiting`: không đủ bằng chứng để máy quyết, cần người xem hoặc quyết thay. */
  status: "passed" | "failed" | "waiting";
  checklist: ChecklistItem[];
  /** Lý do không đạt hoặc chờ; null khi đạt. */
  note: string | null;
}

// Cùng danh sách với quy tắc `no-secrets` của tài liệu (knowledge/review-rules.ts); module chỉ import nhau qua index.ts
// mà knowledge không export danh sách này.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "khoá riêng (private key)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "access key AWS"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "token GitHub"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "token GitLab"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "token Slack"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "khoá API (sk-…)"],
  [/\b(hive_pat|hwm|hwr)_[A-Za-z0-9_-]{16,}\b/, "token xDev Hive"],
];

/** Chỉ dòng thêm: bí mật đã nằm trong repo từ trước không phải lỗi của PR này. */
const addedLines = (patch: string) =>
  patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");

const NO_COMMAND_SUPPORT = "Máy chưa hỗ trợ chạy lệnh kiểm; cần người xem.";
const NO_STATS = "Máy chưa báo số liệu diff; cần người xem.";

/** `passed: null` là chưa đủ bằng chứng. */
type Item = { label: string; passed: boolean | null; note: string | null };

function ruleItems(gate: ReviewGate, ctx: RuleContext): Item[] {
  const out: Item[] = [];
  for (const rule of gate.rules ?? []) {
    if (rule === "max-files") {
      const max = gate.maxFiles ?? 50;
      const label = `Đổi không quá ${max} file`;
      if (!ctx.stats) out.push({ label, passed: null, note: NO_STATS });
      else {
        const n = ctx.stats.changedFiles.length;
        out.push({ label, passed: n <= max, note: `Đổi ${n} file.` });
      }
    } else if (rule === "deny-paths") {
      const label = "Không đụng đường dẫn cấm";
      if (!ctx.stats) out.push({ label, passed: null, note: NO_STATS });
      else {
        const hit = ctx.stats.changedFiles.filter((f) => gate.denyPaths?.some((g) => matchGlob(g, f)));
        out.push({
          label,
          passed: hit.length === 0,
          note: hit.length ? `Đụng đường dẫn cấm: ${hit.slice(0, 10).join(", ")}.` : null,
        });
      }
    } else if (rule === "max-diff") {
      const max = gate.maxDiffLines ?? 200;
      const label = `Thay đổi không quá ${max} dòng`;
      if (!ctx.stats) out.push({ label, passed: null, note: NO_STATS });
      else {
        const n = ctx.stats.addedLines + ctx.stats.deletedLines;
        out.push({ label, passed: n <= max, note: `Đổi ${n} dòng.` });
      }
    } else if (rule === "no-secrets") {
      const label = "Không có dữ liệu nhạy cảm";
      if (!ctx.patches) out.push({ label, passed: null, note: "Chưa lấy được diff để quét; cần người xem." });
      else {
        const found = new Map<string, string[]>();
        for (const f of ctx.patches) {
          if (f.patch === null) continue;
          const added = addedLines(f.patch);
          for (const [re, name] of SECRETS) if (re.test(added)) found.set(name, [...(found.get(name) ?? []), f.path]);
        }
        const skipped = ctx.patches.filter((f) => f.patch === null).length;
        const skippedNote = skipped ? `${skipped} file không có patch nên chưa quét.` : null;
        out.push({
          label,
          passed: found.size === 0,
          note: found.size
            ? `Có ${[...found].map(([name, paths]) => `${name} trong ${paths.slice(0, 3).join(", ")}`).join("; ")}.`
            : skippedNote,
        });
      }
    } else if (rule === "agent-report") {
      out.push({
        label: "Agent đã gửi báo cáo",
        passed: ctx.hasAgentReport,
        note: ctx.hasAgentReport ? null : "Agent chưa gửi báo cáo (task_update).",
      });
    } else if (rule === "command") {
      for (const c of gate.commands ?? []) {
        const label = `Lệnh \`${c.run}\` thoát với mã 0`;
        // Worker trả theo đúng thứ tự lệnh, nhưng khớp theo chuỗi để không lệch khi quản trị sửa quy trình giữa chừng.
        const r = ctx.commands?.find((x) => x.run === c.run);
        if (!r) out.push({ label, passed: null, note: NO_COMMAND_SUPPORT });
        else if (r.exit === 0) out.push({ label, passed: true, note: null });
        else
          out.push({
            label,
            passed: false,
            note: r.exit === null ? `Hết thời hạn ${c.timeoutSec} giây hoặc không chạy được.` : `Mã thoát ${r.exit}.`,
          });
      }
    }
    // `sections`, `requirements` chỉ dành cho tài liệu; hợp đồng đã chặn, bỏ qua ở đây thay vì đoán.
  }
  return out;
}

/** Kết quả gate `rule` của quy trình code: một mục sai là không đạt; không có mục sai mà còn mục thiếu bằng chứng thì chờ người. */
export function evaluateRules(gate: ReviewGate, ctx: RuleContext): RuleVerdict {
  const items = ruleItems(gate, ctx);
  const checklist: ChecklistItem[] = items.map((i) => ({
    label: i.label,
    passed: i.passed === true,
    note: i.note,
  }));
  const failed = items.filter((i) => i.passed === false);
  const note = (list: Item[]) => list.flatMap((i) => (i.note ? [`${i.label}: ${i.note}`] : [])).join(" ") || null;
  if (failed.length) return { status: "failed", checklist, note: note(failed) };
  const waiting = items.filter((i) => i.passed === null);
  if (waiting.length) return { status: "waiting", checklist, note: note(waiting) };
  return { status: "passed", checklist, note: null };
}

// ---- CI (gate `ext`) ------------------------------------------------------------------------------------------

export type CiState = "success" | "pending" | "failure" | "none";

export function ciVerdict(
  gate: ReviewGate,
  state: CiState,
): { status: "passed" | "failed" | "waiting"; note: string | null } {
  switch (state) {
    case "success":
      return { status: "passed", note: null };
    case "failure":
      return { status: "failed", note: "CI trên commit đầu của PR không đạt." };
    case "pending":
      return { status: "waiting", note: "Đang chờ CI trên commit đầu của PR." };
    case "none":
      return (gate.ext?.whenNone ?? "pass") === "pass"
        ? { status: "passed", note: "Repo không có CI." }
        : { status: "failed", note: "Repo không có CI nên không có bằng chứng." };
  }
}

// ---- AI (gate `ai`) -------------------------------------------------------------------------------------------

export type ReviewerOutcome = Pick<AiReviewerResult, "cli" | "state" | "score" | "findings" | "error">;

export interface AiVerdict {
  status: "passed" | "failed" | "waiting";
  /** Điểm trung bình của các reviewer đã nộp; null khi chưa ai nộp. */
  score: number | null;
  /** Từng reviewer đạt hay không, theo thứ tự đầu vào; null khi chưa có kết quả. */
  passed: (boolean | null)[];
  /** Phát hiện làm checkpoint không đạt (đưa vào chỉ dẫn cho run sửa). */
  blocking: (CodeReviewFinding & { cli: string })[];
  /** Lý do không đạt hoặc chờ; null khi đạt. */
  note: string | null;
}

const SEVERITIES_BLOCKED: Record<"critical" | "major", FindingSeverity[]> = {
  critical: ["critical"],
  major: ["critical", "major"],
};

const WAITING_STATES = new Set<ReviewerOutcome["state"]>(["queued", "waiting_machine", "running"]);

const round2 = (n: number) => Math.round(n * 100) / 100;
const place = (f: CodeReviewFinding) => (f.line ? `${f.file}:${f.line}` : f.file);

/**
 * Gộp kết quả các reviewer theo cấu hình gate (FR-003). Chỉ kết luận khi mọi reviewer đã xong hoặc lỗi, để người duyệt
 * thấy đủ điểm của cả hai thay vì chỉ cái chấm thấp nhất. Phát hiện từ mức `blockOn` trở lên chặn dù điểm đủ.
 */
export function aggregateAi(ai: NonNullable<ReviewGate["ai"]>, results: ReviewerOutcome[]): AiVerdict {
  const blocked = ai.blockOn ? SEVERITIES_BLOCKED[ai.blockOn] : [];
  const done = results.filter((r) => r.state === "done" && r.score !== null);
  const score = done.length ? round2(done.reduce((s, r) => s + (r.score ?? 0), 0) / done.length) : null;
  const blocking = results.flatMap((r) =>
    r.state === "done" ? r.findings.filter((f) => blocked.includes(f.severity)).map((f) => ({ ...f, cli: r.cli })) : [],
  );
  const passed = results.map((r) => {
    if (r.state !== "done" || r.score === null) return WAITING_STATES.has(r.state) ? null : false;
    return r.score >= ai.passScore && !r.findings.some((f) => blocked.includes(f.severity));
  });

  if (!results.length) return { status: "failed", score, passed, blocking, note: "Chưa có reviewer nào." };
  if (results.some((r) => WAITING_STATES.has(r.state))) {
    const wait = results.filter((r) => r.state === "waiting_machine").map((r) => r.cli);
    return {
      status: "waiting",
      score,
      passed,
      blocking,
      note: wait.length ? `Chưa có máy dùng chung có ${wait.join(", ")}.` : null,
    };
  }

  const reasons: string[] = [];
  for (const r of results) {
    if (r.state === "error" || r.score === null)
      reasons.push(`Run review của ${r.cli} không có kết quả${r.error ? `: ${r.error}` : "."}`);
  }
  if (!reasons.length && (ai.aggregate ?? "all") === "avg") {
    if (score !== null && score < ai.passScore)
      reasons.push(`Điểm trung bình ${score}/10, dưới ngưỡng ${ai.passScore}.`);
  } else if (!reasons.length) {
    for (const r of done)
      if (r.score !== null && r.score < ai.passScore)
        reasons.push(`${r.cli} chấm ${r.score}/10, dưới ngưỡng ${ai.passScore}.`);
  }
  for (const f of blocking) reasons.push(`${f.cli} có phát hiện ${f.severity} ở ${place(f)}: ${f.message}`);

  return reasons.length
    ? { status: "failed", score, passed, blocking, note: reasons.join(" ") }
    : { status: "passed", score, passed, blocking, note: null };
}
