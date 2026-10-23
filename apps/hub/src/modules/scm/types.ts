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

/**
 * Tên theo GitHub. `issue_comment` ở GitLab là note events, gồm cả bình luận trên merge request. `pipeline`, `job` là
 * Pipeline/Job events của GitLab, ở GitHub là `workflow_run`, `workflow_job`.
 */
export type WebhookEvent =
  | "push"
  | "pull_request"
  | "issues"
  | "issue_comment"
  | "pull_request_review_comment"
  | "pipeline"
  | "job";

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

/**
 * Trạng thái pipeline và job, theo tên của GitLab. `waiting` chỉ GitHub có: run hoặc job dừng chờ người duyệt
 * deployment vào environment được bảo vệ.
 */
export const CI_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "canceling",
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
  "waiting",
] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

/**
 * Còn chạy tiếp mà không cần ai bấm: log còn ghi thêm, trạng thái còn đổi. `manual`, `scheduled`, `waiting` chờ người
 * hoặc giờ.
 */
export const CI_ACTIVE_STATUSES: readonly CiStatus[] = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "canceling",
];

/**
 * Trạng thái lạ (GitLab bản mới thêm) coi là `pending`: màn hình hỏi lại tới khi gặp trạng thái biết được, thay vì
 * báo xong hay báo lỗi sai.
 */
export function asCiStatus(value: unknown): CiStatus {
  return CI_STATUSES.find((s) => s === value) ?? "pending";
}

/**
 * Trạng thái run hoặc job của GitHub Actions (`status` + `conclusion`) theo tên của GitLab. `action_required` là chờ
 * người bấm nên coi như `manual`; kết luận lạ coi là lỗi vì run đã dừng.
 */
export function githubCiStatus(status: unknown, conclusion: unknown): CiStatus {
  switch (status) {
    case "completed":
      switch (conclusion) {
        case "success":
        case "neutral":
          return "success";
        case "skipped":
          return "skipped";
        case "cancelled":
          return "canceled";
        case "action_required":
          return "manual";
        default:
          return "failed";
      }
    case "in_progress":
      return "running";
    case "waiting":
      return "waiting";
    default:
      return "pending";
  }
}

// Payload webhook của GitLab có lúc gửi `2016-08-12 15:23:28 UTC`; dạng này không thuộc chuẩn mà Date phải đọc được.
const GITLAB_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;

