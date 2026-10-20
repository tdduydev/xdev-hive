import { Menu } from "@base-ui/react/menu";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import {
  ArrowDownToLineIcon,
  BrushCleaningIcon,
  EllipsisIcon,
  GitBranchIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { BranchCreateDialog } from "@/components/branch-create-dialog.tsx";
import { BranchSwitchDialog } from "@/components/branch-switch-dialog.tsx";
import { CleanupDialog } from "@/components/cleanup-dialog.tsx";
import {
  type GitAction,
  GitActionDialog,
  type GitActionResult,
  GitOperationPanel,
  isResumable,
  ResetCommand,
} from "@/components/git-operation-panel.tsx";
import { shortPath } from "@/lib/folder.ts";
import {
  type BranchInfo,
  type BranchStatus,
  type CreateResult,
  fetchRemotes,
  type GitOperation,
  lastFetchedAt,
  listBranches,
  type RepoBranches,
  type SwitchResult,
  useBranchJob,
  type WorktreeInfo,
  withWorktreeEvents,
} from "@/lib/git-branches.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { openProjectTerminal } from "@/lib/pty.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

type Tab = "local" | "remote" | "worktree";

const text: Dict<{
  branch: string;
  branchLabel: (name: string) => string;
  detached: string;
  clean: string;
  dirty: string;
  untracked: string;
  operation: string;
  title: (name: string) => string;
  lead: string;
  loading: string;
  filter: string;
  filterHint: string;
  fetch: string;
  fetching: string;
  fetchedAt: (when: string) => string;
  neverFetched: string;
  fetchFailed: (failures: string) => string;
  fetchPartial: (ok: string, failures: string) => string;
  reload: string;
  tabs: string;
  tabNames: Record<Tab, string>;
  empty: Record<Tab, string>;
  noMatch: string;
  more: (n: number) => string;
  current: string;
  goneUpstream: string;
  unpushed: (n: number) => string;
  upstreamOf: (name: string) => string;
  noUpstream: string;
  againstDefault: (name: string, ahead: number, behind: number) => string;
  inWorktree: (path: string) => string;
  committed: (when: string) => string;
  slowPath: string;
  menu: (name: string) => string;
  switchTo: string;
  createBranch: string;
  cleanupRepo: string;
  switched: (name: ReactNode) => ReactNode;
  created: (name: ReactNode, switched: boolean) => ReactNode;
  offDefault: (current: ReactNode, main: ReactNode) => ReactNode;
  backToDefault: string;
  backToDefaultBlocked: string;
  copyName: string;
  copyPath: string;
  openTerminal: string;
  main: string;
  headOnly: (sha: string) => string;
  locked: string;
  lockedWhy: (reason: string) => string;
  prunable: string;
  worktreeStates: Record<WorktreeInfo["state"], string>;
  busy: Record<NonNullable<WorktreeInfo["busy"]>, string>;
  ops: Record<NonNullable<BranchStatus["operation"]>, string>;
  moreFiles: (n: number) => string;
  pull: string;
  pulling: string;
  pullWhy: (reason: string) => string;
  needBranch: string;
  opRunning: string;
  pullNoUpstream: string;
  pullGone: string;
  mergeInto: string;
  rebaseOnto: string;
  updateFrom: (name: ReactNode) => ReactNode;
  pulled: (branch: ReactNode, n: number | undefined) => ReactNode;
  pullUnchanged: (branch: ReactNode) => ReactNode;
  merged: (onto: ReactNode, into: ReactNode) => ReactNode;
  rebased: (branch: ReactNode, onto: ReactNode) => ReactNode;
  aborted: (kind: "merge" | "rebase") => ReactNode;
}> = {
  vi: {
    branch: "Nhánh",
    branchLabel: (name) => `Xem nhánh của ${name}`,
    detached: "HEAD rời",
    clean: "Sạch",
    dirty: "Có thay đổi",
    untracked: "Có file chưa theo dõi",
    operation: "Đang dở",
    title: (name) => `Nhánh của ${name}`,
    lead: "Đọc từ ref đã có trên máy, không gọi mạng. Bấm Fetch để cập nhật từ remote.",
    loading: "Đang đọc nhánh…",
    filter: "Lọc theo tên",
    filterHint: "Lọc theo tên nhánh hay thư mục…",
    fetch: "Fetch",
    fetching: "Đang fetch…",
    fetchedAt: (when) => `Fetch lúc ${when}`,
    neverFetched: "Chưa fetch",
    fetchFailed: (failures) => `Fetch không được: ${failures}`,
    fetchPartial: (ok, failures) => `Đã fetch ${ok}, nhưng lỗi ở: ${failures}`,
    reload: "Đọc lại",
    tabs: "Loại nhánh",
    tabNames: { local: "Local", remote: "Remote", worktree: "Worktree" },
    empty: {
      local: "Repo chưa có nhánh local nào.",
      remote: "Không có nhánh remote nào chưa có bản local.",
      worktree: "Repo không có worktree nào.",
    },
    noMatch: "Không có mục nào khớp.",
    more: (n) => `Hiện thêm ${n} mục`,
    current: "Đang đứng",
    goneUpstream: "Remote đã xoá",
    unpushed: (n) => `Chưa đẩy ${n} commit`,
    upstreamOf: (name) => `theo dõi ${name}`,
    noUpstream: "không theo dõi remote",
    againstDefault: (name, ahead, behind) => `so với ${name}: ↑${ahead} ↓${behind}`,
    inWorktree: (path) => `worktree ${path}`,
    committed: (when) => `commit ${when}`,
    slowPath: "Git trên máy cũ hơn 2.41 nên số commit trước/sau nhánh mặc định chỉ có ở nhánh khớp mẫu dọn.",
    menu: (name) => `Thao tác với ${name}`,
    switchTo: "Đổi sang nhánh này",
    createBranch: "Tạo nhánh",
    cleanupRepo: "Dọn nhánh repo này",
    switched: (name) => <>Đã đổi sang {name}.</>,
    created: (name, switched) => (switched ? <>Đã tạo và đổi sang {name}.</> : <>Đã tạo nhánh {name}.</>),
    offDefault: (current, main) => (
      <>
        Thư mục chính đang ở {current}, không phải nhánh mặc định {main}.
      </>
    ),
    backToDefault: "Về nhánh mặc định",
    backToDefaultBlocked: "Thư mục đang có thay đổi hay đang dở thao tác, hãy xử lý trước.",
    copyName: "Sao chép tên",
    copyPath: "Sao chép đường dẫn",
    openTerminal: "Mở terminal ở worktree",
    main: "Thư mục chính",
    headOnly: (sha) => `HEAD rời ở ${sha}`,
    locked: "Bị khoá",
    lockedWhy: (reason) => `Bị khoá: ${reason}`,
    prunable: "Có thể dọn",
    worktreeStates: {
      pending: "Đang đọc…",
      skipped: "Của worker, không đọc",
      clean: "Sạch",
      dirty: "Có thay đổi",
      untracked: "Có file chưa theo dõi",
      missing: "Thư mục đã mất",
      unreachable: "Không truy cập được",
      error: "Lỗi khi đọc",
    },
    busy: {
      hiveWorker: "Worker đang dùng",
      agent: "Đang có agent",
      terminal: "Đang có terminal",
      app: "App đang dùng",
    },
    ops: {
      merge: "Đang merge dở",
      rebase: "Đang rebase dở",
      cherryPick: "Đang cherry-pick dở",
      revert: "Đang revert dở",
      bisect: "Đang bisect",
    },
    moreFiles: (n) => `và ${n} file nữa`,
    pull: "Pull",
    pulling: "Đang pull…",
    pullWhy: (reason) => `Pull không chạy được: ${reason}`,
    needBranch: "Cần đứng trên một nhánh",
    opRunning: "Repo đang dở một thao tác, hoàn tất hay huỷ nó trước",
    pullNoUpstream: "Nhánh này chưa theo dõi nhánh remote nào",
    pullGone: "Nhánh remote của nhánh này đã bị xoá",
    mergeInto: "Merge vào nhánh đang đứng",
    rebaseOnto: "Rebase nhánh đang đứng lên nhánh này",
    updateFrom: (name) => <>Cập nhật từ {name}</>,
    pulled: (branch, n) =>
      n ? (
        <>
          Đã pull {n} commit vào {branch}.
        </>
      ) : (
        <>Đã pull vào {branch}.</>
      ),
    pullUnchanged: (branch) => <>{branch} đã mới nhất, không có commit mới để pull.</>,
    merged: (onto, into) => (
      <>
        Đã merge {onto} vào {into}.
      </>
    ),
    rebased: (branch, onto) => (
      <>
        Đã rebase {branch} lên {onto}.
      </>
    ),
    aborted: (kind) => `Đã huỷ ${kind}, thư mục về như trước khi bắt đầu.`,
  },
  en: {
    branch: "Branches",
    branchLabel: (name) => `View branches of ${name}`,
    detached: "Detached HEAD",
    clean: "Clean",
    dirty: "Has changes",
    untracked: "Has untracked files",
    operation: "In progress",
    title: (name) => `Branches of ${name}`,
    lead: "Read from the refs already on this machine, no network. Press Fetch to update from the remotes.",
    loading: "Reading branches…",
    filter: "Filter by name",
    filterHint: "Filter by branch name or folder…",
    fetch: "Fetch",
    fetching: "Fetching…",
    fetchedAt: (when) => `Fetched at ${when}`,
    neverFetched: "Not fetched yet",
    fetchFailed: (failures) => `Fetch failed: ${failures}`,
    fetchPartial: (ok, failures) => `Fetched ${ok}, but failed on: ${failures}`,
    reload: "Reload",
    tabs: "Branch kind",
    tabNames: { local: "Local", remote: "Remote", worktree: "Worktrees" },
    empty: {
      local: "The repository has no local branch.",
      remote: "No remote branch is missing a local copy.",
      worktree: "The repository has no worktree.",
    },
    noMatch: "Nothing matches.",
    more: (n) => `Show ${n} more`,
    current: "Checked out",
    goneUpstream: "Remote deleted",
    unpushed: (n) => `${n} unpushed ${n === 1 ? "commit" : "commits"}`,
    upstreamOf: (name) => `tracks ${name}`,
    noUpstream: "not tracking a remote",
    againstDefault: (name, ahead, behind) => `vs ${name}: ↑${ahead} ↓${behind}`,
    inWorktree: (path) => `worktree ${path}`,
    committed: (when) => `committed ${when}`,
    slowPath:
      "Git on this machine is older than 2.41, so ahead/behind the default branch is only known for branches matching the cleanup pattern.",
    menu: (name) => `Actions for ${name}`,
    switchTo: "Switch to this branch",
    createBranch: "Create branch",
    cleanupRepo: "Clean up this repo",
    switched: (name) => <>Switched to {name}.</>,
    created: (name, switched) => (switched ? <>Created and switched to {name}.</> : <>Created branch {name}.</>),
    offDefault: (current, main) => (
      <>
        The main folder is on {current}, not the default branch {main}.
      </>
    ),
    backToDefault: "Back to the default branch",
    backToDefaultBlocked: "The folder has changes or an unfinished operation, deal with that first.",
    copyName: "Copy name",
    copyPath: "Copy path",
    openTerminal: "Open terminal in worktree",
    main: "Main folder",
    headOnly: (sha) => `Detached HEAD at ${sha}`,
    locked: "Locked",
    lockedWhy: (reason) => `Locked: ${reason}`,
    prunable: "Prunable",
    worktreeStates: {
      pending: "Reading…",
      skipped: "Worker's, not read",
      clean: "Clean",
      dirty: "Has changes",
      untracked: "Has untracked files",
      missing: "Folder is gone",
      unreachable: "Unreachable",
      error: "Read failed",
    },
    busy: {
      hiveWorker: "Used by the worker",
      agent: "Agent running",
      terminal: "Terminal open",
      app: "Used by the app",
    },
    ops: {
      merge: "Merge in progress",
      rebase: "Rebase in progress",
      cherryPick: "Cherry-pick in progress",
      revert: "Revert in progress",
      bisect: "Bisect in progress",
    },
    moreFiles: (n) => `and ${n} more`,
    pull: "Pull",
    pulling: "Pulling…",
    pullWhy: (reason) => `Pull cannot run: ${reason}`,
    needBranch: "Check out a branch first",
    opRunning: "The repository has an unfinished operation, finish or abort it first",
    pullNoUpstream: "This branch does not track a remote branch",
    pullGone: "The remote branch of this branch was deleted",
    mergeInto: "Merge into the checked-out branch",
    rebaseOnto: "Rebase the checked-out branch onto this one",
    updateFrom: (name) => <>Update from {name}</>,
    pulled: (branch, n) =>
      n ? (
        <>
          Pulled {n} {n === 1 ? "commit" : "commits"} into {branch}.
        </>
      ) : (
        <>Pulled into {branch}.</>
      ),
    pullUnchanged: (branch) => <>{branch} is up to date, no new commits to pull.</>,
    merged: (onto, into) => (
      <>
        Merged {onto} into {into}.
      </>
    ),
    rebased: (branch, onto) => (
      <>
        Rebased {branch} onto {onto}.
      </>
    ),
    aborted: (kind) => `Aborted the ${kind}, the folder is back as it was before it started.`,
  },
};

const WORKTREE_TONE: Record<WorktreeInfo["state"], "neutral" | "ok" | "warn" | "bad"> = {
  pending: "neutral",
  skipped: "neutral",
  clean: "ok",
  dirty: "warn",
  untracked: "neutral",
  missing: "bad",
  unreachable: "bad",
  error: "bad",
};

// Đủ cho vài trăm nhánh mà không vẽ cả nghìn dòng của repo lớn.
const PAGE = 100;
const MENU_ITEM =
  "flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

const locale = (lang: Lang) => (lang === "vi" ? "vi-VN" : "en-GB");

/** FR-003: nhánh đang đứng ở đầu, còn lại mới commit trước. */
export function sortBranches(list: BranchInfo[]): BranchInfo[] {
  return [...list].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.committedAt - a.committedAt);
}

