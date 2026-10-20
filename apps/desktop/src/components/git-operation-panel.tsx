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
import { CopyIcon, FolderOpenIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { shortPath } from "@/lib/folder.ts";
import {
  abortOperation,
  type BranchError,
  continueOperation,
  type ErrorCode,
  GitBranchError,
  type GitOperation,
  mergeBranch,
  type OperationKind,
  type PullResult,
  pullBranch,
  rebaseBranch,
  resetKeepCommand,
  useBranchJob,
} from "@/lib/git-branches.ts";
import { openFolder } from "@/lib/git-groups.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  running: Record<OperationKind, string>;
  step: (n: number, total: number) => string;
  merging: (onto: ReactNode, branch: ReactNode) => ReactNode;
  rebasing: (onto: ReactNode, branch: ReactNode) => ReactNode;
  conflictsLead: (n: number) => string;
  moreFiles: (n: number) => string;
  noConflicts: string;
  stillConflicts: (n: number) => string;
  howTo: string;
  openFolder: string;
  openTerminal: string;
  proceed: string;
  proceeding: string;
  abort: string;
  aborting: string;
  abortAsk: (kind: "merge" | "rebase") => string;
  abortConfirm: string;
  abortKeep: string;
  undoLead: string;
  copyCommand: string;
  pullTitle: (branch: ReactNode) => ReactNode;
  mergeTitle: (onto: ReactNode, into: ReactNode) => ReactNode;
  rebaseTitle: (branch: ReactNode, onto: ReactNode) => ReactNode;
  pulling: string;
  pullFetching: string;
  pullAdvancing: string;
  mergeRunning: string;
  rebaseRunning: string;
  divergedLead: (ahead: number, behind: number, upstream: ReactNode) => ReactNode;
  divergedHint: string;
  mergeUpstream: string;
  rebaseUpstream: string;
  dirtyLead: (n: number) => string;
  dirtyHint: string;
  moreFilesDirty: (n: number) => string;
  busyLead: string;
  busyHint: string;
  busyKind: Record<"hiveWorker" | "agent" | "terminal" | "app", string>;
  runAnyway: string;
  rewriteLead: (n: number) => string;
  rewriteHint: string;
  rebase: string;
  inProgress: (op: string) => string;
  needBranch: string;
  noUpstream: string;
  close: string;
  cancel: string;
  retry: string;
  unknown: string;
  ops: Record<OperationKind, string>;
}> = {
  vi: {
    running: {
      merge: "Đang merge",
      rebase: "Đang rebase",
      cherryPick: "Đang cherry-pick",
      revert: "Đang revert",
      bisect: "Đang bisect",
    },
    step: (n, total) => `Bước ${n}/${total}`,
    merging: (onto, branch) => (
      <>
        Merge {onto} vào {branch}.
      </>
    ),
    rebasing: (onto, branch) => (
      <>
        Rebase {branch} lên {onto}.
      </>
    ),
    conflictsLead: (n) => `${n} file còn xung đột:`,
    moreFiles: (n) => `và ${n} file nữa`,
    noConflicts: "Không còn file xung đột. Bấm Tiếp tục để hoàn tất.",
    stillConflicts: (n) => `Còn ${n} file chưa giải quyết, git chưa được chạy.`,
    howTo: "Sửa các file trong thư mục hay terminal, chạy git add cho từng file đã xong, rồi bấm Tiếp tục.",
    openFolder: "Mở thư mục",
    openTerminal: "Mở terminal",
    proceed: "Tiếp tục",
    proceeding: "Đang chạy…",
    abort: "Huỷ",
    aborting: "Đang huỷ…",
    abortAsk: (kind) =>
      `Huỷ ${kind} đưa thư mục về như trước khi bắt đầu. Những gì bạn đã sửa tay để giải xung đột sẽ mất.`,
    abortConfirm: "Huỷ thao tác",
    abortKeep: "Giữ lại",
    undoLead: "Muốn quay về như trước khi bắt đầu, chạy trong terminal:",
    copyCommand: "Sao chép lệnh",
    pullTitle: (branch) => <>Pull {branch}</>,
    mergeTitle: (onto, into) => (
      <>
        Merge {onto} vào {into}
      </>
    ),
    rebaseTitle: (branch, onto) => (
      <>
        Rebase {branch} lên {onto}
      </>
    ),
    pulling: "Đang pull…",
    pullFetching: "Đang fetch từ remote…",
    pullAdvancing: "Đang tiến nhanh…",
    mergeRunning: "Đang merge…",
    rebaseRunning: "Đang rebase…",
    divergedLead: (ahead, behind, upstream) => (
      <>
        Nhánh có {ahead} commit mới ở máy và thiếu {behind} commit của {upstream}. Pull chỉ tiến nhanh nên không chạy.
      </>
    ),
    divergedHint: "Chọn cách gộp hai bên. Cả hai đều chỉ đổi nhánh ở máy này, app không đẩy lên remote.",
    mergeUpstream: "Merge upstream",
    rebaseUpstream: "Rebase lên upstream",
    dirtyLead: (n) => `Thư mục có ${n} file đang sửa hay chưa theo dõi.`,
    dirtyHint: "Commit hay cất các thay đổi này (cả file chưa theo dõi) trước, rồi thử lại.",
    moreFilesDirty: (n) => `và ${n} file khác`,
    busyLead: "Có chương trình đang dùng thư mục này.",
    busyHint: "Đổi code lúc này có thể làm chương trình đó đọc nhầm file. Bạn vẫn muốn chạy?",
    busyKind: {
      hiveWorker: "Worker đang dùng",
      agent: "Agent đang chạy",
      terminal: "Terminal đang mở",
      app: "App đang dùng",
    },
    runAnyway: "Vẫn chạy",
    rewriteLead: (n) => `Rebase viết lại ${n} commit đã đẩy.`,
    rewriteHint: "Sau đó phải force-push mới đẩy lên remote được; app không push.",
    rebase: "Rebase",
    inProgress: (op) => `${op}. Hoàn tất hay huỷ thao tác đó trước.`,
    needBranch: "Cần đứng trên một nhánh",
    noUpstream: "Nhánh chưa theo dõi nhánh remote nào.",
    close: "Đóng",
    cancel: "Huỷ",
    retry: "Thử lại",
    unknown: "Worker dừng giữa chừng.",
    ops: {
      merge: "Repo đang merge dở",
      rebase: "Repo đang rebase dở",
      cherryPick: "Repo đang cherry-pick dở",
      revert: "Repo đang revert dở",
      bisect: "Repo đang bisect",
    },
  },
  en: {
    running: {
      merge: "Merge in progress",
      rebase: "Rebase in progress",
      cherryPick: "Cherry-pick in progress",
      revert: "Revert in progress",
      bisect: "Bisect in progress",
    },
    step: (n, total) => `Step ${n}/${total}`,
    merging: (onto, branch) => (
      <>
        Merging {onto} into {branch}.
      </>
    ),
    rebasing: (onto, branch) => (
      <>
        Rebasing {branch} onto {onto}.
      </>
    ),
    conflictsLead: (n) => `${n} ${n === 1 ? "file" : "files"} in conflict:`,
    moreFiles: (n) => `and ${n} more`,
    noConflicts: "No file is in conflict any more. Press Continue to finish.",
    stillConflicts: (n) => `${n} ${n === 1 ? "file is" : "files are"} still unresolved, git was not run.`,
    howTo:
      "Edit the files in the folder or a terminal, run git add on each one you are done with, then press Continue.",
    openFolder: "Open folder",
    openTerminal: "Open terminal",
    proceed: "Continue",
    proceeding: "Running…",
    abort: "Abort",
    aborting: "Aborting…",
    abortAsk: (kind) =>
      `Aborting the ${kind} puts the folder back as it was before it started. Whatever you edited by hand to resolve conflicts is lost.`,
    abortConfirm: "Abort it",
    abortKeep: "Keep going",
    undoLead: "To go back to how it was before it started, run in a terminal:",
    copyCommand: "Copy command",
    pullTitle: (branch) => <>Pull {branch}</>,
    mergeTitle: (onto, into) => (
      <>
        Merge {onto} into {into}
      </>
    ),
    rebaseTitle: (branch, onto) => (
      <>
        Rebase {branch} onto {onto}
      </>
    ),
    pulling: "Pulling…",
    pullFetching: "Fetching from the remote…",
    pullAdvancing: "Fast-forwarding…",
    mergeRunning: "Merging…",
    rebaseRunning: "Rebasing…",
    divergedLead: (ahead, behind, upstream) => (
      <>
        The branch has {ahead} new {ahead === 1 ? "commit" : "commits"} here and lacks {behind} of {upstream}. Pull only
        fast-forwards, so it did not run.
      </>
    ),
    divergedHint:
      "Pick how to combine the two sides. Both only change the branch on this machine, the app never pushes.",
    mergeUpstream: "Merge upstream",
    rebaseUpstream: "Rebase onto upstream",
    dirtyLead: (n) => `The folder has ${n} modified or untracked ${n === 1 ? "file" : "files"}.`,
    dirtyHint: "Commit or stash these changes (untracked files too) first, then try again.",
    moreFilesDirty: (n) => `and ${n} more`,
    busyLead: "Something is using this folder.",
    busyHint: "Changing the code now may make that program read the wrong files. Run anyway?",
    busyKind: {
      hiveWorker: "Used by the worker",
      agent: "Agent running",
      terminal: "Terminal open",
      app: "Used by the app",
    },
    runAnyway: "Run anyway",
    rewriteLead: (n) => `The rebase rewrites ${n} pushed ${n === 1 ? "commit" : "commits"}.`,
    rewriteHint: "You will need to force-push afterwards to update the remote; the app does not push.",
    rebase: "Rebase",
    inProgress: (op) => `${op}. Finish or abort it first.`,
    needBranch: "Check out a branch first",
    noUpstream: "The branch does not track a remote branch.",
    close: "Close",
    cancel: "Cancel",
    retry: "Try again",
    unknown: "The worker stopped midway.",
    ops: {
      merge: "A merge is in progress",
      rebase: "A rebase is in progress",
      cherryPick: "A cherry-pick is in progress",
      revert: "A revert is in progress",
      bisect: "A bisect is in progress",
    },
  },
};

