import {
  type OutcomeCheck,
  type Run,
  type RunEventView,
  type RunState,
  TERMINAL_RUN_STATES,
} from "@xdev-hive/contracts";
import { formatClock, formatDuration } from "./format.ts";

/** Màu của nhãn trạng thái, khớp `tone` của <Pill>. */
export type Tone = "neutral" | "ok" | "warn" | "bad" | "sel";

export const RUN_STATE_LABEL: Record<RunState, string> = {
  queued: "Chờ máy",
  planning: "Đang lập kế hoạch",
  awaiting_plan: "Chờ duyệt kế hoạch",
  leased: "Đã nhận máy",
  preparing: "Đang chuẩn bị",
  running: "Đang chạy",
  awaiting_input: "Chờ trả lời",
  verifying: "Đang kiểm kết quả",
  succeeded: "Thành công",
  no_changes: "Không có thay đổi",
  needs_review: "Cần người xem",
  failed: "Lỗi",
  lost: "Mất máy",
  cancelling: "Đang huỷ",
  cancelled: "Đã huỷ",
};

const STATE_TONE: Record<RunState, Tone> = {
  queued: "neutral",
  planning: "sel",
  awaiting_plan: "warn",
  leased: "sel",
  preparing: "sel",
  running: "sel",
  awaiting_input: "warn",
  verifying: "sel",
  succeeded: "ok",
  no_changes: "neutral",
  needs_review: "warn",
  failed: "bad",
  lost: "bad",
  cancelling: "neutral",
  cancelled: "neutral",
};

export const runStateTone = (state: RunState): Tone => STATE_TONE[state];

export const CLI_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
export const cliLabel = (cli: string | null): string => (cli ? (CLI_LABEL[cli] ?? cli) : "CLI bất kỳ");

/** 8 ký tự đầu của id, đủ để người xem phân biệt run như mã commit rút gọn. */
export const shortId = (id: string): string => id.slice(0, 8);

export const isTerminal = (state: RunState): boolean => TERMINAL_RUN_STATES.includes(state);

/*
 * Hai hàm dưới chỉ để ẩn nút; hub vẫn kiểm lại. Theo runs/engine.ts: steerRun không nhận khi đang kiểm kết quả, đang
 * huỷ hay đã xong; huỷ thì mọi trạng thái chưa kết thúc.
 */
export const canSteer = (state: RunState): boolean =>
  !isTerminal(state) && state !== "verifying" && state !== "cancelling";
export const canCancel = (state: RunState): boolean => !isTerminal(state) && state !== "cancelling";

export type PhaseStatus = "done" | "current" | "stopped" | "next";

export interface Phase {
  label: string;
  status: PhaseStatus;
  /** Giờ vào pha (pha đã qua), thời gian đã chạy (pha đang chạy), hoặc rỗng. */
  time: string;
}

const PHASES = ["Xếp hàng", "Nhận máy", "Chuẩn bị", "Đang chạy", "Kiểm tra kết quả", "Mở PR"] as const;

/** Pha của thanh tiến trình ứng với trạng thái run; trạng thái kết thúc không có pha riêng. */
const PHASE_OF: Partial<Record<RunState, number>> = {
  queued: 0,
  planning: 0,
  awaiting_plan: 0,
  leased: 1,
  preparing: 2,
  running: 3,
  awaiting_input: 3,
  verifying: 4,
};

/**
 * Các pha của lần thử hiện tại: Xếp hàng → Nhận máy → Chuẩn bị → Đang chạy → Kiểm tra kết quả → Mở PR. Giờ của pha
 * lấy từ sự kiện `state` hub ghi khi chuyển trạng thái. Run dừng giữa chừng (lỗi, mất máy, huỷ) thì pha xa nhất đã tới
 * được đánh dấu `stopped`.
 */
export function runPhases(run: Run, events: RunEventView[], now: number): Phase[] {
  const entered = new Map<number, string>();
  if (run.attempt === 1) entered.set(0, run.createdAt);
  for (const e of events) {
    if (e.type !== "state" || e.attempt !== run.attempt) continue;
    const phase = PHASE_OF[e.data.to as RunState];
    if (phase !== undefined && !entered.has(phase)) entered.set(phase, e.createdAt);
  }

  let current: number;
  let finished = false;
  let stopped = false;
  const live = PHASE_OF[run.state];
  if (live !== undefined) current = live;
  else if (run.state === "succeeded" || run.state === "needs_review" || run.state === "no_changes") {
    finished = true;
    current = run.prUrl ? 5 : 4;
  } else {
    // failed, lost, cancelling, cancelled: dừng ở pha xa nhất đã vào.
    stopped = run.state !== "cancelling";
    current = Math.max(0, ...entered.keys());
  }

  return PHASES.map((label, i) => {
    const at = entered.get(i);
    if (i < current || (i === current && finished)) {
      return { label, status: "done", time: at ? formatClock(at) : "" };
    }
    if (i === current) {
      const status: PhaseStatus = stopped ? "stopped" : "current";
      const time = status === "current" && at ? formatDuration(now - Date.parse(at)) : at ? formatClock(at) : "";
      return { label, status, time };
    }
    return { label, status: "next", time: "" };
  });
}

