import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { shortPath } from "@/lib/folder.ts";
import {
  type BlockCode,
  type BlockReason,
  type BranchSettings,
  branchSettings,
  type Candidate,
  type CleanItem,
  type CleanResult,
  cancelBranchJob,
  cleanBranches,
  type Evidence,
  type ProgressStep,
  restoreCommand,
  type ScanRepo,
  scanBranches,
  setBranchSettings,
  useBranchJob,
} from "@/lib/git-branches.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

/** "MR !12" (GitLab), "PR #12" (GitHub); thiếu số thì chỉ còn "MR"/"PR". */
const requestRef = (e: Evidence) =>
  e.provider === "gitlab" ? `MR${e.number ? ` !${e.number}` : ""}` : `PR${e.number ? ` #${e.number}` : ""}`;

const text: Dict<{
  title: string;
  lead: string;
  scanning: string;
  scanProgress: (done: number, total: number) => string;
  repoWaiting: string;
  repoDone: (n: number) => string;
  steps: Record<ProgressStep, string>;
  cancel: string;
  close: string;
  retry: string;
  rescan: string;
  scanFailed: string;
  summary: (candidates: number, blocked: number, repos: number) => string;
  selected: (n: number, total: number) => string;
  nothing: string;
  repoNothing: string;
  fetchFailed: string;
  fetchFailedAuth: string;
  apiError: (reason: string) => string;
  repoError: (message: string) => string;
  suggestDefault: (current: ReactNode, main: ReactNode) => ReactNode;
  suggestDirty: string;
  checkLabel: (branch: string) => string;
  evidence: (e: Evidence) => ReactNode;
  noEvidence: Record<NonNullable<Evidence["note"]>, string>;
  committed: (when: string) => string;
  worktree: string;
  agentWorktree: string;
  prunableNote: string;
  ignoredLose: (files: string) => string;
  blockedGroup: (n: number) => string;
  blockReason: Record<BlockCode, (b: BlockReason) => string>;
  moreFiles: (n: number) => string;
  busyKind: Record<"agent" | "terminal" | "app", string>;
  settings: string;
  settingsLead: string;
  patterns: string;
  patternsHint: string;
  rebuildable: string;
  rebuildableHint: string;
  settingsPath: (path: string) => string;
  settingsLoading: string;
  saveRescan: string;
  saving: string;
  defaults: string;
  clean: (n: number) => string;
  confirmTitle: (n: number) => string;
  confirmBody: (branches: number, worktrees: number) => ReactNode;
  confirmPrunable: (n: number) => string;
  confirmKeep: string;
  confirmRestore: string;
  confirmAction: string;
  cleaning: string;
  cleanProgress: (done: number, total: number) => string;
  cancelClean: string;
  cancelling: string;
  resultTitle: string;
  resultSummary: (removed: number, skipped: number, failed: number) => string;
  outcomes: Record<CleanResult["result"], string>;
  codeReason: Record<string, string>;
  left: (path: string) => string;
  restore: string;
  copyRestore: string;
  copyAll: string;
  copied: string;
  workerStopped: string;
  logAt: (path: string) => string;
}> = {
  vi: {
    title: "Dọn nhánh đã merge",
    lead: "Quét tìm nhánh khớp mẫu dọn đã vào nhánh mặc định. Chỉ xoá nhánh local và worktree của chúng, không đụng remote.",
    scanning: "Đang fetch và quét…",
    scanProgress: (done, total) => `Đã quét ${done}/${total} repo`,
    repoWaiting: "Đang chờ",
    repoDone: (n) => (n === 0 ? "Xong, không có gì để dọn" : `Xong, ${n} nhánh dọn được`),
    steps: {
      fetch: "đang fetch",
      read: "đang đọc nhánh",
      evidence: "đang kiểm bằng chứng merge",
      api: "đang hỏi GitHub/GitLab",
      merge: "đang merge",
      removeWorktree: "đang gỡ worktree",
      deleteBranch: "đang xoá nhánh",
    },
    cancel: "Huỷ",
    close: "Đóng",
    retry: "Thử lại",
    rescan: "Quét lại",
    scanFailed: "Quét không xong",
    summary: (candidates, blocked, repos) =>
      `${candidates} nhánh dọn được, ${blocked} nhánh không dọn, trong ${repos} repo.`,
    selected: (n, total) => `Đã chọn ${n}/${total}`,
    nothing: "Không có nhánh nào khớp mẫu dọn và đã merge.",
    repoNothing: "Không có nhánh nào để dọn.",
    fetchFailed: "Không fetch được, chỉ dùng bằng chứng đã có trên máy",
    fetchFailedAuth: "Không đăng nhập được remote, chỉ dùng bằng chứng đã có trên máy",
    apiError: (reason) => `Không đọc được PR/MR: ${reason}`,
    repoError: (message) => `Repo này không quét được: ${message}`,
    suggestDefault: (current, main) => (
      <>
        Thư mục chính đang ở {current}, nên nhánh đó chưa dọn được. Về nhánh mặc định {main} (trong bảng Nhánh) rồi quét
        lại.
      </>
    ),
    suggestDirty: "Thư mục chính đang có thay đổi, hãy xử lý trước khi đổi nhánh.",
    checkLabel: (branch) => `Dọn nhánh ${branch}`,
    evidence: (e) => {
      const ref = requestRef(e);
      switch (e.kind) {
        case "mergedGit":
          return (
            <>
              Đã vào{" "}
              <span translate="no" className="font-mono">
                {e.onto ?? "nhánh mặc định"}
              </span>{" "}
              qua merge commit
            </>
          );
        case "mergedApi":
          return `${ref} đã merge`;
        case "closedApi":
          return `${ref} đã đóng, chưa merge`;
        case "none":
          return "Chưa có bằng chứng merge";
      }
    },
    noEvidence: {
      notMerged: "Chưa vào nhánh mặc định.",
      noOwnCommits: "Chưa có commit riêng hoặc merge tiến nhanh.",
      olderThanWindow: "Cũ hơn khoảng lịch sử đã kiểm, không rõ đã merge chưa.",
      noDefaultBranch: "Repo không xác định được nhánh mặc định.",
      prOpen: "PR/MR đang mở.",
    },
    committed: (when) => `commit cuối ${when}`,
    worktree: "Worktree",
    agentWorktree: "Của agent",
    prunableNote: "Thư mục không còn hoặc ổ chưa gắn: chỉ gỡ đăng ký worktree, không xoá file.",
    ignoredLose: (files) => `File bị bỏ qua sẽ mất theo: ${files}`,
    blockedGroup: (n) => `Không dọn (${n})`,
    blockReason: {
      hiveWorker: () => "Của worker Hive, không đụng tới.",
      busy: (b) => (b.busy?.length ? "Đang có chương trình dùng thư mục này." : "Đang có chương trình dùng thư mục."),
      unreachable: () => "Không truy cập được thư mục hay ổ chứa worktree.",
      locked: () => "Worktree đang bị khoá.",
      submodule: () => "Worktree có submodule.",
      dirty: (b) => `Có ${b.filesTotal ?? b.files?.length ?? 0} file đã sửa chưa commit.`,
      untracked: (b) => `Có ${b.filesTotal ?? b.files?.length ?? 0} file chưa theo dõi.`,
      ignored: (b) => `Có ${b.filesTotal ?? b.files?.length ?? 0} file bị bỏ qua không dựng lại được.`,
      unpushed: (b) => `Có ${b.count ?? 0} commit chưa đẩy lên remote nào.`,
      prOpen: () => "PR/MR đang mở.",
      current: () => "Thư mục chính đang đứng ở nhánh này.",
      checkedOutMain: () => "Nhánh đang mở ở thư mục chính của một worktree không gỡ được.",
      noEvidence: () => "Chưa có bằng chứng merge.",
      needsFetch: () => "Cần fetch được để kiểm.",
    },
    moreFiles: (n) => `và ${n} file nữa`,
    busyKind: { agent: "Agent đang chạy", terminal: "Terminal đang mở", app: "App đang dùng" },
    settings: "Mẫu dọn và thư mục dựng lại được",
    settingsLead:
      "Mỗi dòng một mục. Mẫu dọn là glob đơn giản, dấu * khớp mọi ký tự kể cả /. Worktree chỉ gỡ khi mọi file bị bỏ qua nằm trong một thư mục dựng lại được.",
    patterns: "Mẫu tên nhánh được dọn",
    patternsHint: "ai/*",
    rebuildable: "Thư mục dựng lại được",
    rebuildableHint: "node_modules",
    settingsPath: (path) => `Lưu ở ${path}`,
    settingsLoading: "Đang đọc cấu hình…",
    saveRescan: "Lưu và quét lại",
    saving: "Đang lưu…",
    defaults: "Về mặc định",
    clean: (n) => `Dọn ${n} mục`,
    confirmTitle: (n) => `Dọn ${n} mục?`,
    confirmBody: (branches, worktrees) => (
      <>
        Sẽ xoá <span className="font-mono">{branches}</span> nhánh local và gỡ{" "}
        <span className="font-mono">{worktrees}</span> worktree.
      </>
    ),
    confirmPrunable: (n) => `${n} worktree chỉ gỡ đăng ký, không xoá file.`,
    confirmKeep: "Nhánh local sẽ bị xoá. Commit vẫn còn trên remote.",
    confirmRestore: "Mã commit đỉnh của từng nhánh được ghi lại để khôi phục.",
    confirmAction: "Dọn",
    cleaning: "Đang dọn…",
    cleanProgress: (done, total) => `Đã xử lý ${done}/${total} mục`,
    cancelClean: "Huỷ",
    cancelling: "Đang huỷ, chờ mục đang chạy xong…",
    resultTitle: "Kết quả dọn",
    resultSummary: (removed, skipped, failed) => `Đã dọn ${removed}, bỏ qua ${skipped}, lỗi hay dở dang ${failed}.`,
    outcomes: {
      removed: "Đã dọn",
      skipped: "Bỏ qua",
      partial: "Dở dang",
      error: "Lỗi",
      cancelled: "Chưa chạy",
    },
    codeReason: {
      tipChanged: "Nhánh đã đổi sau khi xem trước",
      remoteGone: "Nhánh không còn trên remote",
      remoteMoved: "Nhánh trên remote đã đổi",
      locked: "Repo đang bận, thử lại sau",
      busy: "Có chương trình đang dùng thư mục",
      dirty: "Worktree đã có thay đổi",
      untracked: "Worktree đã có file chưa theo dõi",
      ignored: "Worktree đã có file bị bỏ qua không dựng lại được",
      unpushed: "Nhánh đã có commit chưa đẩy",
      hiveWorker: "Của worker Hive",
      cancelled: "Đã huỷ trước khi tới mục này",
    },
    left: (path) => `Gỡ dở, còn lại ${path}`,
    restore: "Lệnh khôi phục",
    copyRestore: "Sao chép lệnh khôi phục",
    copyAll: "Sao chép mọi lệnh khôi phục",
    copied: "Đã sao chép",
    workerStopped: "Worker dừng giữa chừng.",
    logAt: (path) => `Nhật ký: ${path}`,
  },
  en: {
    title: "Clean up merged branches",
    lead: "Scan for branches matching the cleanup pattern that already landed in the default branch. Only local branches and their worktrees are removed, never anything on a remote.",
    scanning: "Fetching and scanning…",
    scanProgress: (done, total) => `Scanned ${done}/${total} ${total === 1 ? "repository" : "repositories"}`,
    repoWaiting: "Waiting",
    repoDone: (n) => (n === 0 ? "Done, nothing to clean" : `Done, ${n} ${n === 1 ? "branch" : "branches"} can go`),
    steps: {
      fetch: "fetching",
      read: "reading branches",
      evidence: "checking merge evidence",
      api: "asking GitHub/GitLab",
      merge: "merging",
      removeWorktree: "removing worktree",
      deleteBranch: "deleting branch",
    },
    cancel: "Cancel",
    close: "Close",
    retry: "Try again",
    rescan: "Scan again",
    scanFailed: "The scan did not finish",
    summary: (candidates, blocked, repos) =>
      `${candidates} ${candidates === 1 ? "branch" : "branches"} can go, ${blocked} cannot, across ${repos} ${repos === 1 ? "repository" : "repositories"}.`,
    selected: (n, total) => `${n}/${total} selected`,
    nothing: "No branch matches the cleanup pattern and is merged.",
    repoNothing: "Nothing to clean here.",
    fetchFailed: "Could not fetch, using only the evidence already on this machine",
    fetchFailedAuth: "Could not sign in to the remote, using only the evidence already on this machine",
    apiError: (reason) => `Could not read PRs/MRs: ${reason}`,
    repoError: (message) => `This repository could not be scanned: ${message}`,
    suggestDefault: (current, main) => (
      <>
        The main folder is on {current}, so that branch cannot be cleaned yet. Switch back to the default branch {main}{" "}
        (in the Branches panel) and scan again.
      </>
    ),
    suggestDirty: "The main folder has changes, deal with them before switching branches.",
    checkLabel: (branch) => `Clean up ${branch}`,
    evidence: (e) => {
      const ref = requestRef(e);
      switch (e.kind) {
        case "mergedGit":
          return (
            <>
              Merged into{" "}
              <span translate="no" className="font-mono">
                {e.onto ?? "the default branch"}
              </span>{" "}
              by a merge commit
            </>
          );
        case "mergedApi":
          return `${ref} merged`;
        case "closedApi":
          return `${ref} closed, not merged`;
        case "none":
          return "No merge evidence";
      }
    },
    noEvidence: {
      notMerged: "Not in the default branch yet.",
      noOwnCommits: "No commits of its own, or a fast-forward merge.",
      olderThanWindow: "Older than the history window checked, unknown whether it merged.",
      noDefaultBranch: "The repository has no known default branch.",
      prOpen: "PR/MR is open.",
    },
    committed: (when) => `last commit ${when}`,
    worktree: "Worktree",
    agentWorktree: "Agent's",
    prunableNote: "Folder is gone or the drive is not mounted: only the worktree registration is removed, no files.",
    ignoredLose: (files) => `Ignored files that go with it: ${files}`,
    blockedGroup: (n) => `Not cleaned (${n})`,
    blockReason: {
      hiveWorker: () => "Belongs to the Hive worker, left alone.",
      busy: () => "Something is using this folder.",
      unreachable: () => "The worktree's folder or drive is not reachable.",
      locked: () => "The worktree is locked.",
      submodule: () => "The worktree has a submodule.",
      dirty: (b) => {
        const n = b.filesTotal ?? b.files?.length ?? 0;
        return `${n} modified ${n === 1 ? "file" : "files"} not committed.`;
      },
      untracked: (b) => {
        const n = b.filesTotal ?? b.files?.length ?? 0;
        return `${n} untracked ${n === 1 ? "file" : "files"}.`;
      },
      ignored: (b) => {
        const n = b.filesTotal ?? b.files?.length ?? 0;
        return `${n} ignored ${n === 1 ? "file" : "files"} that cannot be rebuilt.`;
      },
      unpushed: (b) => `${b.count ?? 0} ${b.count === 1 ? "commit" : "commits"} not pushed to any remote.`,
      prOpen: () => "PR/MR is open.",
      current: () => "The main folder is on this branch.",
      checkedOutMain: () => "The branch is checked out in the main folder of a worktree that cannot be removed.",
      noEvidence: () => "No merge evidence yet.",
      needsFetch: () => "Needs a working fetch to check.",
    },
    moreFiles: (n) => `and ${n} more`,
    busyKind: { agent: "Agent running", terminal: "Terminal open", app: "Used by the app" },
    settings: "Cleanup pattern and rebuildable folders",
    settingsLead:
      "One entry per line. The cleanup pattern is a simple glob where * matches any character including /. A worktree is removed only when every ignored file sits inside a rebuildable folder.",
    patterns: "Branch name patterns to clean",
    patternsHint: "ai/*",
    rebuildable: "Rebuildable folders",
    rebuildableHint: "node_modules",
    settingsPath: (path) => `Saved at ${path}`,
    settingsLoading: "Reading settings…",
    saveRescan: "Save and scan again",
    saving: "Saving…",
    defaults: "Reset to defaults",
    clean: (n) => `Clean ${n} ${n === 1 ? "item" : "items"}`,
    confirmTitle: (n) => `Clean ${n} ${n === 1 ? "item" : "items"}?`,
    confirmBody: (branches, worktrees) => (
      <>
        This deletes <span className="font-mono">{branches}</span> local {branches === 1 ? "branch" : "branches"} and
        removes <span className="font-mono">{worktrees}</span> {worktrees === 1 ? "worktree" : "worktrees"}.
      </>
    ),
    confirmPrunable: (n) => `${n} ${n === 1 ? "worktree is" : "worktrees are"} only unregistered, no files deleted.`,
    confirmKeep: "Local branches will be deleted. The commits stay on the remote.",
    confirmRestore: "The tip commit of every branch is recorded so you can restore it.",
    confirmAction: "Clean",
    cleaning: "Cleaning…",
    cleanProgress: (done, total) => `Handled ${done}/${total} ${total === 1 ? "item" : "items"}`,
    cancelClean: "Cancel",
    cancelling: "Cancelling, waiting for the running item to finish…",
    resultTitle: "Cleanup result",
    resultSummary: (removed, skipped, failed) => `Cleaned ${removed}, skipped ${skipped}, failed or partial ${failed}.`,
    outcomes: {
      removed: "Cleaned",
      skipped: "Skipped",
      partial: "Partial",
      error: "Error",
      cancelled: "Not run",
    },
    codeReason: {
      tipChanged: "The branch changed since the preview",
      remoteGone: "The branch is no longer on the remote",
      remoteMoved: "The branch on the remote changed",
      locked: "The repository is busy, try again later",
      busy: "Something is using the folder",
      dirty: "The worktree now has changes",
      untracked: "The worktree now has untracked files",
      ignored: "The worktree now has ignored files that cannot be rebuilt",
      unpushed: "The branch now has unpushed commits",
      hiveWorker: "Belongs to the Hive worker",
      cancelled: "Cancelled before this item",
    },
    left: (path) => `Half removed, ${path} is left`,
    restore: "Restore command",
    copyRestore: "Copy restore command",
    copyAll: "Copy all restore commands",
    copied: "Copied",
    workerStopped: "The worker stopped midway.",
    logAt: (path) => `Log: ${path}`,
  },
};