/** Tên nhánh, đường dẫn hay lệnh trong câu: mono, không dịch. */
function Mono({ children }: { children: ReactNode }) {
  return (
    <span translate="no" className="font-mono font-medium">
      {children}
    </span>
  );
}

// Clipboard có thể bị chặn (khung chưa focus); người dùng bấm lại được nên không cần chỗ hiện lỗi.
const copy = (value: string) => void navigator.clipboard?.writeText(value).catch(() => {});

/**
 * Lệnh quay về trước khi merge/rebase/pull (FR-056). Chỉ hiện để người dùng tự chạy: app không bao giờ chạy
 * `git reset`, kể cả `--keep`.
 */
export function ResetCommand({ headBefore }: { headBefore: string }) {
  const t = useT(text);
  const command = resetKeepCommand(headBefore);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{t.undoLead}</span>
      <code translate="no" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all select-all">
        {command}
      </code>
      <Button size="xs" variant="ghost" onClick={() => copy(command)}>
        <CopyIcon aria-hidden="true" />
        {t.copyCommand}
      </Button>
    </span>
  );
}

/** Hai loại thao tác dở mà `continue` và `abort` xử lý được; cherry-pick, revert, bisect chỉ hiện nhãn ở thanh trạng thái. */
export const isResumable = (op: GitOperation | undefined): op is GitOperation =>
  op?.kind === "merge" || op?.kind === "rebase";

