import type { GateKind } from "@xdev-hive/contracts";
import { useLang } from "@/lib/i18n.ts";
import { KIND_CLASS, KIND_LABEL } from "@/lib/review-workflows.ts";
import { cn } from "@/lib/utils.ts";

/** Nhãn loại checkpoint, cùng màu ở màn quy trình và hàng chờ duyệt (Workflows.dc.html, DocReview.dc.html). */
export function GateKindBadge({ kind, className }: { kind: GateKind; className?: string }) {
  const lang = useLang();
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        KIND_CLASS[kind],
        className,
      )}
    >
      {KIND_LABEL[lang][kind]}
    </span>
  );
}
