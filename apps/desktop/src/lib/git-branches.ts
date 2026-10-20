import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/tauri.ts";

/**
 * Quản lý nhánh Git trên máy (specs/026-desktop-git-branches): xem, đổi, tạo, dọn nhánh và merge/rebase qua
 * `hive-worker branches`. Kiểu viết tay theo specs/026-desktop-git-branches/contracts/branches-cli.md; sửa hợp đồng
 * thì sửa cả file này.
 */
export type ErrorCode =
  | "invalid_input"
  | "not_repo"
  | "not_found"
  | "invalid_name"
  | "exists"
  | "dirty"
  | "in_progress"
  | "no_operation"
  | "checked_out"
  | "detached"
  | "no_upstream"
  | "diverged"
  | "busy"
  | "needsConfirm"
  | "fetch_failed"
  | "auth"
  | "locked"
  | "timeout"
  | "cancelled"
  | "invalid_settings"
  | "git"
  | "not_implemented";

export type OperationKind = "merge" | "rebase" | "cherryPick" | "revert" | "bisect";
export type BusyKind = "hiveWorker" | "agent" | "terminal" | "app";

export interface BusyDir {
  path: string;
  kind: "agent" | "terminal" | "app";
  label?: string | undefined;
}

export interface BranchError {
  code: ErrorCode;
  message: string;
  detail?: string | undefined;
  files?: string[] | undefined;
  filesTotal?: number | undefined;
  count?: number | undefined;
  path?: string | undefined;
  operation?: OperationKind | undefined;
  busy?: BusyDir[] | undefined;
  ahead?: number | undefined;
  behind?: number | undefined;
  upstream?: string | undefined;
  upstreamTip?: string | undefined;
  remote?: string | undefined;
}

/** Lỗi nghiệp vụ của sidecar; `message` là câu tiếng Việt nên `errorText` hiện được ngay. */
export class GitBranchError extends Error {
  readonly code: ErrorCode;
  readonly info: BranchError;
  constructor(info: BranchError) {
    super(info.message);
    this.name = "GitBranchError";
    this.code = info.code;
    this.info = info;
  }
}

export interface BranchStatus {
  folder: string;
  branch?: string | undefined;
  detached: boolean;
  head?: string | undefined;
  upstream?: string | undefined;
  upstreamGone: boolean;
  ahead?: number | undefined;
  behind?: number | undefined;
  dirty: boolean;
  untracked: boolean;
  operation?: OperationKind | undefined;
  error?: BranchError | undefined;
}

export interface BranchInfo {
  name: string;
  ref: string;
  kind: "local" | "remote";
  remote?: string | undefined;
  upstream?: string | undefined;
  upstreamGone: boolean;
  aheadUpstream?: number | undefined;
  behindUpstream?: number | undefined;
  aheadDefault?: number | undefined;
  behindDefault?: number | undefined;
  tip: string;
  /** Giây Unix. */
  committedAt: number;
  subject?: string | undefined;
  worktreePath?: string | undefined;
  unpushed?: number | undefined;
  isCurrent: boolean;
  isDefault: boolean;
  matchesPattern: boolean;
}

export type WorktreeState =
  | "pending"
  | "skipped"
  | "clean"
  | "dirty"
  | "untracked"
  | "missing"
  | "unreachable"
  | "error";

export interface WorktreeInfo {
  path: string;
  branch?: string | undefined;
  head?: string | undefined;
  isMain: boolean;
  locked: boolean;
  lockReason?: string | undefined;
  prunable: boolean;
  bare: boolean;
  state: WorktreeState;
  files?: string[] | undefined;
  filesTotal?: number | undefined;
  ignoredBlocking?: string[] | undefined;
  submodule: boolean;
  busy?: BusyKind | undefined;
  operation?: OperationKind | undefined;
  error?: string | undefined;
}