/**
 * Khung đầu BranchesSheet khi repo đang dở merge hay rebase, kể cả do người dùng bắt đầu ngoài app (US8): file xung đột,
 * bước n/m, Mở thư mục, Mở terminal, Tiếp tục, Huỷ và lệnh `git reset --keep`. Tiếp tục luôn bấm được vì sidecar tự kiểm
 * file `U` còn lại (không chạy git nếu còn); danh sách file trong khung chỉ là ảnh chụp lúc đọc.
 */
export function GitOperationPanel({
  folder,
  operation,
  onFinished,
  onTerminal,
}: {
  folder: string;
  operation: GitOperation;
  /** `continue` xong (`done`) hay `abort` xong (`aborted`): repo đã hết dở, bảng nhánh cần đọc lại. */
  onFinished: (operation: GitOperation) => void;
  onTerminal: (path: string) => void;
}) {
  const t = useT(text);
  // Kết quả của Tiếp tục (vẫn xung đột, sang bước sau) thay ảnh chụp cho tới khi bảng đọc lại và đưa ảnh mới xuống.
  const [latest, setLatest] = useState<{ from: GitOperation; op: GitOperation } | null>(null);
  const [pending, setPending] = useState<"continue" | "abort" | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const op = latest?.from === operation ? latest.op : operation;
  const kind = op.kind === "rebase" ? "rebase" : "merge";
  const hidden = op.conflictsTotal - op.conflicts.length;

  async function run(what: "continue" | "abort") {
    setPending(what);
    setProblem(null);
    setRemaining(null);
    try {
      const next = await (what === "continue" ? continueOperation(folder) : abortOperation(folder));
      if (next.state === "done" || next.state === "aborted") {
        onFinished(next);
        return;
      }
      setLatest({ from: operation, op: { ...op, ...next } });
      if (what === "continue" && next.conflicts.length > 0) setRemaining(next.conflictsTotal);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setPending(null);
      setAsking(false);
    }
  }

  const onto = op.onto?.name;
  return (
    <section
      aria-label={t.running[op.kind]}
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{t.running[op.kind]}</h3>
        {op.step !== undefined && op.total !== undefined && (
          <Pill tone="warn">
            <span className="tabular-nums">{t.step(op.step, op.total)}</span>
          </Pill>
        )}
      </div>
      {op.branch && onto && (
        <p className="text-sm break-words">
          {(kind === "rebase" ? t.rebasing : t.merging)(<Mono>{onto}</Mono>, <Mono>{op.branch}</Mono>)}
        </p>
      )}
      {op.conflicts.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm">{t.conflictsLead(op.conflictsTotal)}</p>
          <ul
            translate="no"
            className="max-h-32 overflow-y-auto rounded-lg border bg-background px-2.5 py-2 font-mono text-xs"
          >
            {op.conflicts.map((f) => (
              <li key={f} className="break-all">
                {f}
              </li>
            ))}
          </ul>
          {hidden > 0 && <p className="text-xs text-muted-foreground">{t.moreFiles(hidden)}</p>}
          <p className="text-xs text-muted-foreground">{t.howTo}</p>
        </div>
      ) : (
        <p className="text-sm">{t.noConflicts}</p>
      )}
      {remaining !== null && (
        <p role="status" className="text-sm text-warning">
          {t.stillConflicts(remaining)}
        </p>
      )}
      {problem && <Alert variant="destructive">{problem}</Alert>}
      {asking && (
        <Alert>
          {t.abortAsk(kind)}
          <span className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="destructive-solid" disabled={pending !== null} onClick={() => void run("abort")}>
              {pending === "abort" ? t.aborting : t.abortConfirm}
            </Button>
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => setAsking(false)}>
              {t.abortKeep}
            </Button>
          </span>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void openFolder(folder).catch((e: unknown) => setProblem(errorText(e)))}
        >
          <FolderOpenIcon aria-hidden="true" />
          {t.openFolder}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onTerminal(folder)}>
          <TerminalIcon aria-hidden="true" />
          {t.openTerminal}
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="outline" disabled={pending !== null || asking} onClick={() => setAsking(true)}>
          {t.abort}
        </Button>
        <Button size="sm" disabled={pending !== null} onClick={() => void run("continue")}>
          {pending === "continue" ? t.proceeding : t.proceed}
        </Button>
      </div>
      {op.headBefore && (
        <p className="text-xs text-muted-foreground">
          <ResetCommand headBefore={op.headBefore} />
        </p>
      )}
    </section>
  );
}

