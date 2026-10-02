// A large popup for one item's details (roadmap 30b, asked 2/10): a side panel next to a table left both too narrow
// to read a review's verdict, a log or a machine's setup. The list keeps its full width behind it.
import type { ReactNode } from "react";
import { cn } from "cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";

export function DetailDialog({
  open,
  onClose,
  title,
  description,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** For screen readers: the content shows its own heading. */
  title: string;
  description?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className={cn("flex h-[85vh] w-[min(1100px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-none", className)}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
