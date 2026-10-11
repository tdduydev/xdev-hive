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
export {
  type CommentInfo,
  type IssueEvent,
  type IssueInfo,
  type MentionEvent,
  mentions,
  normalizeEvent,
  normalizeGitHub,
  normalizeGitLab,
  type PullRequestEvent,
  type PullRequestInfo,
  type PushEvent,
  SCM_EVENT_KINDS,
  type ScmEvent,
  type ScmEventKind,
} from "./events.ts";
export { createGitHubProvider, type GitHubProviderOptions } from "./github.ts";
export { createGitLabProvider, type GitLabProviderOptions } from "./gitlab.ts";
export {
  auditScmEvent,
  createScmEventRegistry,
  onScmEvent,
  processScmEventJob,
  registerScmEventWorker,
  SCM_EVENT_QUEUE,
  type ScmEventContext,
  type ScmEventHandler,
  type ScmEventJob,
  type ScmEventRegistry,
  type ScmJobOutcome,
  scmEventQueue,
  scmEvents,
} from "./handlers.ts";
export { createMemoryProvider, type MemoryProvider, type MemoryRepo } from "./memory.ts";
export { checkConnection, type ScmDeps, scmRouter } from "./router.ts";
export type {
  AccessCheck,
  BranchRules,
  ChecksState,
  CommentOptions,
  CommitFilesInput,
  CreateRepoInput,
  FetchLike,
  GitProvider,
  GitProviderKind,
  MergeMethod,
  PullRequestInput,
  PullRequestState,
  RepoInfo,
  RepoRef,
  RepoVisibility,
  ScmUser,
  WebhookEvent,
  WebhookInput,
} from "./types.ts";
export { verifyGitHubSignature, verifyGitLabToken } from "./verify.ts";
export { handleGitWebhook, type WebhookDeps, type WebhookTarget, type WebhookTargetResolver } from "./webhooks.ts";