const locale = (lang: Lang) => (lang === "vi" ? "vi-VN" : "en-GB");
const itemKey = (c: { folder: string; branch: string }) => `${c.folder}\n${c.branch}`;
const isWindows = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const OUTCOME_TONE: Record<CleanResult["result"], "neutral" | "ok" | "warn" | "bad"> = {
  removed: "ok",
  skipped: "neutral",
  partial: "warn",
  error: "bad",
  cancelled: "neutral",
};

/** Tên nhánh trong câu: mono, không dịch. */
function Name({ children }: { children: ReactNode }) {
  return (
    <span translate="no" className="font-mono font-medium">
      {children}
    </span>
  );
}

/** Danh sách file (tối đa 20 do sidecar cắt) kèm "và N file nữa". */
function FileList({ files, total }: { files: string[]; total?: number | undefined }) {
  const t = useT(text);
  const hidden = (total ?? files.length) - files.length;
  return (
    <>
      <ul
        translate="no"
        className="max-h-32 overflow-y-auto rounded-lg border bg-muted/50 px-2.5 py-1.5 font-mono text-xs"
      >
        {files.map((f) => (
          <li key={f} className="break-all">
            {f}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="text-xs text-muted-foreground">{t.moreFiles(hidden)}</p>}
    </>
  );
}

function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * Dọn nhánh đã merge (US4): Quét → Xem trước → Xác nhận → Đang dọn → Kết quả. Mọi quyết định an toàn (bước chặn, kiểm lại
 * ngay trước khi ghi) nằm ở sidecar; hộp thoại chỉ cho người dùng chọn trong số ứng viên sidecar đã duyệt và trình bày
 * kết quả. Bước hiện tại suy ra từ tiến độ của hai job nên đóng mở hộp thoại không để lại trạng thái lệch.
 */
export function CleanupDialog({
  folders,
  onClose,
  onChanged,
}: {
  /** Thư mục chính của các repo cần quét (mục trong `projects.json`). */
  folders: string[];
  onClose: () => void;
  /** Sau khi dọn xong, để màn Dự án và bảng nhánh đọc lại. */
  onChanged: () => void;
}) {
  const t = useT(text);
  const [scans, setScans] = useState(0);
  const [scanId, setScanId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cleanId, setCleanId] = useState<string | null>(null);
  const [cleanError, setCleanError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Chỉ lưu chỗ người dùng đổi khác `Candidate.selected` của sidecar: quét lại thì bỏ hết, không cần effect khởi tạo.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const scanJob = useBranchJob(scanId);
  const cleanJob = useBranchJob(cleanId);
  const foldersKey = folders.join("\n");

  useEffect(() => {
    let alive = true;
    // `scans` không dùng trong thân hàm: đổi số này là cách bắt quét lại.
    void scans;
    setScanId(null);
    setScanError(null);
    setCleanId(null);
    setCleanError(null);
    setOverrides({});
    setCancelling(false);
    scanBranches(foldersKey.split("\n"), { fetch: true }).then(
      (id) => {
        if (alive) setScanId(id);
        // Đóng hộp thoại (hay StrictMode chạy effect hai lần) trước khi có id: job đã chạy thì huỷ cho khỏi tốn mạng.
        else void cancelBranchJob(id).catch(() => {});
      },
      (e: unknown) => alive && setScanError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [foldersKey, scans]);

  const scanFailed = scanError ?? (scanJob?.finished ? (scanJob.error ?? null) : null);
  const step = cleanId
    ? cleanJob?.finished
      ? "result"
      : "clean"
    : scanId && scanJob?.finished && !scanFailed
      ? "preview"
      : "scan";

  const cleanFinished = cleanJob?.finished === true;
  // Callback của cha là hàm mới mỗi lần render: giữ trong ref để báo đúng một lần cho mỗi job dọn, không lặp vô tận.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (cleanId && cleanFinished) changed.current();
  }, [cleanId, cleanFinished]);

  // Thứ tự theo danh sách thư mục truyền vào, không theo thứ tự repo xong (quét song song).
  const repos = folders.flatMap((f) => scanJob?.repos[f] ?? []);
  const checked = (c: Candidate) => overrides[itemKey(c)] ?? c.selected;
  const candidates = repos.flatMap((r) => r.candidates);
  const picked = candidates.filter(checked);
  const blockedTotal = repos.reduce((n, r) => n + r.blocked.length, 0);
  const worktrees = picked.filter((c) => c.worktree && !c.worktree.prunable).length;
  const prunable = picked.filter((c) => c.worktree?.prunable).length;

  function close() {
    if (step === "clean") return;
    if (step === "scan" && scanId && !scanJob?.finished) void cancelBranchJob(scanId).catch(() => {});
    onClose();
  }

  async function startClean() {
    setConfirming(false);
    setCleanError(null);
    setStarting(true);
    const items: CleanItem[] = picked.map((c) => ({
      folder: c.folder,
      branch: c.branch,
      tip: c.tip,
      worktree: c.worktree?.path,
      prunable: c.worktree?.prunable,
      evidence: c.evidence,
    }));
    const fetched = Object.fromEntries(repos.map((r) => [r.folder, r.fetched]));
    try {
      setCleanId(await cleanBranches(items, fetched));
    } catch (e) {
      // Rust từ chối job `clean` thứ hai ("Đang dọn nhánh.") bằng Err; ở lại bước xem trước để người dùng đọc lý do.
      setCleanError(errorText(e));
    } finally {
      setStarting(false);
    }
  }

  function cancelClean() {
    if (!cleanId) return;
    setCancelling(true);
    void cancelBranchJob(cleanId).catch(() => {});
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent
          showCloseButton={step !== "clean"}
          className="flex max-h-[calc(100%-2rem)] flex-col sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>{step === "result" ? t.resultTitle : t.title}</DialogTitle>
            <DialogDescription>{t.lead}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
            {step === "scan" && (
              <ScanProgress
                folders={folders}
                done={scanJob?.done ?? 0}
                total={scanJob?.total || folders.length}
                job={scanJob}
                failed={scanFailed}
              />
            )}
            {step === "preview" && (
              <>
                <p role="status" className="text-sm">
                  {t.summary(candidates.length, blockedTotal, repos.length)}
                </p>
                <SettingsEditor
                  open={editing}
                  onToggle={() => setEditing((v) => !v)}
                  onSaved={() => {
                    setEditing(false);
                    setScans((n) => n + 1);
                  }}
                />
                {cleanError && <Alert variant="destructive">{cleanError}</Alert>}
                {candidates.length === 0 && blockedTotal === 0 && repos.every((r) => !r.error) && (
                  <p className="text-sm text-muted-foreground">{t.nothing}</p>
                )}
                {repos.map((repo) => (
                  <RepoSection
                    key={repo.folder}
                    repo={repo}
                    checked={checked}
                    onToggle={(c) => setOverrides((o) => ({ ...o, [itemKey(c)]: !checked(c) }))}
                  />
                ))}
              </>
            )}
            {step === "clean" && (
              <>
                <p role="status" className="text-sm">
                  {cancelling ? t.cancelling : t.cleaning}
                </p>
                <ProgressBar
                  done={cleanJob?.done ?? 0}
                  total={cleanJob?.total || picked.length}
                  label={t.cleanProgress(cleanJob?.done ?? 0, cleanJob?.total || picked.length)}
                />
                <p className="text-xs text-muted-foreground">
                  {t.cleanProgress(cleanJob?.done ?? 0, cleanJob?.total || picked.length)}
                  {cleanJob?.progress?.branch ? (
                    <>
                      {" · "}
                      <Name>{cleanJob.progress.branch}</Name> {t.steps[cleanJob.progress.step]}
                    </>
                  ) : null}
                </p>
              </>
            )}
            {step === "result" && cleanJob && <CleanResults items={cleanJob.items} job={cleanJob} />}
          </div>

          <DialogActions>
            {step === "scan" && (
              <>
                <Button variant="outline" onClick={close}>
                  {scanFailed ? t.close : t.cancel}
                </Button>
                {scanFailed && <Button onClick={() => setScans((n) => n + 1)}>{t.retry}</Button>}
              </>
            )}
            {step === "preview" && (
              <>
                <Button variant="outline" onClick={close}>
                  {t.close}
                </Button>
                <Button variant="outline" disabled={starting} onClick={() => setScans((n) => n + 1)}>
                  {t.rescan}
                </Button>
                <Button disabled={picked.length === 0 || starting} onClick={() => setConfirming(true)}>
                  {t.clean(picked.length)}
                </Button>
              </>
            )}
            {step === "clean" && (
              <Button variant="outline" disabled={cancelling} onClick={cancelClean}>
                {t.cancelClean}
              </Button>
            )}
            {step === "result" && (
              <>
                <Button variant="outline" onClick={onClose}>
                  {t.close}
                </Button>
                <Button onClick={() => setScans((n) => n + 1)}>{t.rescan}</Button>
              </>
            )}
          </DialogActions>
        </DialogContent>
      </Dialog>

      <AlertDialog.Root open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <AlertDialog.Title className="font-heading text-base leading-none font-medium">
              {t.confirmTitle(picked.length)}
            </AlertDialog.Title>
            <AlertDialog.Description render={<div />} className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              <p className="text-foreground">{t.confirmBody(picked.length, worktrees)}</p>
              {prunable > 0 && <p>{t.confirmPrunable(prunable)}</p>}
              <p>{t.confirmKeep}</p>
              <p>{t.confirmRestore}</p>
            </AlertDialog.Description>
            <DialogActions>
              <AlertDialog.Close render={<Button variant="outline" />}>{t.cancel}</AlertDialog.Close>
              <Button variant="destructive-solid" onClick={() => void startClean()}>
                {t.confirmAction}
              </Button>
            </DialogActions>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

function ScanProgress({
  folders,
  done,
  total,
  job,
  failed,
}: {
  folders: string[];
  done: number;
  total: number;
  job: ReturnType<typeof useBranchJob>;
  failed: string | null;
}) {
  const t = useT(text);
  const progress = job?.progress;
  return (
    <>
      {failed ? (
        <Alert variant="destructive">
          {t.scanFailed}: {failed}
        </Alert>
      ) : (
        <>
          <p role="status" className="text-sm">
            {t.scanning}
          </p>
          <ProgressBar done={done} total={total} label={t.scanProgress(done, total)} />
          <p className="text-xs text-muted-foreground">{t.scanProgress(done, total)}</p>
        </>
      )}
      <ul className="divide-y rounded-lg border">
        {folders.map((folder) => {
          const repo = job?.repos[folder];
          const current = !repo && progress?.folder === folder && !failed;
          return (
            <li key={folder} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-2.5 py-1.5">
              <span translate="no" className="min-w-0 truncate font-mono text-xs" title={folder}>
                {shortPath(folder)}
              </span>
              <span className="text-xs text-muted-foreground">
                {repo
                  ? repo.error
                    ? repo.error.message
                    : t.repoDone(repo.candidates.length)
                  : current && progress
                    ? t.steps[progress.step]
                    : t.repoWaiting}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SettingsEditor({ open, onToggle, onSaved }: { open: boolean; onToggle: () => void; onSaved: () => void }) {
  const t = useT(text);
  const id = useId();
  const [settings, setSettings] = useState<BranchSettings | null>(null);
  const [patterns, setPatterns] = useState("");
  const [rebuildable, setRebuildable] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Đọc khi mở lần đầu: người chỉ muốn xem trước không phải trả giá một lần gọi sidecar.
  useEffect(() => {
    if (!open || settings) return;
    let alive = true;
    branchSettings().then(
      (s) => {
        if (!alive) return;
        setSettings(s);
        setPatterns(s.patterns.join("\n"));
        setRebuildable(s.rebuildable.join("\n"));
      },
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [open, settings]);

  const lines = (value: string) =>
    value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setBranchSettings({ patterns: lines(patterns), rebuildable: lines(rebuildable) });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
        className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        )}
        {t.settings}
      </button>
      {open && (
        <div id={`${id}-body`} className="flex flex-col gap-3 px-2.5 pb-2.5">
          <p className="text-xs text-muted-foreground">{t.settingsLead}</p>
          {error && <Alert variant="destructive">{error}</Alert>}
          {!settings && !error && <p className="text-sm text-muted-foreground">{t.settingsLoading}</p>}
          {settings && (
            <>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={`${id}-patterns`}>{t.patterns}</label>
                <Textarea
                  id={`${id}-patterns`}
                  name="patterns"
                  autoComplete="off"
                  className="font-mono text-sm"
                  rows={3}
                  spellCheck={false}
                  placeholder={t.patternsHint}
                  value={patterns}
                  onChange={(e) => setPatterns(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={`${id}-rebuildable`}>{t.rebuildable}</label>
                <Textarea
                  id={`${id}-rebuildable`}
                  name="rebuildable"
                  autoComplete="off"
                  className="font-mono text-sm"
                  rows={4}
                  spellCheck={false}
                  placeholder={t.rebuildableHint}
                  value={rebuildable}
                  onChange={(e) => setRebuildable(e.target.value)}
                />
              </div>
              <p translate="no" className="font-mono text-xs break-all text-muted-foreground">
                {t.settingsPath(settings.path)}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setPatterns(settings.defaults.patterns.join("\n"));
                    setRebuildable(settings.defaults.rebuildable.join("\n"));
                  }}
                >
                  {t.defaults}
                </Button>
                <Button size="sm" disabled={saving} onClick={() => void save()}>
                  {saving ? t.saving : t.saveRescan}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RepoSection({
  repo,
  checked,
  onToggle,
}: {
  repo: ScanRepo;
  checked: (c: Candidate) => boolean;
  onToggle: (c: Candidate) => void;
}) {
  const t = useT(text);
  const id = useId();
  const [showBlocked, setShowBlocked] = useState(false);
  const fetchFailed = repo.fetchFailed.length > 0;
  const authFailed = repo.fetchFailed.some((f) => f.auth);
  const selectedCount = repo.candidates.filter(checked).length;
  // Q13: nhánh thư mục chính đang đứng khớp mẫu và đã merge: sidecar gợi ý nhánh mặc định để người dùng tự về.
  const suggest = repo.suggestDefault;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3
          id={`${id}-title`}
          translate="no"
          className="min-w-0 truncate font-mono text-sm font-semibold"
          title={repo.folder}
        >
          {shortPath(repo.folder)}
        </h3>
        {repo.candidates.length > 0 && (
          <span className="text-xs text-muted-foreground">{t.selected(selectedCount, repo.candidates.length)}</span>
        )}
      </div>
      {repo.error && <Alert variant="destructive">{t.repoError(repo.error.message)}</Alert>}
      {fetchFailed && (
        <Alert>
          {authFailed ? t.fetchFailedAuth : t.fetchFailed}
          <span translate="no" className="mt-1 block font-mono text-xs break-all">
            {repo.fetchFailed.map((f) => f.remote).join(", ")}
          </span>
        </Alert>
      )}
      {repo.apiError && <Alert>{t.apiError(repo.apiError)}</Alert>}
      {suggest && (
        <p className="text-xs text-muted-foreground">
          {t.suggestDefault(<Name>{repo.current ?? ""}</Name>, <Name>{suggest.branch}</Name>)}
          {!suggest.clean && ` ${t.suggestDirty}`}
        </p>
      )}
      {!repo.error && repo.candidates.length === 0 && repo.blocked.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.repoNothing}</p>
      )}
      {repo.candidates.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {repo.candidates.map((c) => (
            <CandidateRow key={itemKey(c)} candidate={c} checked={checked(c)} onToggle={() => onToggle(c)} />
          ))}
        </ul>
      )}
      {repo.blocked.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={showBlocked}
            aria-controls={`${id}-blocked`}
            onClick={() => setShowBlocked((v) => !v)}
            className="flex w-fit cursor-pointer items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {showBlocked ? (
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRightIcon aria-hidden="true" className="size-4" />
            )}
            {t.blockedGroup(repo.blocked.length)}
          </button>
          {showBlocked && (
            <ul id={`${id}-blocked`} className="divide-y rounded-lg border">
              {repo.blocked.map((c) => (
                <BlockedRow key={itemKey(c)} candidate={c} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function useWhen(committedAt: number) {
  const lang = useLang();
  return new Date(committedAt * 1000).toLocaleDateString(locale(lang));
}

function CandidateRow({
  candidate: c,
  checked,
  onToggle,
}: {
  candidate: Candidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT(text);
  const when = useWhen(c.committedAt);
  const w = c.worktree;
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 px-2.5 py-2">
        <input
          type="checkbox"
          aria-label={t.checkLabel(c.branch)}
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
          checked={checked}
          onChange={onToggle}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span translate="no" className="min-w-0 truncate font-mono text-sm font-medium" title={c.branch}>
            {c.branch}
          </span>
          <span className="text-xs">
            {t.evidence(c.evidence)}
            <span className="text-muted-foreground"> · {t.committed(when)}</span>
          </span>
          {w && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {t.worktree}
              <span translate="no" className="min-w-0 font-mono break-all" title={w.path}>
                {shortPath(w.path)}
              </span>
              {w.agentWorktree && <Pill>{t.agentWorktree}</Pill>}
            </span>
          )}
          {w?.prunable && <span className="text-xs text-warning">{t.prunableNote}</span>}
          {w?.ignored && w.ignored.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {t.ignoredLose("")}
              <span translate="no" className="font-mono break-all">
                {w.ignored.join(", ")}
              </span>
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

function BlockedRow({ candidate: c }: { candidate: Candidate }) {
  const t = useT(text);
  const when = useWhen(c.committedAt);
  const b = c.blocked;
  const reason = b ? t.blockReason[b.code](b) : "";
  // Chặn vì thiếu bằng chứng thì lý do chi tiết nằm ở `evidence.note`.
  const note = c.evidence.kind === "none" && c.evidence.note ? t.noEvidence[c.evidence.note] : undefined;
  return (
    <li className="flex flex-col gap-1 px-2.5 py-2">
      <span translate="no" className="min-w-0 truncate font-mono text-sm font-medium" title={c.branch}>
        {c.branch}
      </span>
      <span className="text-xs">
        {reason}
        {note && b?.code === "noEvidence" ? ` ${note}` : ""}
        <span className="text-muted-foreground"> · {t.committed(when)}</span>
      </span>
      {c.worktree && (
        <span translate="no" className="font-mono text-xs break-all text-muted-foreground" title={c.worktree.path}>
          {shortPath(c.worktree.path)}
        </span>
      )}
      {b?.busy && b.busy.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {b.busy.map((d) => (
            <li key={`${d.kind}:${d.path}`} className="break-words">
              {d.label ?? t.busyKind[d.kind]}
              <span translate="no" className="font-mono">
                {" "}
                {shortPath(d.path)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {b?.files && b.files.length > 0 && <FileList files={b.files} total={b.filesTotal} />}
    </li>
  );
}

function CleanResults({ items, job }: { items: CleanResult[]; job: NonNullable<ReturnType<typeof useBranchJob>> }) {
  const t = useT(text);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const removed = items.filter((i) => i.result === "removed");
  const skipped = items.filter((i) => i.result === "skipped" || i.result === "cancelled").length;
  const failed = items.filter((i) => i.result === "partial" || i.result === "error").length;
  const windows = isWindows();
  // Nhánh đã xoá (kể cả `partial` thì nhánh được giữ nên không cần lệnh); lệnh nằm ở giao diện vì kết quả sidecar không có.
  const command = (i: CleanResult) => restoreCommand(i.branch, i.tip, windows);

  // Clipboard có thể bị chặn (khung chưa focus); người dùng bấm lại được.
  function copy(key: string, value: string) {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(key))
      .catch(() => {});
  }

  return (
    <>
      <p role="status" className="text-sm">
        {t.resultSummary(removed.length, skipped, failed)}
      </p>
      {job.error && <Alert variant="destructive">{job.error}</Alert>}
      {removed.length > 1 && (
        <div>
          <Button size="sm" variant="outline" onClick={() => copy("all", removed.map(command).join("\n"))}>
            {copied === "all" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied === "all" ? t.copied : t.copyAll}
          </Button>
        </div>
      )}
      <ul className="divide-y rounded-lg border">
        {items.map((i) => (
          <ResultRow
            key={itemKey(i)}
            item={i}
            command={i.result === "removed" ? command(i) : undefined}
            copied={copied === itemKey(i)}
            onCopy={() => copy(itemKey(i), command(i))}
          />
        ))}
      </ul>
      {job.result?.log && (
        <p translate="no" className="font-mono text-xs break-all text-muted-foreground">
          {t.logAt(job.result.log)}
        </p>
      )}
    </>
  );
}

function ResultRow({
  item: i,
  command,
  copied,
  onCopy,
}: {
  item: CleanResult;
  command: string | undefined;
  copied: boolean;
  onCopy: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const known = i.code ? t.codeReason[i.code] : undefined;
  // Câu của sidecar là tiếng Việt: bản tiếng Anh ưu tiên bảng dịch theo mã.
  const reason = lang === "vi" ? (i.reason ?? known) : (known ?? i.reason);
  return (
    <li className="flex flex-col gap-1 px-2.5 py-2">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span translate="no" className="min-w-0 truncate font-mono text-sm font-medium" title={i.branch}>
          {i.branch}
        </span>
        <Pill tone={OUTCOME_TONE[i.result]}>{t.outcomes[i.result]}</Pill>
      </span>
      <span translate="no" className="font-mono text-xs break-all text-muted-foreground" title={i.folder}>
        {shortPath(i.folder)}
      </span>
      {reason && <span className="text-xs">{reason}</span>}
      {i.result === "partial" && i.left && <span className="text-xs text-warning">{t.left(shortPath(i.left))}</span>}
      {command && (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="sr-only">{t.restore}</span>
          <code translate="no" className="min-w-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
            {command}
          </code>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${t.copyRestore}: ${i.branch}`}
            title={copied ? t.copied : t.copyRestore}
            onClick={onCopy}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </Button>
        </span>
      )}
    </li>
  );
}