export interface GitOperation {
  kind: OperationKind;
  state: "done" | "conflict" | "inProgress" | "aborted" | "error";
  branch?: string | undefined;
  onto?: { name: string; tip: string } | undefined;
  headBefore?: string | undefined;
  head?: string | undefined;
  conflicts: string[];
  conflictsTotal: number;
  step?: number | undefined;
  total?: number | undefined;
  error?: BranchError | undefined;
}

export interface RepoBranches {
  folder: string;
  defaultBranch?: string | undefined;
  defaultRef?: string | undefined;
  current: BranchStatus;
  operation?: GitOperation | undefined;
  remotes: string[];
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  patterns: string[];
  slowPath: boolean;
  gitVersion?: string | undefined;
  error?: BranchError | undefined;
}

export type EvidenceKind = "mergedGit" | "mergedApi" | "closedApi" | "none";

export interface Evidence {
  kind: EvidenceKind;
  onto?: string | undefined;
  provider?: "github" | "gitlab" | undefined;
  number?: number | undefined;
  url?: string | undefined;
  note?: "notMerged" | "noOwnCommits" | "olderThanWindow" | "noDefaultBranch" | "prOpen" | undefined;
}

export type BlockCode =
  | "hiveWorker"
  | "busy"
  | "unreachable"
  | "locked"
  | "submodule"
  | "dirty"
  | "untracked"
  | "ignored"
  | "unpushed"
  | "prOpen"
  | "current"
  | "checkedOutMain"
  | "noEvidence"
  | "needsFetch";

export interface BlockReason {
  code: BlockCode;
  message: string;
  files?: string[] | undefined;
  filesTotal?: number | undefined;
  count?: number | undefined;
  busy?: BusyDir[] | undefined;
}

export interface CandidateWorktree {
  path: string;
  prunable: boolean;
  agentWorktree: boolean;
  ignored?: string[] | undefined;
}

export interface Candidate {
  folder: string;
  branch: string;
  tip: string;
  committedAt: number;
  subject?: string | undefined;
  worktree?: CandidateWorktree | undefined;
  evidence: Evidence;
  selected: boolean;
  blocked?: BlockReason | undefined;
}

export interface FetchFailure {
  remote: string;
  message: string;
  auth: boolean;
}

export interface ScanRepo {
  folder: string;
  defaultBranch?: string | undefined;
  current?: string | undefined;
  fetched: string[];
  fetchFailed: FetchFailure[];
  apiError?: string | undefined;
  candidates: Candidate[];
  blocked: Candidate[];
  suggestDefault?: { branch: string; clean: boolean } | undefined;
  error?: BranchError | undefined;
}

export interface CleanItem {
  folder: string;
  branch: string;
  tip: string;
  worktree?: string | undefined;
  prunable?: boolean | undefined;
  evidence: Evidence;
}

export type CleanOutcome = "removed" | "skipped" | "partial" | "error" | "cancelled";

export interface CleanResult {
  folder: string;
  branch: string;
  tip: string;
  worktree?: string | undefined;
  result: CleanOutcome;
  code?: BlockCode | "tipChanged" | "remoteGone" | "remoteMoved" | ErrorCode | undefined;
  reason?: string | undefined;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  left?: string | undefined;
}

export interface BranchSettingsInput {
  patterns: string[];
  rebuildable: string[];
}

export interface BranchSettings extends BranchSettingsInput {
  path: string;
  defaults: BranchSettingsInput;
}

export interface SwitchResult {
  folder: string;
  branch: string;
  headBefore?: string | undefined;
  head: string;
  carried: boolean;
}

export interface CreateResult {
  folder: string;
  name: string;
  base: string;
  tip: string;
  switched: boolean;
  fetched: boolean;
  dryRun: boolean;
}

export interface PullResult {
  state: "done" | "unchanged";
  headBefore?: string | undefined;
  head?: string | undefined;
  behind?: number | undefined;
}

export type ProgressStep = "fetch" | "read" | "evidence" | "api" | "merge" | "removeWorktree" | "deleteBranch";

export interface ProgressEvent {
  type: "progress";
  folder?: string | undefined;
  branch?: string | undefined;
  remote?: string | undefined;
  step: ProgressStep;
  result?: "done" | "failed" | undefined;
  error?: BranchError | undefined;
  done?: number | undefined;
  total?: number | undefined;
}

