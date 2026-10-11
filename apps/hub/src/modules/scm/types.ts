export type GitProviderKind = "github" | "gitlab";

export interface RepoRef {
  /** GitHub: org. GitLab: đường dẫn đầy đủ của group hoặc user (có thể lồng, ví dụ `a/b`). */
  owner: string;
  name: string;
}

export type RepoVisibility = "private" | "internal" | "public";

export interface RepoInfo extends RepoRef {
  id: string;
  defaultBranch: string;
  visibility: RepoVisibility;
  description: string;
  httpUrl: string;
  sshUrl: string;
  webUrl: string;
}

export interface CreateRepoInput extends RepoRef {
  visibility: RepoVisibility;
  defaultBranch: string;
  description?: string;
  /**
   * Dấu hiệu repo do hub tạo, ghi vào description. Saga tạo lại sau khi chết giữa chừng sẽ gặp repo cũ:
   * cùng dấu hiệu thì dùng tiếp, khác thì là repo của người khác nên báo conflict.
   */
  marker: string;
}

export interface CommitFilesInput {
  branch: string;
  /** Nhánh chưa có thì tạo từ nhánh này (đưa file mẫu vào repo có sẵn qua PR). */
  fromBranch?: string;
  message: string;
  files: Array<{ path: string; content: string }>;
}

export interface BranchRules {
  requirePullRequest: boolean;
  requiredApprovals: number;
  allowForcePush: false;
  requiredChecks?: string[];
}

export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
}

/** Tên theo GitHub. `issue_comment` ở GitLab là note events, gồm cả bình luận trên merge request. */
export type WebhookEvent = "push" | "pull_request" | "issues" | "issue_comment";

export interface WebhookInput {
  url: string;
  secret: string;
  events: WebhookEvent[];
}

export interface CommentOptions {
  pullRequest?: boolean;
}

export interface AccessCheck {
  canCreate: boolean;
  missingScopes: string[];
  /** Quyền cần có nhưng không đọc được trước; chỉ lộ ra khi gọi thật (fine-grained token). */
  unverifiedScopes?: string[];
}

export interface GitProvider {
  readonly kind: GitProviderKind;
  /** Token có tạo được repo trong owner không, thiếu quyền gì. Dùng cho dryRun. */
  checkAccess(owner: string): Promise<AccessCheck>;
  getRepo(ref: RepoRef): Promise<RepoInfo | null>;
  createRepo(input: CreateRepoInput): Promise<RepoInfo>;
  /** Một commit gồm nhiều file. */
  commitFiles(ref: RepoRef, input: CommitFilesInput): Promise<{ sha: string }>;
  protectBranch(ref: RepoRef, branch: string, rules: BranchRules): Promise<void>;
  /** GitLab là merge request; `number` là iid. PR cùng head/base đang mở thì trả lại PR đó. */
  openPR(ref: RepoRef, input: PullRequestInput): Promise<{ number: number; url: string }>;
  /**
   * Bình luận vào issue (GitLab: theo iid). `pullRequest` để bình luận vào PR: GitHub dùng chung API của issue,
   * GitLab thì merge request có API note riêng.
   */
  commentOnIssue(ref: RepoRef, number: number, body: string, opts?: CommentOptions): Promise<{ id: string }>;
  /** Webhook cùng URL đã có thì cập nhật secret và sự kiện, không tạo thêm. */
  addWebhook(ref: RepoRef, input: WebhookInput): Promise<{ id: string }>;
  /** Webhook không còn thì coi như đã xoá. */
  removeWebhook(ref: RepoRef, id: string): Promise<void>;
}

/** Cho phép test và proxy thay `fetch`, không phụ thuộc dispatcher toàn cục. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
