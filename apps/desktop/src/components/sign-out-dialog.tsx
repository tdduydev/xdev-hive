import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { useState } from "react";
import { type AccountStatus, unlinkAccount } from "@/lib/account.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

/** Cùng nội dung với hộp hỏi lại của mục khay "Đăng xuất khỏi Hive" (account::sign_out_prompt). */
const text: Dict<{ title: string; body: string; local: string; confirm: string; busy: string; cancel: string }> = {
  vi: {
    title: "Đăng xuất khỏi Hive?",
    body: "Token cá nhân bị gỡ khỏi keychain của máy và bản đọc offline bị xoá.",
    local:
      "Máy vẫn đăng ký với hub: worker vẫn nhận việc, gói agent, dự án và công cụ trên máy vẫn dùng được. Muốn đăng nhập lại thì dán token mới hoặc đăng nhập bằng trình duyệt.",
    confirm: "Đăng xuất",
    busy: "Đang đăng xuất…",
    cancel: "Huỷ",
  },
  en: {
    title: "Sign out of Hive?",
    body: "Your personal token is removed from this machine's keychain and offline docs are cleared.",
    local:
      "The machine stays registered: the worker keeps taking runs, and agent plans, projects and tools on this machine keep working. Paste a new token or sign in with the browser to come back.",
    confirm: "Sign out",
    busy: "Signing out…",
    cancel: "Cancel",
  },
};

/** Hỏi lại trước khi đăng xuất: token đã gỡ thì phải tạo token mới trên web mới đăng nhập lại được. */
export function SignOutDialog({
  open,
  onOpenChange,
  onSignedOut,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedOut: (status: AccountStatus) => void;
}) {
  const t = useT(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
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