export interface DoneEvent {
  type: "done";
  folder?: string | undefined;
  error?: BranchError | undefined;
  fetched?: string[] | undefined;
  fetchFailed?: FetchFailure[] | undefined;
  /** RFC 3339; chỉ có khi fetch được ít nhất một remote. */
  fetchedAt?: string | undefined;
  pull?: PullResult | undefined;
  summary?: Record<string, number> | undefined;
  log?: string | undefined;
  total?: number | undefined;
  done?: number | undefined;
}

export type BranchEvent =
  | ProgressEvent
  | { type: "worktree"; folder: string; worktree: WorktreeInfo }
  | { type: "repo"; folder: string; repo: ScanRepo; done?: number | undefined; total?: number | undefined }
  | { type: "item"; item: CleanResult; done?: number | undefined; total?: number | undefined }
  | DoneEvent
  | { type: "exit"; message?: string | undefined };

// Kết quả có `error` là lỗi nghiệp vụ (sidecar vẫn thoát 0); ném ra để màn chỉ cần một nhánh catch.
async function call<T extends object>(command: string, args?: Record<string, unknown>): Promise<T> {
  const result = await invoke<T & { error?: BranchError | undefined }>(command, args);
  if (result.error) throw new GitBranchError(result.error);
  return result;
}

// Đăng ký nghe trước khi bắt đầu job: dòng đầu có thể tới trước khi invoke trả jobId.
async function startJob(command: string, args?: Record<string, unknown>): Promise<string> {
  await ensureListening();
  return invoke<string>(command, args);
}

export interface BusyOptions {
  confirmBusy?: boolean | undefined;
}

export const branchStatus = (folders: string[]) =>
  call<{ repos: BranchStatus[] }>("git_branches_status", { folders }).then((r) => r.repos);

/** Bảng nhánh; trạng thái worktree liên kết đến sau qua `useBranchJob(jobId)`. */
export async function listBranches(folder: string): Promise<RepoBranches & { jobId: string }> {
  await ensureListening();
  return call<RepoBranches & { jobId: string }>("git_branches_list", { folder });
}

export const switchBranch = (
  folder: string,
  target: { branch: string } | { track: string },
  opts: BusyOptions & { carry?: boolean | undefined } = {},
) =>
  call<SwitchResult>("git_branches_switch", {
    folder,
    branch: "branch" in target ? target.branch : null,
    track: "track" in target ? target.track : null,
    carry: opts.carry ?? false,
    confirmBusy: opts.confirmBusy ?? false,
  });

/** `base` là tên ref đầy đủ (`refs/remotes/origin/main`) để tag trùng tên không bị nhầm. */
export const createBranch = (
  folder: string,
  name: string,
  base: string,
  opts: BusyOptions & {
    switchTo?: boolean | undefined;
    fetch?: boolean | undefined;
    carry?: boolean | undefined;
    dryRun?: boolean | undefined;
  } = {},
) =>
  call<CreateResult>("git_branches_create", {
    folder,
    name,
    base,
    switchTo: opts.switchTo ?? false,
    fetch: opts.fetch ?? false,
    carry: opts.carry ?? false,
    confirmBusy: opts.confirmBusy ?? false,
    dryRun: opts.dryRun ?? false,
  });

export const fetchRemotes = (folder: string) => startJob("git_branches_fetch", { folder });
export const pullBranch = (folder: string, opts: BusyOptions = {}) =>
  startJob("git_branches_pull", { folder, confirmBusy: opts.confirmBusy ?? false });
export const scanBranches = (folders: string[], opts: { fetch?: boolean | undefined } = {}) =>
  startJob("git_branches_scan", { folders, fetch: opts.fetch ?? true });
/** `fetched`: thư mục chính → remote fetch được lúc quét (`ScanRepo.fetched`), để kiểm commit chưa đẩy (FR-027). */
export const cleanBranches = (items: CleanItem[], fetched: Record<string, string[]>) =>
  startJob("git_branches_clean", { items, fetched });