/** Thời điểm về ISO UTC; null khi trống hoặc không đọc được. */
export function ciTime(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const at = new Date(value.replace(GITLAB_UTC, "$1T$2Z"));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Thời điểm đều đổi về ISO UTC (`ciTime`). */
export interface CiPipeline {
  id: string;
  /** Nhánh hoặc tag. */
  ref: string;
  sha: string;
  status: CiStatus;
  /** push, web, schedule, merge_request_event…; null khi nhà cung cấp không gửi. */
  source: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
  /** Người chạy pipeline (username). */
  user: string | null;
  /** Tên hiện trên màn hình. GitHub có tên workflow và số lượt chạy; vắng thì màn hình tự đặt theo id. */
  title?: string | null;
}

export interface CiJob {
  id: string;
  pipelineId: string;
  name: string;
  stage: string;
  ref: string;
  sha: string | null;
  status: CiStatus;
  allowFailure: boolean;
  failureReason: string | null;
  url: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
  user: string | null;
}

export interface ListPipelinesOptions {
  branch?: string;
  sha?: string;
  status?: CiStatus;
  /** Bắt đầu từ 1. */
  page: number;
  /** Mặc định 20. */
  perPage?: number;
}

export interface PipelinePage {
  /** Mới nhất trước. */
  items: CiPipeline[];
  nextPage: number | null;
}

/**
 * Một đoạn log job. `from` và `next` tính theo byte UTF-8 của cả log: lần sau đọc tiếp từ `next`. `complete` là job đã
 * dừng (xong, lỗi, huỷ, bỏ qua, chờ tay), log không ghi thêm nữa.
 */
export interface JobLogChunk {
  text: string;
  next: number;
  complete: boolean;
}

/** Một environment đang chờ duyệt deployment của run GitHub. */
export interface PendingDeployment {
  environment: string;
  environmentId: string;
  url: string | null;
  /** Token kết nối có được duyệt environment này không (là người duyệt được chỉ định). */
  canApprove: boolean;
  /** Người hoặc team được chỉ định duyệt. */
  reviewers: string[];
}

export interface ReviewDeploymentsInput {
  /** Tên environment, phải đang chờ duyệt. */
  environments: string[];
  decision: "approve" | "reject";
  comment: string;
}

/** Commit giữa hai bản của `compare`, cũ tới mới. `author` là tên tác giả trong git, không phải tài khoản. */
export interface CompareCommit {
  sha: string;
  /** Dòng đầu của message. */
  title: string;
  author: string | null;
  authoredAt: string | null;
}

export interface CompareResult {
  files: CommitChange[];
  commits: CompareCommit[];
  incomplete: boolean;
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
  /** Nguyên byte của file ở commit `sha` (ảnh, PDF…), không giải mã chữ; null khi không có file. */
  readFileBytes(ref: RepoRef, path: string, sha: string): Promise<Uint8Array | null>;
  readBlob(ref: RepoRef, blob: string): Promise<Uint8Array>;
  /** `incomplete`: danh sách file bị nhà cung cấp cắt. */
  compare(ref: RepoRef, from: string, to: string): Promise<CompareResult>;
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

  // CI: pipeline GitLab, workflow run GitHub Actions. Provider local ném lỗi `unsupported`. Thao tác ghi dùng token kết
  // nối của dự án.
  listPipelines(ref: RepoRef, opts: ListPipelinesOptions): Promise<PipelinePage>;
  /** Mọi job của pipeline (không gồm lần chạy cũ của job đã chạy lại), theo thứ tự nhà cung cấp trả. */
  pipelineJobs(ref: RepoRef, pipelineId: string): Promise<CiJob[]>;
  /** Log job từ byte `from`. Byte cuối là nửa ký tự UTF-8 thì để lại cho lần đọc sau. */
  jobLog(ref: RepoRef, jobId: string, from: number): Promise<JobLogChunk>;
  /** Chạy lại các job lỗi hoặc đã huỷ của pipeline. */
  retryPipeline(ref: RepoRef, pipelineId: string): Promise<CiPipeline>;
  cancelPipeline(ref: RepoRef, pipelineId: string): Promise<CiPipeline>;
  /** Trả job mới (id khác) do lần chạy lại tạo ra. */
  retryJob(ref: RepoRef, jobId: string): Promise<CiJob>;
  cancelJob(ref: RepoRef, jobId: string): Promise<CiJob>;
  /** Chạy job chờ tay (`manual`). Job ở trạng thái khác thì lỗi invalid. */
  playJob(ref: RepoRef, jobId: string): Promise<CiJob>;
  // Duyệt deployment chỉ GitHub có; provider không có hai hàm này thì người gọi báo chưa hỗ trợ.
  /** Environment đang chờ duyệt của run; run không chờ thì mảng rỗng. */
  pendingDeployments?(ref: RepoRef, pipelineId: string): Promise<PendingDeployment[]>;
  /** Duyệt hoặc từ chối. Environment không đang chờ thì lỗi invalid. */
  reviewDeployments?(ref: RepoRef, pipelineId: string, input: ReviewDeploymentsInput): Promise<void>;
  // Token git theo run (specs/027 R9). Kết nối PAT và provider local không có hàm này: máy dùng thông tin git sẵn có.
  /** Token chỉ ghi được vào repo `ref`. `label` đặt vào tên token GitLab để người quản trị nhận ra token của run nào. */
  issueRunToken?(ref: RepoRef, label: string): Promise<RunGitTokenGrant>;
  /** Thu hồi token có `externalId` (GitLab). Token không còn thì coi như đã thu hồi. */
  revokeRunToken?(ref: RepoRef, externalId: string): Promise<void>;
}

/** Token git cấp cho một run. Hub chỉ đưa giá trị token vào gói lease, không lưu. */
export interface RunGitTokenGrant {
  /** Host của git qua HTTPS, ví dụ `github.com`. */
  host: string;
  /** Tên đi kèm token khi git hỏi: `x-access-token` với GitHub, `oauth2` với GitLab. */
  username: string;
  token: string;
  expiresAt: Date;
  /** Id token phía GitLab để thu hồi; null với GitHub vì token cài đặt tự hết hạn sau 1 giờ. */
  externalId: string | null;
}

/** Cho phép test và proxy thay `fetch`, không phụ thuộc dispatcher toàn cục. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