/** Tên một bước kiểm tra của chính sách kết quả, viết cho người xem. */
export function checkLabel(check: OutcomeCheck): string {
  let label: string;
  switch (check.check) {
    case "changes": {
      const parts = ["Có commit mới"];
      if (check.deny?.length) parts.push(`không đụng ${check.deny.join(", ")}`);
      if (check.maxFiles) parts.push(`tối đa ${check.maxFiles} file`);
      label = parts.join(", ");
      break;
    }
    case "agentReport":
      label = "Agent báo cáo qua task_update";
      break;
    case "command":
      label = `Lệnh ${check.run}`;
      break;
    case "review":
      label = `Review chéo bởi ${cliLabel(check.by)}, điểm ≥ ${check.minScore}`;
      break;
    case "ci":
      label = "CI trên PR xanh";
      break;
  }
  return check.required ? label : `${label} (không bắt buộc)`;
}

export interface CheckRow {
  label: string;
  state: string;
  tone: "ok" | "bad" | "muted";
}

/**
 * Chính sách kết quả của run: tên lấy từ policySnapshot, kết quả lấy từ result.checks (ghép theo loại kiểm tra, theo
 * thứ tự). Run chưa tới bước kiểm thì mọi dòng là "Chờ run kết thúc".
 */
export function checkRows(run: Run): CheckRow[] {
  const results = [...(run.result?.checks ?? [])];
  return run.policySnapshot.map((check) => {
    const label = checkLabel(check);
    const i = results.findIndex((r) => r.check === check.check);
    const result = i >= 0 ? results.splice(i, 1)[0] : undefined;
    if (!result) return { label, state: run.result ? "Không có kết quả" : "Chờ run kết thúc", tone: "muted" };
    if (result.passed === true) return { label, state: `Đạt · ${result.message}`, tone: "ok" };
    if (result.passed === false) return { label, state: `Không đạt · ${result.message}`, tone: "bad" };
    return { label, state: result.message, tone: "muted" };
  });
}

/** Một dòng trong danh sách sự kiện; null với sự kiện không cần hiện (cost đã có ở ô chi phí). */
export function describeEvent(e: RunEventView): string | null {
  const d = e.data;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (e.type) {
    case "state": {
      const to = RUN_STATE_LABEL[d.to as RunState] ?? String(d.to);
      return `Trạng thái: ${to}`;
    }
    case "steer":
      return `Chỉ dẫn: ${text(d.input) ?? ""}`;
    case "phase":
      return `Worker: pha ${text(d.phase) ?? "?"}`;
    case "tool_call":
      return `Gọi công cụ ${text(d.name) ?? text(d.tool) ?? ""}`.trim();
    case "plan":
      return "Agent lập kế hoạch";
    case "approval_needed":
      return "Agent cần người duyệt";
    case "check_result":
      return `Kết quả kiểm tra ${text(d.check) ?? ""}`.trim();
    case "agent_report":
      return "Agent gửi báo cáo";
    case "review_requested":
      return "Mở review chéo";
    case "review_report":
      return "Có kết quả review chéo";
    case "offer":
      return "Đề nghị job cho máy";
    case "offer_rejected":
      return "Máy từ chối job";
    case "offer_expired":
      return "Máy không trả lời đề nghị";
    case "pr_merged":
      return "PR đã merge";
    case "pr_closed":
      return "PR đã đóng";
    case "cost":
      return null;
    default:
      return e.type;
  }
}

/** Phần chi phí đã dùng so với trần mỗi run của dự án, 0–100; null khi không có trần hoặc CLI không báo USD. */
export function budgetPercent(costUsd: number | null, capUsd: number | undefined): number | null {
  if (costUsd === null || !capUsd) return null;
  return Math.min(100, Math.round((costUsd / capUsd) * 100));
}

/** Nhãn ngắn của PR/MR từ URL: số ở cuối (…/pull/128, …/merge_requests/12) thành "#128"; không đọc được thì "PR". */
export function prLabel(url: string): string {
  const n = /\/(\d+)\/?$/.exec(url)?.[1];
  return n ? `#${n}` : "PR";
}
