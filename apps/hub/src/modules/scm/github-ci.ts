import type { CiJob, CiPipeline, CiStatus, PendingDeployment } from "./types.ts";
import { ciTime, githubCiStatus } from "./types.ts";

// GitHub Actions theo kiểu CI chung (CiPipeline, CiJob). API REST và payload webhook workflow_run, workflow_job dùng
// cùng dạng object nên hai bên cùng đổi qua đây.

export interface GhWorkflowRun {
  id: number;
  /** Tên workflow; có thể rỗng khi workflow không đặt `name`. */
  name?: string | null;
  /** Tiêu đề lượt chạy (thường là dòng đầu commit hoặc tiêu đề PR). */
  display_title?: string | null;
  run_number?: number | null;
  head_branch?: string | null;
  head_sha: string;
  status?: string | null;
  conclusion?: string | null;
  event?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  run_started_at?: string | null;
  actor?: { login?: string | null } | null;
  triggering_actor?: { login?: string | null } | null;
}

export interface GhWorkflowJob {
  id: number;
  run_id: number;
  name: string;
  workflow_name?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GhPendingDeployment {
  environment: { id: number; name?: string | null; html_url?: string | null };
  current_user_can_approve?: boolean;
  reviewers?: { type?: string; reviewer?: { login?: string | null; slug?: string | null; name?: string | null } }[];
}

/** Bộ lọc `status` của API list runs cho từng trạng thái chung; trạng thái chỉ GitLab có thì không lọc được. */
export const GH_RUN_STATUS_FILTER: Partial<Record<CiStatus, string>> = {
  success: "success",
  failed: "failure",
  canceled: "cancelled",
  skipped: "skipped",
  running: "in_progress",
  pending: "queued",
  waiting: "waiting",
  manual: "action_required",
};

function seconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return ms >= 0 ? Math.round(ms / 1000) : null;
}

export function ghPipeline(r: GhWorkflowRun): CiPipeline {
  const createdAt = ciTime(r.created_at);
  const startedAt = ciTime(r.run_started_at);
  // Run không có thời điểm xong riêng; khi đã xong thì lần cập nhật cuối là lúc xong.
  const finishedAt = r.status === "completed" ? ciTime(r.updated_at) : null;
  const label = r.name || r.display_title || "Workflow";
  return {
    id: String(r.id),
    ref: r.head_branch ?? "",
    sha: r.head_sha,
    status: githubCiStatus(r.status, r.conclusion),
    source: r.event ?? null,
    url: r.html_url ?? null,
    createdAt,
    updatedAt: ciTime(r.updated_at),
    startedAt,
    finishedAt,
    durationSec: seconds(startedAt ?? createdAt, finishedAt),
    // Người bấm chạy lại là triggering_actor; actor vẫn là người chạy lượt đầu.
    user: r.triggering_actor?.login ?? r.actor?.login ?? null,
    title: typeof r.run_number === "number" ? `${label} #${r.run_number}` : label,
  };
}

const GH_PASSED = new Set(["success", "neutral", "skipped"]);

export function ghJob(j: GhWorkflowJob): CiJob {
  const startedAt = ciTime(j.started_at);
  const finishedAt = ciTime(j.completed_at);
  return {
    id: String(j.id),
    pipelineId: String(j.run_id),
    name: j.name,
    // GitHub không có stage; gom job theo workflow cho màn hình có nhóm.
    stage: j.workflow_name ?? "",
    ref: j.head_branch ?? "",
    sha: j.head_sha ?? null,
    status: githubCiStatus(j.status, j.conclusion),
    // continue-on-error không có trong API; job lỗi luôn làm run lỗi.
    allowFailure: false,
    failureReason: j.status === "completed" && j.conclusion && !GH_PASSED.has(j.conclusion) ? j.conclusion : null,
    url: j.html_url ?? null,
    createdAt: ciTime(j.created_at),
    startedAt,
    finishedAt,
    durationSec: seconds(startedAt, finishedAt),
    user: null,
  };
}

export function ghPendingDeployment(d: GhPendingDeployment): PendingDeployment {
  return {
    environment: d.environment.name ?? String(d.environment.id),
    environmentId: String(d.environment.id),
    url: d.environment.html_url ?? null,
    canApprove: d.current_user_can_approve === true,
    reviewers: (d.reviewers ?? [])
      .map((r) => r.reviewer?.login ?? r.reviewer?.slug ?? r.reviewer?.name ?? null)
      .filter((r): r is string => Boolean(r)),
  };
}

/** Số byte đầu tạo thành chuỗi UTF-8 trọn ký tự (như GitLab): log tải giữa chừng có thể dừng giữa một ký tự. */
export function wholeUtf8(bytes: Uint8Array): number {
  let i = bytes.length - 1;
  let tail = 0;
  while (i >= 0 && tail < 3 && ((bytes[i] as number) & 0xc0) === 0x80) {
    i--;
    tail++;
  }
  if (i < 0) return bytes.length;
  const lead = bytes[i] as number;
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return size > tail + 1 ? i : bytes.length;
}
