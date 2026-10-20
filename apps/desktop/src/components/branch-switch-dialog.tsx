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
import { useEffect, useRef, useState } from "react";
import { shortPath } from "@/lib/folder.ts";
import {
  type BranchError,
  type BranchInfo,
  GitBranchError,
  type OperationKind,
  type SwitchResult,
  switchBranch,
} from "@/lib/git-branches.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: (name: string) => string;
  switching: string;
  dirtyLead: (n: number) => string;
  dirtyHint: string;
  moreFiles: (n: number) => string;
  busyLead: string;
  busyHint: string;
  busyKind: Record<"agent" | "terminal" | "app", string>;
  checkedOut: (path: string) => string;
  openThere: string;
  inProgress: (op: string) => string;
  exists: string;
  cancel: string;
  close: string;
  retry: string;
  carry: string;
  switchAnyway: string;
  ops: Record<OperationKind, string>;
}> = {
  vi: {
    title: (name) => `Đổi sang ${name}`,
    switching: "Đang đổi nhánh…",
    dirtyLead: (n) => `Thư mục có ${n} file đang sửa.`,
    dirtyHint:
      "Mang thay đổi theo nghĩa là giữ chúng sang nhánh mới. Nếu git thấy thay đổi đụng file khác nhau giữa hai nhánh thì sẽ từ chối và thư mục giữ nguyên.",
    moreFiles: (n) => `và ${n} file khác`,
    busyLead: "Có chương trình đang dùng thư mục này.",
    busyHint: "Đổi nhánh lúc này có thể làm chương trình đó đọc nhầm file. Bạn vẫn muốn đổi?",
    busyKind: { agent: "Agent đang chạy", terminal: "Terminal đang mở", app: "App đang dùng" },
    checkedOut: (path) => `Nhánh đang mở ở ${path}.`,
    openThere: "Mở terminal ở đó",
    inProgress: (op) => `${op}. Hoàn tất hay huỷ thao tác đó trước khi đổi nhánh.`,
    exists: "Đã có nhánh local cùng tên. Đổi sang nhánh local đó ở tab Local.",
    cancel: "Huỷ",
    close: "Đóng",
    retry: "Thử lại",
    carry: "Đổi, mang thay đổi theo",
    switchAnyway: "Vẫn đổi",
    ops: {
      merge: "Repo đang merge dở",
      rebase: "Repo đang rebase dở",
      cherryPick: "Repo đang cherry-pick dở",
      revert: "Repo đang revert dở",
      bisect: "Repo đang bisect",
    },
  },
  en: {
    title: (name) => `Switch to ${name}`,
    switching: "Switching branch…",
    dirtyLead: (n) => `The folder has ${n} modified ${n === 1 ? "file" : "files"}.`,
    dirtyHint:
      "Carrying the changes keeps them on the new branch. If git sees the changes touch files that differ between the two branches it refuses and the folder stays as it is.",
    moreFiles: (n) => `and ${n} more`,
    busyLead: "Something is using this folder.",
    busyHint: "Switching now may make that program read the wrong files. Switch anyway?",
    busyKind: { agent: "Agent running", terminal: "Terminal open", app: "Used by the app" },
    checkedOut: (path) => `The branch is checked out at ${path}.`,
    openThere: "Open terminal there",
    inProgress: (op) => `${op}. Finish or abort it before switching branches.`,
    exists: "A local branch with this name already exists. Switch to that local branch from the Local tab.",
    cancel: "Cancel",
    close: "Close",
    retry: "Try again",
    carry: "Switch, carry changes",
    switchAnyway: "Switch anyway",
    ops: {
      merge: "A merge is in progress",
      rebase: "A rebase is in progress",
      cherryPick: "A cherry-pick is in progress",
      revert: "A revert is in progress",
      bisect: "A bisect is in progress",
    },
  },
};

type Phase = { kind: "switching" } | { kind: "ask"; error: BranchError } | { kind: "failed"; message: string };