type Onto = { name: string; tip: string };

/** Việc hộp thoại sẽ chạy. Merge và rebase nhận `tip` đã đọc lúc bấm (FR-050), không tra lại theo tên. */
export type GitAction =
  | { kind: "pull"; branch: string }
  | { kind: "merge"; onto: Onto; into: string }
  | { kind: "rebase"; onto: Onto; branch: string };

export type GitActionResult =
  | { kind: "pull"; branch: string; pull: PullResult }
  | { kind: "merge" | "rebase"; operation: GitOperation };

type Phase = { kind: "running" } | { kind: "ask"; error: BranchError } | { kind: "failed"; message: string };

// Lỗi mà thử lại ngay vẫn ra lỗi đó cho tới khi người dùng đổi thứ khác.
const NO_RETRY: ErrorCode[] = ["in_progress", "detached", "no_upstream", "no_operation", "not_found"];

/**
 * Pull, merge hay rebase vào nhánh đang đứng (US5, US6, US8). Mở là chạy ngay như hộp thoại đổi nhánh: sidecar tự từ
 * chối khi cần hỏi (`dirty`, `busy`, `needsConfirm`, `diverged`) và hộp thoại chỉ thể hiện câu trả lời, mỗi lần xác nhận
 * gửi lại đúng lệnh với cờ tương ứng. Pull gặp `diverged` thì gợi ý Merge upstream hay Rebase lên upstream, chạy tiếp
 * ngay trong hộp thoại này.
 */