const matches = (query: string, ...fields: (string | undefined)[]) => {
  const q = query.trim().toLowerCase();
  return q === "" || fields.some((f) => f?.toLowerCase().includes(q));
};

/** `↑N ↓M` so với upstream; trống khi hai số đều 0 hay chưa biết. */
function AheadBehind({ ahead, behind }: { ahead: number | undefined; behind: number | undefined }) {
  if (!ahead && !behind) return null;
  return (
    <span className="font-mono text-xs whitespace-nowrap">
      <span className="text-success">↑{ahead ?? 0}</span> <span className="text-warning">↓{behind ?? 0}</span>
    </span>
  );
}

/**
 * Nhánh đang đứng, chấm sạch/có thay đổi và `↑N ↓M` của một repo trên màn Dự án (FR-001), kèm nút mở BranchesSheet.
 * Repo lỗi (thư mục mất, không phải repo git) hiện lỗi và không có nút Nhánh.
 */
export function RepoBranchStatus({ status, name, onOpen }: { status: BranchStatus; name: string; onOpen: () => void }) {
  const t = useT(text);
  if (status.error) return <span className="truncate text-xs text-destructive">{status.error.message}</span>;
  const state = status.dirty ? t.dirty : status.untracked ? t.untracked : t.clean;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span translate="no" className="min-w-0 truncate font-mono text-xs">
        {status.branch ?? t.detached}
      </span>
      <span
        role="img"
        aria-label={state}
        title={state}
        className={cn("size-2 shrink-0 rounded-full", status.dirty ? "bg-warning" : "bg-success")}
      />
      <AheadBehind ahead={status.ahead} behind={status.behind} />
      {status.operation && <Pill tone="warn">{t.ops[status.operation]}</Pill>}
      <Button size="xs" variant="outline" aria-label={t.branchLabel(name)} onClick={onOpen}>
        {t.branch}
      </Button>
    </span>
  );
}

