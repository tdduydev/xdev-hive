import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

type WithClass<P> = Omit<P, "className"> & { className?: string };

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

/** Khung dialog giữa màn hình, có lớp nền mờ. Base UI giữ focus trong dialog và trả focus khi đóng. */
export function DialogContent({ className, ...props }: WithClass<BaseDialog.Popup.Props>) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 bg-backdrop" />
      <BaseDialog.Popup
        className={cx(
          "fixed top-1/2 left-1/2 grid w-120 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3.5",
          "rounded-2xl border border-line-strong bg-surface p-5.5 text-body shadow-dialog",
          className,
        )}
        {...props}
      />
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: WithClass<BaseDialog.Title.Props>) {
  return <BaseDialog.Title className={cx("text-2xl font-bold text-ink", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: WithClass<BaseDialog.Description.Props>) {
  return <BaseDialog.Description className={cx("text-muted", className)} {...props} />;
}

export function DialogActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("flex justify-end gap-2", className)} {...props} />;
}