export const cancelBranchJob = (jobId: string) => invoke<void>("git_branches_cancel", { jobId });

export const branchSettings = () => call<BranchSettings>("git_branches_settings");
export const setBranchSettings = (settings: BranchSettingsInput) =>
  call<BranchSettings>("git_branches_settings_set", { settings });

/** `onto.tip` là mã đã đọc lúc bấm, để nhánh đích đổi giữa chừng không làm merge nhầm (FR-050). */
export const mergeBranch = (
  folder: string,
  onto: { name: string; tip: string },
  opts: BusyOptions & { ff?: boolean | undefined } = {},
) =>
  call<{ operation: GitOperation }>("git_branches_merge", {
    folder,
    onto: onto.tip,
    ontoName: onto.name,
    ff: opts.ff ?? false,
    confirmBusy: opts.confirmBusy ?? false,
  }).then((r) => r.operation);

export const rebaseBranch = (
  folder: string,
  onto: { name: string; tip: string },
  opts: BusyOptions & { confirmRewrite?: boolean | undefined } = {},
) =>
  call<{ operation: GitOperation }>("git_branches_rebase", {
    folder,
    onto: onto.tip,
    ontoName: onto.name,
    confirmRewrite: opts.confirmRewrite ?? false,
    confirmBusy: opts.confirmBusy ?? false,
  }).then((r) => r.operation);

export const continueOperation = (folder: string) =>
  call<{ operation: GitOperation }>("git_branches_continue", { folder }).then((r) => r.operation);
export const abortOperation = (folder: string) =>
  call<{ operation: GitOperation }>("git_branches_abort", { folder }).then((r) => r.operation);

/** Tiến độ của một job (list, fetch, pull, scan, clean), gom từ các sự kiện. */
export interface BranchJob {
  total: number;
  done: number;
  finished: boolean;
  progress?: ProgressEvent | undefined;
  /** fetch, pull: kết quả từng remote. */
  remotes: Record<string, { result: "done" | "failed"; error?: BranchError | undefined }>;
  /** list: worktree theo đường dẫn. */
  worktrees: Record<string, WorktreeInfo>;
  /** scan: repo theo thư mục chính. */
  repos: Record<string, ScanRepo>;
  /** clean: theo thứ tự xong. */
  items: CleanResult[];
  result?: DoneEvent | undefined;
  /** Câu hiện cho người dùng khi cả job lỗi hay worker dừng giữa chừng. */
  error?: string | undefined;
  errorCode?: ErrorCode | undefined;
}

export const emptyBranchJob = (): BranchJob => ({
  total: 0,
  done: 0,
  finished: false,
  remotes: {},
  worktrees: {},
  repos: {},
  items: [],
});
// Cùng một đối tượng cho mọi lần đọc khi chưa có sự kiện: useSyncExternalStore so bằng ===.
const NO_EVENTS = emptyBranchJob();

// FR-004: thời điểm fetch gần nhất chỉ cần trong phiên app, không ghi đĩa.
const fetchedAt = new Map<string, string>();
export const lastFetchedAt = (folder: string) => fetchedAt.get(folder);

const counts = (e: { done?: number | undefined; total?: number | undefined }, job: BranchJob) => ({
  done: e.done ?? job.done,
  total: e.total ?? job.total,
});

export function applyBranchEvent(job: BranchJob, e: BranchEvent): BranchJob {
  switch (e.type) {
    case "progress": {
      const remotes =
        e.remote && e.result ? { ...job.remotes, [e.remote]: { result: e.result, error: e.error } } : job.remotes;
      return { ...job, ...counts(e, job), progress: e, remotes };
    }
    case "worktree":
      return { ...job, worktrees: { ...job.worktrees, [e.worktree.path]: e.worktree } };
    case "repo":
      return { ...job, ...counts(e, job), repos: { ...job.repos, [e.repo.folder]: e.repo } };
    case "item":
      return { ...job, ...counts(e, job), items: [...job.items, e.item] };
    case "done":
      if (e.folder && e.fetchedAt) fetchedAt.set(e.folder, e.fetchedAt);
      return {
        ...job,
        ...counts(e, job),
        finished: true,
        result: e,
        error: e.error?.message,
        errorCode: e.error?.code,
      };
    case "exit":
      return { ...job, finished: true, error: e.message || "Worker dừng giữa chừng." };
  }
  return job;
}