/**
 * Bảng nhánh của một repo (Sheet bên phải, toàn màn khi hẹp): Local, Remote, Worktree, ô lọc, Fetch. Dùng Dialog làm
 * khung để có sẵn bẫy focus và Esc; worktree điền dần theo sự kiện của `list`.
 */
export function BranchesSheet({
  folder,
  name,
  onClose,
  onChanged,
}: {
  folder: string;
  name: string;
  onClose: () => void;
  /** Sau khi fetch, đổi hay tạo nhánh xong, để màn Dự án đọc lại trạng thái gọn. */
  onChanged: () => void;
}) {
  const t = useT(text);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-0 right-0 left-auto flex h-full max-w-full translate-x-0 translate-y-0 flex-col gap-3 rounded-none sm:max-w-160 sm:rounded-l-xl motion-reduce:animate-none data-open:slide-in-from-right-8 data-open:zoom-in-100 data-closed:slide-out-to-right-8 data-closed:zoom-out-100">
        <DialogHeader className="pr-8">
          <DialogTitle>{t.title(name)}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{shortPath(folder)}</DialogDescription>
        </DialogHeader>
        <BranchesBody
          folder={folder}
          onChanged={onChanged}
          onTerminal={(path) => {
            openProjectTerminal(path);
            location.hash = "#/terminal";
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function BranchesBody({
  folder,
  onChanged,
  onTerminal,
}: {
  folder: string;
  onChanged: () => void;
  onTerminal: (path: string) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const tabsId = useId();
  const pullWhyId = useId();
  const [repo, setRepo] = useState<(RepoBranches & { jobId: string }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [tab, setTab] = useState<Tab>("local");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [fetchId, setFetchId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<BranchInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [gitAction, setGitAction] = useState<GitAction | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const fetchJob = useBranchJob(fetchId);
  const listJob = useBranchJob(repo?.jobId ?? null);
  const fetching = fetchId !== null && !fetchJob?.finished;
  const fetchDone = fetchId !== null && fetchJob?.finished === true;

  // Không xoá `repo` khi đọc lại: bảng cũ còn đó trong lúc bảng mới đến, đỡ nháy.
  useEffect(() => {
    let alive = true;
    // `reloads` không dùng trong thân hàm: đổi số này là cách bắt đọc lại.
    void reloads;
    setLoadError(null);
    listBranches(folder).then(
      (r) => alive && setRepo(r),
      (e: unknown) => alive && setLoadError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [folder, reloads]);

  // Fetch xong (kể cả lỗi một phần) thì ref đã đổi: đọc lại bảng và báo màn Dự án.
  useEffect(() => {
    if (!fetchId || !fetchDone) return;
    setReloads((n) => n + 1);
    onChanged();
  }, [fetchId, fetchDone, onChanged]);

  async function startFetch() {
    setFetchError(null);
    try {
      setFetchId(await fetchRemotes(folder));
    } catch (e) {
      setFetchError(errorText(e));
    }
  }

  // Đổi hay tạo nhánh xong: ref và nhánh đang đứng đã đổi, đọc lại bảng và báo màn Dự án.
  function changed(message: ReactNode) {
    setSwitching(null);
    setCreating(false);
    setGitAction(null);
    setNotice(message);
    setReloads((n) => n + 1);
    onChanged();
  }

  // Pull, merge, rebase xong: pull và merge/rebase sạch báo kết quả kèm lệnh quay về (FR-056); dừng vì xung đột thì khung
  // thao tác dở hiện ra sau khi đọc lại, không cần câu báo.
  function gitDone(r: GitActionResult) {
    if (r.kind === "pull") {
      const name = <Name>{r.branch}</Name>;
      changed(
        r.pull.state === "unchanged" ? (
          t.pullUnchanged(name)
        ) : (
          <>
            {t.pulled(name, r.pull.behind)}
            {r.pull.headBefore && <UndoLine headBefore={r.pull.headBefore} />}
          </>
        ),
      );
    } else changed(r.operation.state === "done" ? operationNotice(r.operation) : null);
  }

  function operationNotice(op: GitOperation): ReactNode {
    if (op.state === "aborted") return t.aborted(op.kind === "rebase" ? "rebase" : "merge");
    const onto = <Name>{op.onto?.name ?? ""}</Name>;
    const branch = <Name>{op.branch ?? ""}</Name>;
    return (
      <>
        {op.kind === "rebase" ? t.rebased(branch, onto) : t.merged(onto, branch)}
        {op.headBefore && <UndoLine headBefore={op.headBefore} />}
      </>
    );
  }

  const view = repo ? withWorktreeEvents(repo, listJob) : null;
  const locals = sortBranches(view?.branches.filter((b) => b.kind === "local") ?? []);
  const remotes = sortBranches(view?.branches.filter((b) => b.kind === "remote") ?? []);
  const worktrees = view?.worktrees ?? [];
  // Q13: thư mục chính đứng ở nhánh khác nhánh mặc định thì gợi ý về lại; chỉ bấm được khi thư mục sạch.
  const defaultTarget =
    view?.defaultBranch && view.current.branch !== view.defaultBranch
      ? (locals.find((b) => b.isDefault) ??
        remotes.find((b) => b.isDefault || b.name.endsWith(`/${view.defaultBranch}`)))
      : undefined;
  // Merge, rebase, pull cần đứng trên một nhánh và repo không đang dở thao tác; thư mục có thay đổi hay đang có chương
  // trình dùng thì sidecar từ chối kèm danh sách, hộp thoại hỏi tiếp.
  const gitBlock = view?.current.detached
    ? t.needBranch
    : view?.current.operation || view?.operation
      ? t.opRunning
      : undefined;
  const pullBlock = !view
    ? undefined
    : (gitBlock ?? (view.current.upstreamGone ? t.pullGone : view.current.upstream ? undefined : t.pullNoUpstream));
  const currentName = view?.current.branch;
  const operation = isResumable(view?.operation) ? view.operation : undefined;
  const counts: Record<Tab, number> = { local: locals.length, remote: remotes.length, worktree: worktrees.length };

  const branchRows = (tab === "remote" ? remotes : locals).filter((b) => matches(query, b.name, b.subject));
  const worktreeRows = worktrees.filter((w) => matches(query, w.path, w.branch));
  const total = tab === "worktree" ? worktreeRows.length : branchRows.length;

  const fetchedAt = lastFetchedAt(folder);
  const when = fetchedAt
    ? new Date(fetchedAt).toLocaleString(locale(lang), { dateStyle: "short", timeStyle: "short" })
    : null;

  const failures = fetchJob?.result?.fetchFailed ?? [];
  const succeeded = fetchJob?.result?.fetched ?? [];
  const failureText = failures.map((f) => `${f.remote} (${f.message})`).join("; ");
  const fetchProblem =
    fetchError ??
    (fetchJob?.error
      ? fetchJob.error
      : failures.length > 0
        ? succeeded.length > 0
          ? t.fetchPartial(succeeded.join(", "), failureText)
          : t.fetchFailed(failureText)
        : null);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-7.5 min-w-40 flex-1 text-sm"
          placeholder={t.filterHint}
          aria-label={t.filter}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(PAGE);
          }}
        />
        <Button size="sm" variant="outline" disabled={fetching || !repo} onClick={() => void startFetch()}>
          <RefreshCwIcon aria-hidden="true" className={cn(fetching && "animate-spin")} />
          {fetching ? t.fetching : t.fetch}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!view || !!pullBlock || !currentName}
          aria-describedby={pullBlock ? pullWhyId : undefined}
          onClick={() => currentName && setGitAction({ kind: "pull", branch: currentName })}
        >
          <ArrowDownToLineIcon aria-hidden="true" />
          {t.pull}
        </Button>
        <Button size="sm" variant="outline" disabled={!view} onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden="true" />
          {t.createBranch}
        </Button>
        <Button size="sm" variant="outline" disabled={!view} onClick={() => setCleaning(true)}>
          <BrushCleaningIcon aria-hidden="true" />
          {t.cleanupRepo}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReloads((n) => n + 1)}>
          {t.reload}
        </Button>
        <span aria-live="polite" className="w-full text-xs text-muted-foreground">
          {when ? t.fetchedAt(when) : t.neverFetched}
        </span>
        {pullBlock && (
          <span id={pullWhyId} className="w-full text-xs text-muted-foreground">
            {t.pullWhy(pullBlock)}
          </span>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {fetchProblem && <Alert variant="destructive">{fetchProblem}</Alert>}
      {loadError && <Alert variant="destructive">{loadError}</Alert>}
      {view?.slowPath && <p className="text-xs text-muted-foreground">{t.slowPath}</p>}
      {operation && (
        <GitOperationPanel
          folder={folder}
          operation={operation}
          onFinished={(op) => changed(operationNotice(op))}
          onTerminal={onTerminal}
        />
      )}
      {view && defaultTarget && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-2.5 py-2 text-sm">
          <span className="min-w-0 flex-1 break-words">
            {t.offDefault(<Name>{view.current.branch ?? t.detached}</Name>, <Name>{view.defaultBranch}</Name>)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={view.current.dirty || !!view.current.operation || !!view.operation}
            title={view.current.dirty || view.current.operation || view.operation ? t.backToDefaultBlocked : undefined}
            onClick={() => setSwitching(defaultTarget)}
          >
            {t.backToDefault}
          </Button>
        </div>
      )}

      <div role="tablist" aria-label={t.tabs} className="flex gap-3.5 border-b">
        {(["local", "remote", "worktree"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${tabsId}-${id}`}
            aria-selected={tab === id}
            aria-controls={`${tabsId}-panel`}
            onClick={() => {
              setTab(id);
              setShown(PAGE);
            }}
            className={cn(
              "-mb-px h-8.5 cursor-pointer border-b-2 text-sm",
              tab === id
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.tabNames[id]} <span className="font-mono text-xs">{view ? counts[id] : ""}</span>
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {!view ? (
          loadError ? null : (
            <p className="py-3 text-sm text-muted-foreground">{t.loading}</p>
          )
        ) : counts[tab] === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{t.empty[tab]}</p>
        ) : total === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{t.noMatch}</p>
        ) : (
          <ul className="divide-y">
            {tab === "worktree"
              ? worktreeRows
                  .slice(0, shown)
                  .map((w) => <WorktreeRow key={w.path} worktree={w} onTerminal={() => onTerminal(w.path)} />)
              : branchRows.slice(0, shown).map((b) => (
                  <BranchRow
                    key={b.ref}
                    branch={b}
                    defaultBranch={view.defaultBranch}
                    lang={lang}
                    gitBlock={gitBlock}
                    onSwitch={setSwitching}
                    onTerminal={onTerminal}
                    onMerge={(onto) =>
                      currentName &&
                      setGitAction({ kind: "merge", onto: { name: onto.name, tip: onto.tip }, into: currentName })
                    }
                    onRebase={(onto) =>
                      currentName &&
                      setGitAction({ kind: "rebase", onto: { name: onto.name, tip: onto.tip }, branch: currentName })
                    }
                    onUpdate={
                      b.isCurrent && defaultTarget && currentName
                        ? () =>
                            setGitAction({
                              kind: "merge",
                              onto: { name: defaultTarget.name, tip: defaultTarget.tip },
                              into: currentName,
                            })
                        : undefined
                    }
                    updateFrom={defaultTarget?.name}
                  />
                ))}
          </ul>
        )}
        {total > shown && (
          <div className="py-3">
            <Button size="sm" variant="outline" onClick={() => setShown((n) => n + PAGE)}>
              {t.more(total - shown)}
            </Button>
          </div>
        )}
      </div>

      {switching && (
        <BranchSwitchDialog
          folder={folder}
          branch={switching}
          onClose={() => setSwitching(null)}
          onOpenTerminal={onTerminal}
          onSwitched={(r: SwitchResult) => changed(t.switched(<Name>{r.branch}</Name>))}
        />
      )}
      {gitAction && (
        <GitActionDialog folder={folder} action={gitAction} onClose={() => setGitAction(null)} onDone={gitDone} />
      )}
      {creating && repo && (
        <BranchCreateDialog
          folder={folder}
          repo={repo}
          onClose={() => setCreating(false)}
          onCreated={(r: CreateResult) => changed(t.created(<Name>{r.name}</Name>, r.switched))}
        />
      )}
      {cleaning && (
        <CleanupDialog
          folders={[folder]}
          onClose={() => {
            setCleaning(false);
            // Dọn xong (hay quét có fetch) làm ref đổi: đọc lại bảng dù người dùng đóng hộp thoại ngay.
            setReloads((n) => n + 1);
          }}
          onChanged={() => {
            setReloads((n) => n + 1);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** Dòng quay về sau khi pull, merge hay rebase xong (FR-056). */
function UndoLine({ headBefore }: { headBefore: string }) {
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      <ResetCommand headBefore={headBefore} />
    </span>
  );
}

/** Mục menu bị khoá vẫn nói lý do ngay dưới tên, vì `title` không tới được người dùng bàn phím. */
function ItemText({ label, reason }: { label: ReactNode; reason: string | undefined }) {
  if (!reason) return <>{label}</>;
  return (
    <span className="flex flex-col">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{reason}</span>
    </span>
  );
}

/** Tên nhánh trong câu: mono, không dịch. */
function Name({ children }: { children: ReactNode }) {
  return (
    <span translate="no" className="font-mono font-medium">
      {children}
    </span>
  );
}

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="icon-sm" variant="ghost" aria-label={label} title={label} />}>
        <EllipsisIcon aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup className="min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// Clipboard có thể bị chặn (khung chưa focus); không có chỗ hiện lỗi cho thao tác này, người dùng bấm lại được.
const copy = (value: string) => void navigator.clipboard?.writeText(value).catch(() => {});

function BranchRow({
  branch: b,
  defaultBranch,
  lang,
  gitBlock,
  onSwitch,
  onTerminal,
  onMerge,
  onRebase,
  onUpdate,
  updateFrom,
}: {
  branch: BranchInfo;
  defaultBranch: string | undefined;
  lang: Lang;
  /** Lý do chưa merge/rebase được; trống là được. */
  gitBlock: string | undefined;
  onSwitch: (branch: BranchInfo) => void;
  onTerminal: (path: string) => void;
  onMerge: (onto: BranchInfo) => void;
  onRebase: (onto: BranchInfo) => void;
  /** Chỉ có ở dòng nhánh đang đứng khi nó không phải nhánh mặc định: merge nhánh mặc định vào đây. */
  onUpdate: (() => void) | undefined;
  updateFrom: string | undefined;
}) {
  const t = useT(text);
  const date = new Date(b.committedAt * 1000).toLocaleDateString(locale(lang));
  const meta = [
    b.kind === "local" ? (b.upstream ? t.upstreamOf(b.upstream) : t.noUpstream) : undefined,
    defaultBranch && !b.isDefault && b.aheadDefault !== undefined && b.behindDefault !== undefined
      ? t.againstDefault(defaultBranch, b.aheadDefault, b.behindDefault)
      : undefined,
    b.worktreePath ? t.inWorktree(shortPath(b.worktreePath)) : undefined,
    t.committed(date),
  ].filter((m): m is string => m !== undefined);
  return (
    <li className="flex items-start gap-2 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span translate="no" className="min-w-0 truncate font-mono text-sm font-medium" title={b.name}>
            {b.name}
          </span>
          {b.isCurrent && <Pill tone="sel">{t.current}</Pill>}
          {b.upstreamGone && <Pill tone="warn">{t.goneUpstream}</Pill>}
          {!!b.unpushed && <Pill tone="warn">{t.unpushed(b.unpushed)}</Pill>}
          <AheadBehind ahead={b.aheadUpstream} behind={b.behindUpstream} />
        </span>
        {b.subject && <span className="truncate text-xs">{b.subject}</span>}
        <span className="text-xs break-words text-muted-foreground">{meta.join(" · ")}</span>
      </span>
      <RowMenu label={t.menu(b.name)}>
        {!b.isCurrent && (
          <Menu.Item className={MENU_ITEM} onClick={() => onSwitch(b)}>
            {t.switchTo}
          </Menu.Item>
        )}
        {b.isCurrent && onUpdate && (
          <Menu.Item className={MENU_ITEM} disabled={!!gitBlock} onClick={onUpdate}>
            <ItemText label={t.updateFrom(<Name>{updateFrom ?? ""}</Name>)} reason={gitBlock} />
          </Menu.Item>
        )}
        {!b.isCurrent && (
          <>
            <Menu.Item className={MENU_ITEM} disabled={!!gitBlock} onClick={() => onMerge(b)}>
              <ItemText label={t.mergeInto} reason={gitBlock} />
            </Menu.Item>
            <Menu.Item className={MENU_ITEM} disabled={!!gitBlock} onClick={() => onRebase(b)}>
              <ItemText label={t.rebaseOnto} reason={gitBlock} />
            </Menu.Item>
          </>
        )}
        <Menu.Item className={MENU_ITEM} onClick={() => copy(b.name)}>
          {t.copyName}
        </Menu.Item>
        {b.worktreePath && (
          <Menu.Item className={MENU_ITEM} onClick={() => b.worktreePath && onTerminal(b.worktreePath)}>
            {t.openTerminal}
          </Menu.Item>
        )}
      </RowMenu>
    </li>
  );
}

function WorktreeRow({ worktree: w, onTerminal }: { worktree: WorktreeInfo; onTerminal: () => void }) {
  const t = useT(text);
  const gone = w.state === "missing" || w.state === "unreachable";
  const files = w.files ?? [];
  const hidden = (w.filesTotal ?? files.length) - Math.min(3, files.length);
  return (
    <li className="flex items-start gap-2 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span translate="no" className="min-w-0 truncate font-mono text-sm font-medium" title={w.path}>
          {shortPath(w.path)}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("min-w-0 truncate text-xs", w.branch && "font-mono")}>
            {w.branch ?? (w.head ? t.headOnly(w.head.slice(0, 7)) : t.detached)}
          </span>
          {w.isMain && <Pill>{t.main}</Pill>}
          <Pill tone={WORKTREE_TONE[w.state]}>{t.worktreeStates[w.state]}</Pill>
          {w.busy && <Pill tone="warn">{t.busy[w.busy]}</Pill>}
          {w.locked && <Pill tone="warn">{t.locked}</Pill>}
          {w.prunable && <Pill>{t.prunable}</Pill>}
          {w.operation && <Pill tone="warn">{t.ops[w.operation]}</Pill>}
        </span>
        {w.locked && w.lockReason && <span className="text-xs text-muted-foreground">{t.lockedWhy(w.lockReason)}</span>}
        {w.state === "error" && w.error && <span className="text-xs text-destructive">{w.error}</span>}
        {files.length > 0 && (
          <span className="text-xs break-all text-muted-foreground">
            <span className="font-mono">{files.slice(0, 3).join(", ")}</span>
            {hidden > 0 ? ` ${t.moreFiles(hidden)}` : ""}
          </span>
        )}
      </span>
      <RowMenu label={t.menu(shortPath(w.path))}>
        <Menu.Item className={MENU_ITEM} onClick={() => copy(w.path)}>
          {t.copyPath}
        </Menu.Item>
        <Menu.Item className={MENU_ITEM} disabled={gone || w.bare} onClick={onTerminal}>
          {t.openTerminal}
        </Menu.Item>
      </RowMenu>
    </li>
  );
}
