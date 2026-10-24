import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { useEffect, useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { secretsList, secretsPurge } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  loading: string;
  none: string;
  count: (n: number) => string;
  keep: string;
  purge: string;
  purging: string;
  close: string;
  keptTitle: string;
  keptLead: string;
  doneTitle: string;
  done: (n: number) => string;
  leftTitle: string;
  leftLead: string;
  namesLabel: string;
}> = {
  vi: {
    title: "Xoá mọi bí mật khỏi kho?",
    lead: "Dùng trước khi xoá dữ liệu app hay gỡ cài app. Giá trị nằm trong kho của hệ điều hành, không nằm trong file của app, nên xoá file của app không xoá chúng.",
    loading: "Đang đọc danh sách bí mật…",
    none: "Máy này chưa lưu bí mật nào.",
    count: (n) => `Sẽ xoá ${n} bí mật, không khôi phục được:`,
    keep: "Giữ lại",
    purge: "Xoá mọi bí mật",
    purging: "Đang xoá…",
    close: "Đóng",
    keptTitle: "Các bí mật vẫn còn trong kho",
    keptLead:
      "Muốn xoá thì vào màn Bí mật của app, hoặc xoá thủ công trong kho của hệ điều hành (Credential Manager, Keychain hay Secret Service):",
    doneTitle: "Đã xoá bí mật khỏi kho",
    done: (n) => `Đã xoá ${n} bí mật.`,
    leftTitle: "Còn mục chưa xoá được",
    leftLead: "Các mục này vẫn còn trong kho; xoá ở màn Bí mật hay thủ công trong kho của hệ điều hành:",
    namesLabel: "Tên bí mật",
  },
  en: {
    title: "Delete every secret from the store?",
    lead: "Use this before clearing the app's data or uninstalling it. Values live in the OS store, not in the app's files, so deleting the app's files does not delete them.",
    loading: "Reading the secret list…",
    none: "No secret is stored on this machine.",
    count: (n) => `${n} ${n === 1 ? "secret" : "secrets"} will be deleted and cannot be recovered:`,
    keep: "Keep them",
    purge: "Delete every secret",
    purging: "Deleting…",
    close: "Close",
    keptTitle: "These secrets stay in the store",
    keptLead:
      "To delete them, open the app's Secrets screen, or delete them by hand in the OS store (Credential Manager, Keychain or Secret Service):",
    doneTitle: "Secrets deleted from the store",
    done: (n) => `Deleted ${n} ${n === 1 ? "secret" : "secrets"}.`,
    leftTitle: "Some entries could not be deleted",
    leftLead: "These entries are still in the store; delete them in the Secrets screen or by hand in the OS store:",
    namesLabel: "Secret names",
  },
};

type Phase = { kind: "ask" } | { kind: "kept" } | { kind: "done"; removed: number; left: string[] };

/**
 * Đề nghị xoá mọi bí mật khỏi kho khi xoá dữ liệu app hay gỡ cài app (FR-064). App chưa có chỗ "xoá dữ liệu" riêng nên
 * Cài đặt mở hộp này bằng nút; không chọn xoá thì hộp nói rõ mục nào còn lại. Chỉ có tên, không giá trị.
 */
export function SecretsCleanupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(text);
  const [names, setNames] = useState<string[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setNames(null);
    setPhase({ kind: "ask" });
    setError(null);
    secretsList().then(
      (got) => !stale && setNames(got.secrets.map((s) => s.name)),
      (e) => !stale && setError(errorText(e)),
    );
    return () => {
      stale = true;
    };
  }, [open]);

  async function purge() {
    setBusy(true);
    setError(null);
    try {
      const got = await secretsPurge({ all: true });
      setPhase({ kind: "done", removed: got.removed.length, left: got.left });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const list = (items: readonly string[]) => (
    <ul aria-label={t.namesLabel} className="m-0 flex max-h-40 list-none flex-wrap gap-1 overflow-auto p-0">
      {items.map((n) => (
        <li key={n}>
          <Pill className="font-mono">{n}</Pill>
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        {phase.kind === "ask" && (
          <>
            <DialogHeader>
              <DialogTitle>{t.title}</DialogTitle>
              <DialogDescription>{t.lead}</DialogDescription>
            </DialogHeader>
            {!names && !error && <p className="text-sm text-muted-foreground">{t.loading}</p>}
            {names && names.length === 0 && <p className="text-sm text-muted-foreground">{t.none}</p>}
            {names && names.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm">{t.count(names.length)}</p>
                {list(names)}
              </div>
            )}
          </>
        )}
        {phase.kind === "kept" && (
          <>
            <DialogHeader>
              <DialogTitle>{t.keptTitle}</DialogTitle>
              <DialogDescription>{t.keptLead}</DialogDescription>
            </DialogHeader>
            {list(names ?? [])}
          </>
        )}
        {phase.kind === "done" && (
          <>
            <DialogHeader>
              <DialogTitle>{phase.left.length > 0 ? t.leftTitle : t.doneTitle}</DialogTitle>
              <DialogDescription>{t.done(phase.removed)}</DialogDescription>
            </DialogHeader>
            {phase.left.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm">{t.leftLead}</p>
                {list(phase.left)}
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {phase.kind === "ask" && names && names.length > 0 ? (
            <>
              {/* Giữ lại là nút được focus đầu: Enter nhầm không xoá bí mật. */}
              <Button variant="outline" autoFocus disabled={busy} onClick={() => setPhase({ kind: "kept" })}>
                {t.keep}
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void purge()}>
                {busy ? t.purging : t.purge}
              </Button>
            </>
          ) : (
            <Button variant="outline" autoFocus disabled={busy} onClick={onClose}>
              {t.close}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
