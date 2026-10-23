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
import { secretsList, secretsPurge } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

/** Cùng nội dung với hộp hỏi lại của mục khay "Đăng xuất khỏi Hive" (account::sign_out_prompt). */
const text: Dict<{
  title: string;
  body: string;
  local: string;
  confirm: string;
  busy: string;
  cancel: string;
  dropAssign: (org: string, n: number) => string;
  dropAssignHint: string;
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

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      // Gỡ gán trước khi gỡ token: gỡ gán lỗi thì còn đăng nhập để thử lại, không mất token vì một lựa chọn phụ.
      if (dropAssign) for (const id of assigned) await secretsPurge({ project: id });
      const status = await unlinkAccount();
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={signOut}>
            {busy ? t.busy : t.confirm}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
