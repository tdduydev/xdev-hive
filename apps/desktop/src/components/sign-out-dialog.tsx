import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { useEffect, useState } from "react";
import { type AccountStatus, unlinkAccount } from "@/lib/account.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { localProjects } from "@/lib/local-projects.ts";
import { OUTBOX_REFRESH_MS, onOutboxChanged, outboxStatus } from "@/lib/outbox.ts";
import { secretsList, secretsPurge } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

/** Khay cũng mở hộp này để mọi lối đăng xuất dùng chung lựa chọn hộp thư đi và bí mật. */
const text: Dict<{
  title: string;
  body: string;
  local: string;
  confirm: string;
  busy: string;
  cancel: string;
  dropAssign: (org: string, n: number) => string;
  dropAssignHint: string;
  waiting: (n: number) => string;
  send: string;
  keep: string;
  drop: string;
  outboxHint: string;
  unknown: string;
  checking: string;
}> = {
  vi: {
    title: "Đăng xuất khỏi Hive?",
    body: "Token cá nhân bị gỡ khỏi keychain của máy.",
    local:
      "Máy vẫn đăng ký với hub: worker vẫn nhận việc, gói agent, dự án và công cụ trên máy vẫn dùng được. Muốn đăng nhập lại thì dán token mới hoặc đăng nhập bằng trình duyệt.",
    confirm: "Đăng xuất",
    busy: "Đang đăng xuất…",
    cancel: "Huỷ",
    dropAssign: (org, n) => `Gỡ luôn bí mật đã gán cho ${n} dự án của tổ chức ${org}`,
    dropAssignHint: "Chỉ gỡ gán; bí mật và giá trị vẫn nằm trong kho của máy. Không chọn thì giữ nguyên.",
    waiting: (n) => `Hộp thư đi trên máy còn ${n} mục chờ gửi hoặc đang giữ.`,
    send: "Gửi trước",
    keep: "Giữ lại",
    drop: "Bỏ",
    outboxHint:
      "Gửi trước chờ tối đa 30 giây rồi giữ phần chưa gửi. Giữ lại để gửi khi bạn đăng nhập lại. Bỏ xoá các mục của bạn ở hub này.",
    unknown: "Chưa đọc được hộp thư đi. Chọn Giữ lại để giữ các mục trên máy khi đăng xuất.",
    checking: "Đang kiểm tra hộp thư đi…",
  },
  en: {
    title: "Sign out of Hive?",
    body: "Your personal token is removed from this machine's keychain.",
    local:
      "The machine stays registered: the worker keeps taking runs, and agent plans, projects and tools on this machine keep working. Paste a new token or sign in with the browser to come back.",
    confirm: "Sign out",
    busy: "Signing out…",
    cancel: "Cancel",
    dropAssign: (org, n) => `Also remove the secrets assigned to ${n} ${n === 1 ? "project" : "projects"} of ${org}`,
    dropAssignHint:
      "Only the assignments go; the secrets and their values stay in this machine's store. Unchecked keeps them.",
    waiting: (n) => `This machine's outbox has ${n} pending or held items.`,
    send: "Send first",
    keep: "Keep",
    drop: "Drop",
    outboxHint:
      "Send first waits up to 30 seconds, then keeps unsent items. Keep sends them when you sign in again. Drop deletes your items for this hub.",
    unknown: "The outbox could not be read. Choose Keep to preserve items on this machine when signing out.",
    checking: "Checking the outbox…",
  },
};

/**
 * Dự án của tổ chức đang đăng nhập mà đã có bí mật gán (FR-063). Dự án của tổ chức là dự án trên máy đã gắn với dự án hub;
 * một máy chỉ liên kết một tổ chức một lúc nên không cần lọc thêm. Lỗi (ngoài Tauri, worker cũ) thì coi như không có.
 */
async function assignedOrgProjects(): Promise<string[]> {
  try {
    const [local, list] = await Promise.all([localProjects(), secretsList()]);
    const org = new Set(local.projects.filter((p) => p.projectId && p.localId).map((p) => p.localId as string));
    const used = new Set(list.secrets.flatMap((s) => s.projects.map((p) => p.localId)));
    return [...org].filter((id) => used.has(id));
  } catch {
    return [];
  }
}

/** Hỏi lại trước khi đăng xuất: token đã gỡ thì phải tạo token mới trên web mới đăng nhập lại được. */
export function SignOutDialog({
  open,
  onOpenChange,
  onSignedOut,
  orgName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedOut: (status: AccountStatus) => void;
  /** Tên tổ chức của tài khoản đang đăng nhập; không có (token hỏng) thì không hỏi về bí mật. */
  orgName?: string | undefined;
}) {
  const t = useT(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [dropAssign, setDropAssign] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    setError(null);
    setPending(null);
    setChecking(true);
    if (!open) return;
    let stale = false;
    const refresh = () =>
      outboxStatus()
        .then(
          (s) => {
            if (!stale) setPending(s.pending + s.held);
          },
          () => {
            if (!stale) setPending(null);
          },
        )
        .finally(() => {
          if (!stale) setChecking(false);
        });
    void refresh();
    const off = onOutboxChanged(() => void refresh());
    const timer = window.setInterval(() => void refresh(), OUTBOX_REFRESH_MS);
    return () => {
      stale = true;
      off();
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    // Luôn về mặc định giữ mỗi lần mở: gỡ gán là việc người dùng phải chọn lại.
    setDropAssign(false);
    setAssigned([]);
    if (!open || !orgName) return;
    let stale = false;
    void assignedOrgProjects().then((ids) => !stale && setAssigned(ids));
    return () => {
      stale = true;
    };
  }, [open, orgName]);

  async function signOut(action: "send" | "keep" | "drop") {
    setBusy(true);
    setError(null);
    try {
      // Gỡ gán trước khi gỡ token: gỡ gán lỗi thì còn đăng nhập để thử lại, không mất token vì một lựa chọn phụ.
      if (dropAssign) for (const id of assigned) await secretsPurge({ project: id });
      const status = await unlinkAccount(action);
      // Dữ liệu hub đã đệm là của người vừa đăng xuất; người đăng nhập sau không được thấy lại.
      queryClient.clear();
      onSignedOut(status);
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.body}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t.local}</p>
        {checking && (
          <p role="status" className="text-sm text-muted-foreground">
            {t.checking}
          </p>
        )}
        {!checking && (pending === null || pending > 0) && (
          <div role="status" className="space-y-1 text-sm">
            <p>{pending === null ? t.unknown : t.waiting(pending)}</p>
            <p className="text-muted-foreground">{t.outboxHint}</p>
          </div>
        )}
        {orgName && assigned.length > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 cursor-pointer accent-primary"
              checked={dropAssign}
              disabled={busy}
              onChange={(e) => setDropAssign(e.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              {t.dropAssign(orgName, assigned.length)}
              <span className="text-xs text-muted-foreground">{t.dropAssignHint}</span>
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          {pending === null || pending > 0 ? (
            <>
              <Button variant="outline" disabled={busy || checking} onClick={() => void signOut("send")}>
                {t.send}
              </Button>
              <Button disabled={busy || checking} onClick={() => void signOut("keep")}>
                {busy ? t.busy : t.keep}
              </Button>
              <Button variant="destructive" disabled={busy || checking} onClick={() => void signOut("drop")}>
                {t.drop}
              </Button>
            </>
          ) : (
            <Button variant="destructive" disabled={busy || checking} onClick={() => void signOut("keep")}>
              {busy ? t.busy : t.confirm}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