/**
 * Đổi nhánh cho thư mục chính (US2). Mở là thử đổi ngay: git switch không dùng --force nên an toàn, và nhờ vậy thư mục
 * sạch chỉ tốn hai lần bấm (menu, Đổi sang). Sidecar tự từ chối khi cần hỏi (`dirty`, `busy`) hay không đổi được
 * (`checked_out`, `in_progress`); hộp thoại chỉ thể hiện câu trả lời đó (Q10, FR-014).
 */
export function BranchSwitchDialog({
  folder,
  branch,
  onClose,
  onSwitched,
  onOpenTerminal,
}: {
  folder: string;
  branch: BranchInfo;
  onClose: () => void;
  onSwitched: (result: SwitchResult) => void;
  onOpenTerminal: (path: string) => void;
}) {
  const t = useT(text);
  const [phase, setPhase] = useState<Phase>({ kind: "switching" });
  // Lần xác nhận trước vẫn có hiệu lực: người dùng đã đồng ý với agent đang chạy thì không hỏi lại khi gặp `dirty`.
  const confirmed = useRef({ busy: false, carry: false });
  const open = useRef(true);
  // StrictMode chạy effect hai lần ở dev; lệnh ghi chỉ được gửi một lần.
  const started = useRef(false);

  async function run() {
    setPhase({ kind: "switching" });
    try {
      const target = branch.kind === "remote" ? { track: branch.name } : { branch: branch.name };
      const result = await switchBranch(folder, target, {
        carry: confirmed.current.carry,
        confirmBusy: confirmed.current.busy,
      });
      if (open.current) onSwitched(result);
    } catch (e) {
      if (!open.current) return;
      if (e instanceof GitBranchError) setPhase({ kind: "ask", error: e.info });
      else setPhase({ kind: "failed", message: errorText(e) });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ thử đổi một lần khi hộp thoại mở.
  useEffect(() => {
    open.current = true;
    if (!started.current) {
      started.current = true;
      void run();
    }
    return () => {
      open.current = false;
    };
  }, []);

  const switching = phase.kind === "switching";
  const error = phase.kind === "ask" ? phase.error : null;

  function confirm(what: "busy" | "carry") {
    confirmed.current = { ...confirmed.current, [what]: true };
    void run();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !switching && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            <span translate="no" className="font-mono">
              {t.title(branch.name)}
            </span>
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{shortPath(folder)}</DialogDescription>
        </DialogHeader>

        {switching && (
          <p role="status" className="text-sm text-muted-foreground">
            {t.switching}
          </p>
        )}
        {phase.kind === "failed" && <Alert variant="destructive">{phase.message}</Alert>}
        {error && <BranchErrorBody error={error} />}

        <DialogActions>
          {error?.code === "dirty" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t.cancel}
              </Button>
              <Button onClick={() => confirm("carry")}>{t.carry}</Button>
            </>
          ) : error?.code === "busy" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t.cancel}
              </Button>
              <Button variant="destructive" onClick={() => confirm("busy")}>
                {t.switchAnyway}
              </Button>
            </>
          ) : error?.code === "checked_out" && error.path ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t.close}
              </Button>
              <Button onClick={() => onOpenTerminal(error.path as string)}>{t.openThere}</Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={switching} onClick={onClose}>
                {t.close}
              </Button>
              {phase.kind !== "switching" && error?.code !== "in_progress" && error?.code !== "exists" && (
                <Button onClick={() => void run()}>{t.retry}</Button>
              )}
            </>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** Lý do sidecar từ chối đổi/tạo nhánh, dùng chung với hộp thoại tạo nhánh. */
export function BranchErrorBody({ error }: { error: BranchError }) {
  const t = useT(text);
  switch (error.code) {
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
          {hidden > 0 && <p className="text-xs text-muted-foreground">{t.moreFiles(hidden)}</p>}
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
    case "checked_out":
      return <Alert>{t.checkedOut(error.path ? shortPath(error.path) : "")}</Alert>;
    case "in_progress":
      return (
        <Alert variant="destructive">{t.inProgress(error.operation ? t.ops[error.operation] : error.message)}</Alert>
      );
    case "exists":
      return <Alert variant="destructive">{t.exists}</Alert>;
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