export function GitActionDialog({
  folder,
  action: first,
  onClose,
  onDone,
}: {
  folder: string;
  action: GitAction;
  onClose: () => void;
  onDone: (result: GitActionResult) => void;
}) {
  const t = useT(text);
  const [action, setAction] = useState(first);
  const [phase, setPhase] = useState<Phase>({ kind: "running" });
  const [pullId, setPullId] = useState<string | null>(null);
  const job = useBranchJob(pullId);
  const confirmed = useRef({ busy: false, rewrite: false });
  const open = useRef(true);
  // StrictMode chạy effect hai lần ở dev; lệnh ghi chỉ được gửi một lần.
  const started = useRef(false);
  const handled = useRef<string | null>(null);

  async function run(next: GitAction) {
    setAction(next);
    setPhase({ kind: "running" });
    try {
      if (next.kind === "pull") {
        const id = await pullBranch(folder, { confirmBusy: confirmed.current.busy });
        if (open.current) setPullId(id);
        return;
      }
      const operation =
        next.kind === "merge"
          ? await mergeBranch(folder, next.onto, { confirmBusy: confirmed.current.busy })
          : await rebaseBranch(folder, next.onto, {
              confirmBusy: confirmed.current.busy,
              confirmRewrite: confirmed.current.rewrite,
            });
      if (!open.current) return;
      if (operation.state === "error" && operation.error) setPhase({ kind: "ask", error: operation.error });
      else onDone({ kind: next.kind, operation });
    } catch (e) {
      if (!open.current) return;
      if (e instanceof GitBranchError) setPhase({ kind: "ask", error: e.info });
      else setPhase({ kind: "failed", message: errorText(e) });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy một lần khi hộp thoại mở.
  useEffect(() => {
    open.current = true;
    if (!started.current) {
      started.current = true;
      void run(first);
    }
    return () => {
      open.current = false;
    };
  }, []);

  // Pull là job: kết quả đến bằng sự kiện `done`, lỗi nghiệp vụ nằm ở `done.error`.
  useEffect(() => {
    if (!pullId || !job?.finished || handled.current === pullId || action.kind !== "pull") return;
    handled.current = pullId;
    const error = job.result?.error;
    if (error) setPhase({ kind: "ask", error });
    else if (job.result?.pull) onDone({ kind: "pull", branch: action.branch, pull: job.result.pull });
    else setPhase({ kind: "failed", message: job.error ?? t.unknown });
  }, [pullId, job, action, onDone, t]);

  const running = phase.kind === "running";
  const error = phase.kind === "ask" ? phase.error : null;

  function again(what: "busy" | "rewrite") {
    confirmed.current = { ...confirmed.current, [what]: true };
    void run(action);
  }

  const title =
    action.kind === "pull"
      ? t.pullTitle(<Mono>{action.branch}</Mono>)
      : action.kind === "merge"
        ? t.mergeTitle(<Mono>{action.onto.name}</Mono>, <Mono>{action.into}</Mono>)
        : t.rebaseTitle(<Mono>{action.branch}</Mono>, <Mono>{action.onto.name}</Mono>);
  const runningText =
    action.kind === "merge"
      ? t.mergeRunning
      : action.kind === "rebase"
        ? t.rebaseRunning
        : job?.progress?.step === "fetch"
          ? t.pullFetching
          : job?.progress?.step === "merge"
            ? t.pullAdvancing
            : t.pulling;
  const upstream = error?.code === "diverged" && error.upstream && error.upstreamTip ? error : null;
  const into = action.kind === "pull" ? action.branch : action.kind === "merge" ? action.into : action.branch;

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="break-words">{title}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{shortPath(folder)}</DialogDescription>
        </DialogHeader>

        {running && (
          <p role="status" className="text-sm text-muted-foreground">
            {runningText}
          </p>
        )}
        {phase.kind === "failed" && <Alert variant="destructive">{phase.message}</Alert>}
        {error && <ActionErrorBody error={error} />}

        <DialogActions>
          {error?.code === "diverged" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t.close}
              </Button>
              {upstream?.upstream && upstream.upstreamTip && (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void run({
                        kind: "rebase",
                        branch: into,
                        onto: { name: upstream.upstream as string, tip: upstream.upstreamTip as string },
                      })
                    }
                  >
                    {t.rebaseUpstream}
                  </Button>
                  <Button
                    onClick={() =>
                      void run({
                        kind: "merge",
                        into,
                        onto: { name: upstream.upstream as string, tip: upstream.upstreamTip as string },
                      })
                    }
                  >
                    {t.mergeUpstream}
                  </Button>
                </>
              )}
            </>
          ) : error?.code === "busy" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t.cancel}
              </Button>
              <Button variant="destructive-solid" onClick={() => again("busy")}>
                {t.runAnyway}
              </Button>
            </>
          ) : error?.code === "needsConfirm" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t.cancel}
              </Button>
              <Button variant="destructive-solid" onClick={() => again("rewrite")}>
                {t.rebase}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={onClose}>
                {t.close}
              </Button>
              {!running && !(error && NO_RETRY.includes(error.code)) && (
                <Button onClick={() => void run(action)}>{t.retry}</Button>
              )}
            </>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** Lý do sidecar từ chối pull, merge hay rebase. */
