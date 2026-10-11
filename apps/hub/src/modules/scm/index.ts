// Lớp gọi GitHub/GitLab và kết nối Git của tổ chức. Module khác chỉ import file này.
export {
  createConnection,
  createProviderFactory,
  defaultProviderFactory,
  listConnections,
  loadConnection,
  type ProviderFactory,
  type ResolvedConnection,
  removeConnection,
  type ScmAuthMode,
  type ScmConnectionRecord,
} from "./connections.ts";
export {
  GitProviderError,
  type GitProviderErrorCode,
  isGitProviderError,
  parseRetryAfter,
} from "./errors.ts";
export { createGitHubProvider, type GitHubProviderOptions } from "./github.ts";
export { createGitLabProvider, type GitLabProviderOptions } from "./gitlab.ts";
export { createMemoryProvider, type MemoryProvider, type MemoryRepo } from "./memory.ts";
export { checkConnection, type ScmDeps, scmRouter } from "./router.ts";
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
