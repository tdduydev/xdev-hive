// Lớp gọi GitHub/GitLab. Module khác chỉ import file này.
export {
  GitProviderError,
  type GitProviderErrorCode,
  isGitProviderError,
  parseRetryAfter,
} from "./errors.ts";
export { createGitHubProvider, type GitHubProviderOptions } from "./github.ts";
export { createGitLabProvider, type GitLabProviderOptions } from "./gitlab.ts";
export type {
  AccessCheck,
  BranchRules,
  CommitFilesInput,
  CreateRepoInput,
  FetchLike,
  GitProvider,
  GitProviderKind,
  PullRequestInput,
  RepoInfo,
  RepoRef,
  RepoVisibility,
  WebhookEvent,
  WebhookInput,
} from "./types.ts";
