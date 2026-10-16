import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Markdown } from "@xdev-hive/ui/markdown";
import { useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { type ReadyUpdate, relaunchToUpdate, useReadyUpdate } from "@/lib/update.ts";

const text: Dict<{
  ready: (version: string) => string;
  restart: string;
  restarting: string;
  notes: string;
  hide: string;
  close: string;
  title: (version: string) => string;
}> = {
  vi: {
    ready: (v) => `Đã tải bản ${v}. Mở lại để cập nhật.`,
    restart: "Mở lại để cập nhật",
    restarting: "Đang mở lại…",
    notes: "Xem thay đổi",
    hide: "Ẩn tạm",
    close: "Đóng",
    title: (v) => `Thay đổi trong bản ${v}`,
  },
  en: {
    ready: (v) => `Version ${v} is downloaded. Restart to update.`,
    restart: "Restart to update",
    restarting: "Restarting…",
    notes: "What's new",
    hide: "Hide for now",
    close: "Close",
    title: (v) => `What's new in ${v}`,
  },
};

/** Mở lại để cài bản đã tải: lỗi (hết dung lượng, đang thoát) thì báo và cho bấm lại. */
export function useRestart() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restart() {
    setBusy(true);
    setError(null);
    try {
      await relaunchToUpdate();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return { busy, error, restart };
}

/** Ghi chú phát hành của bản đã tải, viết bằng Markdown. */
export function UpdateNotes({
  ready,
  open,
  onOpenChange,
}: {
  ready: ReadyUpdate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT(text);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title(ready.version)}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto text-sm">
          <Markdown content={ready.notes ?? ""} />
        </div>
        <DialogActions>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.close}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dòng báo ở đầu cửa sổ khi Rust đã tải xong bản mới (sự kiện "update-ready"). Chưa tự mở lại: máy có thể đang có run
 * chạy, nên việc cài do người dùng chọn. "Ẩn tạm" chỉ ẩn bản này trong phiên; mở app lần sau dòng báo hiện lại.
 */
export function UpdateBanner() {
  const t = useT(text);
  const ready = useReadyUpdate();
  const [hidden, setHidden] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const { busy, error, restart } = useRestart();
  if (!ready || hidden === ready.version) return null;

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-success-soft px-5 py-2">
      <p className="min-w-0 flex-1 text-sm">{t.ready(ready.version)}</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {ready.notes && (
        <Button variant="ghost" size="sm" onClick={() => setNotesOpen(true)}>
          {t.notes}
        </Button>
      )}
      <Button size="sm" disabled={busy} onClick={() => void restart()}>
        {busy ? t.restarting : t.restart}
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setHidden(ready.version)}>
        {t.hide}
      </Button>
      {ready.notes && <UpdateNotes ready={ready} open={notesOpen} onOpenChange={setNotesOpen} />}
    </div>
  );
}
