import { GitProviderError } from "./errors.ts";
import type { ChecksState, CreateRepoInput, GitProviderKind, RepoInfo } from "./types.ts";

/** Gộp kết quả từng kiểm tra: một cái đỏ là đỏ, còn cái đang chạy là chờ, không có cái nào là none. */
export function combineChecks(states: ChecksState[]): ChecksState {
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return states.some((s) => s === "success") ? "success" : "none";
}

/** Lỗi khi PR không còn ở trạng thái merge được: merge queue xem lại PR thay vì coi là lỗi của nhà cung cấp. */
export function notMergeable(e: GitProviderError): GitProviderError {
  return new GitProviderError("conflict", e.message, { status: e.status, cause: e });
}

export function describeWithMarker(input: CreateRepoInput): string {
  return input.description ? `${input.description} [${input.marker}]` : `[${input.marker}]`;
}

/** Repo trùng tên chỉ được dùng lại khi chính hub đã tạo nó (có dấu hiệu); nếu không sẽ ghi đè repo của người khác. */
export function assertOwnedRepo(kind: GitProviderKind, repo: RepoInfo, input: CreateRepoInput): RepoInfo {
  if (repo.description.includes(`[${input.marker}]`)) return repo;
  const where = kind === "github" ? "GitHub" : "GitLab";
  throw new GitProviderError("conflict", `${where}: repo ${input.owner}/${input.name} đã có và không do Hive tạo`);
}
