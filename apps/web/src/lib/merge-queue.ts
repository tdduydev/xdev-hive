import type { MergeQueueCiState, MergeQueueEntry, MergeQueueState, OrgRole, TeamRole } from "@xdev-hive/contracts";
import { effectiveTeamRole } from "@/lib/roles.ts";

export const MERGE_STATE_LABEL: Record<MergeQueueState, string> = {
  queued: "Đang xếp hàng",
  updating: "Đang cập nhật nhánh",
  waiting: "Đang chờ",
  merging: "Đang merge",
  merged: "Đã merge",
  failed: "Thất bại",
  removed: "Đã đưa ra khỏi hàng",
};

export const MERGE_STATE_TONE = {
  queued: "neutral",
  updating: "sel",
  waiting: "warn",
  merging: "sel",
  merged: "ok",
  failed: "bad",
  removed: "neutral",
} as const;

export const MERGE_CI_LABEL: Record<MergeQueueCiState, string> = {
  success: "CI đạt",
  pending: "CI đang chạy",
  failure: "CI không đạt",
  none: "Không có CI",
};

export const MERGE_CI_TONE = { success: "ok", pending: "warn", failure: "bad", none: "neutral" } as const;

export function isActiveMerge(state: MergeQueueState): boolean {
  return state === "queued" || state === "updating" || state === "waiting" || state === "merging";
}

export function canRemoveMerge(state: MergeQueueState): boolean {
  return isActiveMerge(state) && state !== "merging";
}

export function canRetryMerge(state: MergeQueueState): boolean {
  return state === "failed" || state === "removed";
}

export function canManageMergeQueue(orgRole: OrgRole, teamRole: TeamRole | undefined): boolean {
  const role = effectiveTeamRole(orgRole, teamRole);
  return role === "admin" || role === "member";
}

export function splitMergeQueue(entries: readonly MergeQueueEntry[]) {
  return {
    active: entries
      .filter((entry) => isActiveMerge(entry.state))
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity)),
    finished: entries
      .filter((entry) => !isActiveMerge(entry.state))
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")),
  };
}

/** URL của repo/PR đến từ API; chỉ tạo liên kết có thể mở an toàn trong trình duyệt. */
export function externalUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
