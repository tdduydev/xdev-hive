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
  expectedHead?: string;
  files: Array<
    | { path: string; content: string }
    | { path: string; bytes: Uint8Array }
    | { path: string; delete: true }
    | { path: string; previousPath: string }
  >;
}

export interface CommitChange {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed";
  sha: string | null;
}
export interface LfsObject {
  oid: string;
  size: number;
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
export type WebhookEvent = "push" | "pull_request" | "issues" | "issue_comment" | "pull_request_review_comment";

export interface ReviewComment {
  id: string;
  threadId: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  commitSha: string;
  body: string;
  author: string | null;
  url: string | null;
  updatedAt: string;
  resolved: boolean;
  inReplyToId: string | null;
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  commitSha: string;
  body: string;
}

export interface WebhookInput {
  url: string;
  secret: string;
  events: WebhookEvent[];
}

export interface CommentOptions {
  pullRequest?: boolean;
}

/**
 * Trạng thái PR đủ để merge queue chọn bước tiếp. `mergeable`: clean là merge được ngay; behind là nhánh chính đã tiến
 * và nhà cung cấp đòi cập nhật; conflict là xung đột; blocked là thiếu người duyệt, kiểm tra bắt buộc chưa đạt hoặc
 * bản nháp; unknown là nhà cung cấp đang tính, hỏi lại sau.
 */
export interface PullRequestState {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: string;
  headSha: string;
  base: string;
  mergeable: "clean" | "behind" | "conflict" | "blocked" | "unknown";
}

/** Số file tối đa `prFiles` trả: GitHub không trả quá mức này, GitLab được cắt theo cho cùng hành vi. */
export const MAX_PR_FILES = 3000;
/** Giới hạn mô tả commit status của GitHub; cắt chung cho cả GitLab để hai bên hiện giống nhau. */
export const COMMIT_STATUS_DESCRIPTION_MAX = 140;

export type PullRequestFileStatus = "added" | "modified" | "removed" | "renamed";

/** Một file đổi trong PR, đủ để màn review vẽ diff mà không lưu diff vào DB. */
export interface PullRequestFile {
  path: string;
  /** Có khi `status` là `renamed`. */
  previousPath?: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  /** Patch unified không có dòng `---`/`+++`; vắng khi file nhị phân hoặc nhà cung cấp không gửi (xem `truncated`). */
  patch?: string;
  /** Nhà cung cấp bỏ patch vì file quá lớn dù có dòng đổi; màn review chỉ có link ra PR cho file này. */
  truncated: boolean;
}

/** Trạng thái commit status do Hive đặt lên đầu PR (`xdev-hive/review`). */
export type CommitStatusState = "pending" | "success" | "failure";

export interface CommitStatusInput {
  /** Tên kiểm tra hiện trên PR, ví dụ `xdev-hive/review`. */
  context: string;
  state: CommitStatusState;
  /** Quá 140 ký tự thì bị cắt (giới hạn của GitHub). */
  description: string;
  targetUrl?: string;
}

/** Kết quả CI trên một commit, gộp mọi kiểm tra. `none`: không có CI nào báo về commit này. */
export type ChecksState = "success" | "pending" | "failure" | "none";

export type MergeMethod = "merge" | "squash" | "rebase";

/** Người dùng trên GitHub/GitLab. GitHub tra quyền theo login, GitLab theo id. */
export interface ScmUser {
  login: string | null;
  id: number | null;
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
  listReviewComments(ref: RepoRef, number: number): Promise<ReviewComment[]>;
  createReviewComment(ref: RepoRef, number: number, input: ReviewCommentInput): Promise<ReviewComment>;
  replyReviewComment(ref: RepoRef, number: number, threadId: string, body: string): Promise<ReviewComment>;
  editReviewComment(ref: RepoRef, number: number, commentId: string, body: string): Promise<ReviewComment>;
  deleteReviewComment(ref: RepoRef, number: number, commentId: string): Promise<void>;
  setReviewThreadResolved(ref: RepoRef, number: number, threadId: string, resolved: boolean): Promise<void>;
  /**
   * Người này push được vào repo không: GitHub quyền write trở lên, GitLab Developer trở lên. Không phải thành viên
   * hoặc thiếu login/id thì false; lỗi mạng, hết hạn mức thì ném lỗi để người gọi thử lại.
   */
  canPush(ref: RepoRef, user: ScmUser): Promise<boolean>;
  /** PR theo số (GitLab: iid); null khi không có. */
  getPR(ref: RepoRef, number: number): Promise<PullRequestState | null>;
  /**
   * Đưa nhánh của PR theo kịp nhánh chính (GitHub: update-branch, GitLab: rebase). `expectedHeadSha` để không cập
   * nhật đè khi agent vừa push thêm (GitLab không hỗ trợ, bỏ qua). Không cập nhật được vì xung đột thì lỗi conflict.
   */
  updatePRBranch(ref: RepoRef, number: number, expectedHeadSha: string): Promise<void>;
  checksFor(ref: RepoRef, sha: string, opts?: { excludeContexts?: readonly string[] }): Promise<ChecksState>;
  /**
   * Merge PR nếu head vẫn là `sha`. Head đã đổi hoặc PR không còn merge được thì lỗi conflict, để merge queue xem lại
   * PR thay vì merge commit chưa qua CI.
   */
  mergePR(ref: RepoRef, number: number, opts: { method: MergeMethod; sha: string }): Promise<{ sha: string | null }>;
  /** Webhook cùng URL đã có thì cập nhật secret và sự kiện, không tạo thêm. */
  addWebhook(ref: RepoRef, input: WebhookInput): Promise<{ id: string }>;
  /** Webhook không còn thì coi như đã xoá. */
  removeWebhook(ref: RepoRef, id: string): Promise<void>;
  /** Commit mới nhất của nhánh; null khi chưa có nhánh. */
  branchHead(ref: RepoRef, branch: string): Promise<string | null>;
  /** Đường dẫn mọi file trong cây của commit `sha` (đệ quy). Kho skill dùng để tìm SKILL.md. */
  listFiles(ref: RepoRef, sha: string): Promise<string[]>;
  /** Nội dung UTF-8 của file ở commit `sha`; null khi không có file. */
  readFile(ref: RepoRef, path: string, sha: string): Promise<string | null>;
  readBlob(ref: RepoRef, blob: string): Promise<Uint8Array>;
  compare(ref: RepoRef, from: string, to: string): Promise<{ files: CommitChange[]; incomplete: boolean }>;
  archive(ref: RepoRef, sha: string, path?: string): Promise<ReadableStream<Uint8Array>>;
  lfsBatch(ref: RepoRef, operation: "upload" | "download", objects: LfsObject[]): Promise<unknown>;
  /**
   * File đổi của PR, theo thứ tự nhà cung cấp trả, tối đa 3 000 file (giới hạn của GitHub; GitLab cắt theo cùng mức).
   * PR không có thì null.
   */
  prFiles(ref: RepoRef, number: number): Promise<PullRequestFile[] | null>;
  /**
   * Đặt commit status trên `sha`. Cùng `context` thì ghi đè trạng thái cũ của commit đó. Hive dùng nó làm cổng ngoài
   * cho bảo vệ nhánh vì bot mở PR không tự approve được.
   */
  setCommitStatus(ref: RepoRef, sha: string, input: CommitStatusInput): Promise<void>;
  /** Đóng PR không merge (đề xuất skill bị từ chối). PR đã đóng hoặc đã merge thì bỏ qua. */
  closePR(ref: RepoRef, number: number): Promise<void>;
}

/** Cho phép test và proxy thay `fetch`, không phụ thuộc dispatcher toàn cục. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
