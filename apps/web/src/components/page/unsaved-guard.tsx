import { useBlocker } from "@tanstack/react-router";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ title: string; body: string; stay: string; leave: string }> = {
  vi: {
    title: "Rời trang khi còn thay đổi chưa lưu?",
    body: "Các mục chưa bấm Lưu sẽ mất thay đổi. Ở lại để lưu từng mục, hoặc rời trang và bỏ các thay đổi đó.",
    stay: "Ở lại",
    leave: "Rời trang",
  },
  en: {
    title: "Leave with unsaved changes?",
    body: "Sections you have not saved will lose their changes. Stay to save them, or leave and discard them.",
    stay: "Stay",
    leave: "Leave page",
  },
};

/**
 * Hỏi lại khi rời trang cài đặt còn mục chưa lưu (admin-layout.md § Decisions 4): đổi trang trong app thì hiện hộp
 * thoại, đóng tab hay tải lại thì trình duyệt tự hỏi. Chỉ đổi `?tab=` hay `#mục` trên cùng trang thì không chặn: bản
 * nháp vẫn còn.
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const t = useT(text);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => when && current.pathname !== next.pathname,
    enableBeforeUnload: when,
    withResolver: true,
  });
  const open = blocker.status === "blocked";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && blocker.status === "blocked") blocker.reset();
      }}
    >
      <DialogContent>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.body}</DialogDescription>
        <DialogActions>
          <Button variant="outline" onClick={() => blocker.reset?.()}>
            {t.stay}
          </Button>
          <Button variant="destructive-solid" onClick={() => blocker.proceed?.()}>
            {t.leave}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