function ActionErrorBody({ error }: { error: BranchError }) {
  const t = useT(text);
  switch (error.code) {
    case "diverged":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm">
            {t.divergedLead(error.ahead ?? 0, error.behind ?? 0, <Mono>{error.upstream ?? ""}</Mono>)}
          </p>
          <p className="text-xs text-muted-foreground">{t.divergedHint}</p>
        </div>
      );
    case "dirty": {
      const files = error.files ?? [];
      const hidden = (error.filesTotal ?? files.length) - files.length;
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm">{t.dirtyLead(error.filesTotal ?? files.length)}</p>
          <ul
            translate="no"
            className="max-h-48 overflow-y-auto rounded-lg border bg-muted/50 px-2.5 py-2 font-mono text-xs"
          >
            {files.map((f) => (
              <li key={f} className="break-all">
                {f}
              </li>
            ))}
          </ul>
          {hidden > 0 && <p className="text-xs text-muted-foreground">{t.moreFilesDirty(hidden)}</p>}
          <p className="text-xs text-muted-foreground">{t.dirtyHint}</p>
        </div>
      );
    }
    case "busy":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm">{t.busyLead}</p>
          <ul className="flex flex-col gap-1 text-xs">
            {(error.busy ?? []).map((b) => (
              <li key={`${b.kind}:${b.path}`} className="break-words">
                {b.label ?? t.busyKind[b.kind]}
                <span translate="no" className="font-mono text-muted-foreground">
                  {" "}
                  {shortPath(b.path)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t.busyHint}</p>
        </div>
      );
    case "needsConfirm":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm">{t.rewriteLead(error.count ?? 0)}</p>
          <p className="text-xs text-muted-foreground">{t.rewriteHint}</p>
        </div>
      );
    case "in_progress":
      return (
        <Alert variant="destructive">{t.inProgress(error.operation ? t.ops[error.operation] : error.message)}</Alert>
      );
    case "detached":
      return <Alert variant="destructive">{t.needBranch}</Alert>;
    case "no_upstream":
      return <Alert variant="destructive">{t.noUpstream}</Alert>;
    default:
      // FR-042: `detail` là dòng cuối stderr của git, sidecar đã che token.
      return (
        <Alert variant="destructive">
          {error.message}
          {error.detail && (
            <span translate="no" className="mt-1 block font-mono text-xs break-all">
              {error.detail}
            </span>
          )}
        </Alert>
      );
  }
}
