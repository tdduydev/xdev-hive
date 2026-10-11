import { GitProviderError } from "./errors.ts";
import type { CreateRepoInput, GitProviderKind, RepoInfo } from "./types.ts";

export function describeWithMarker(input: CreateRepoInput): string {
  return input.description ? `${input.description} [${input.marker}]` : `[${input.marker}]`;
}

/** Repo trùng tên chỉ được dùng lại khi chính hub đã tạo nó (có dấu hiệu); nếu không sẽ ghi đè repo của người khác. */
export function assertOwnedRepo(kind: GitProviderKind, repo: RepoInfo, input: CreateRepoInput): RepoInfo {
  if (repo.description.includes(`[${input.marker}]`)) return repo;
  const where = kind === "github" ? "GitHub" : "GitLab";
  throw new GitProviderError("conflict", `${where}: repo ${input.owner}/${input.name} đã có và không do Hive tạo`);
}