// Sự kiện có thể đến trước khi lệnh Tauri trả id: gom theo id ở cấp module, màn đọc theo id khi đã biết.
let jobs: Record<string, BranchJob> = {};
const listeners = new Set<() => void>();
let listening: { tauri: unknown; ready: Promise<void> } | null = null;

function ensureListening(): Promise<void> {
  const tauri = window.__TAURI__;
  if (!tauri?.event) return Promise.resolve();
  if (listening?.tauri === tauri) return listening.ready;
  const ready = tauri.event
    .listen<{ jobId: string; event: BranchEvent }>("git-branches:event", (e) => {
      const { jobId, event } = e.payload;
      jobs = { ...jobs, [jobId]: applyBranchEvent(jobs[jobId] ?? emptyBranchJob(), event) };
      for (const l of listeners) l();
    })
    .then(
      () => {},
      () => {
        listening = null;
      },
    );
  listening = { tauri, ready };
  return ready;
}

/** Tiến độ của job jobId; null khi chưa chạy. */
export function useBranchJob(jobId: string | null): BranchJob | null {
  useEffect(() => {
    void ensureListening();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (jobId ? (jobs[jobId] ?? NO_EVENTS) : null),
  );
}

/** Bảng nhánh với trạng thái worktree đã đến qua sự kiện `worktree` của `list`. */
export function withWorktreeEvents(repo: RepoBranches, job: BranchJob | null): RepoBranches {
  if (!job || Object.keys(job.worktrees).length === 0) return repo;
  return { ...repo, worktrees: repo.worktrees.map((w) => job.worktrees[w.path] ?? w) };
}

/**
 * Kiểm tên nhánh ngay khi gõ theo luật của `git check-ref-format --branch`; null khi hợp lệ. Sidecar vẫn kiểm lại
 * (`create --dry-run`) vì đây chỉ là bản gần đúng.
 */
export function branchNameError(name: string): string | null {
  if (name.trim() === "") return "Nhập tên nhánh.";
  if (name === "@") return "Tên nhánh không được là “@”.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git cấm ký tự điều khiển trong tên ref.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return "Tên nhánh không được có khoảng trắng hay ký tự ~ ^ : ? * [ \\.";
  if (name.startsWith("-")) return "Tên nhánh không được bắt đầu bằng “-”.";
  if (name.includes("..")) return "Tên nhánh không được có “..”.";
  if (name.includes("@{")) return "Tên nhánh không được có “@{”.";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//"))
    return "Tên nhánh không được có “/” ở đầu, cuối hay hai “/” liền nhau.";
  if (name.endsWith(".")) return "Tên nhánh không được kết thúc bằng “.”.";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "Mỗi phần của tên nhánh không được bắt đầu bằng “.”.";
    if (part.endsWith(".lock")) return "Mỗi phần của tên nhánh không được kết thúc bằng “.lock”.";
  }
  return null;
}

// Tên nhánh hợp lệ vẫn có thể chứa ' $ & ( ): bọc lại để người dùng dán vào terminal không chạy nhầm.
function shellQuote(value: string, windows: boolean): string {
  if (/^[\w./@+-]+$/.test(value)) return value;
  return windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Lệnh khôi phục nhánh đã xoá (FR-032). `windows` dùng cách bọc của PowerShell. */
export const restoreCommand = (branch: string, tip: string, windows = false) =>
  `git branch ${shellQuote(branch, windows)} ${tip}`;

/** Lệnh đưa nhánh về trước merge/rebase (FR-056); app không tự chạy. */
export const resetKeepCommand = (headBefore: string) => `git reset --keep ${headBefore}`;
