// The select-all line and the "Đã chọn N" bar of the Proposals and Memory pages (roadmap 18e); the inverse bar is the
// same one DataTable shows, so bulk actions look alike wherever they are.
import { cn } from "cn";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { errorMessage } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import type { BulkResult } from "#ui/lib/bulk.ts";

export function BulkBar({
  selectable,
  picked,
  busy,
  onPickAll,
  onClear,
  onApprove,
  onReject,
  className,
}: {
  /** How many items in the current view the person may pick. */
  selectable: number;
  picked: number;
  busy: boolean;
  onPickAll: () => void;
  onClear: () => void;
  onApprove: () => void;
  onReject: () => void;
  className?: string;
}) {
  const t = useT();
  if (!selectable) return null;
  const all = picked === selectable;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-fg-secondary">
        <Checkbox checked={all ? true : picked ? "indeterminate" : false} onCheckedChange={() => (all ? onClear() : onPickAll())} />
        {t("bulk.selectAll", { count: selectable })}
      </label>
      {picked ? (
        <div role="toolbar" aria-label={t("bulk.selected", { count: picked })} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-inverse px-3 py-2 text-[13px] text-fg-inverse">
          <span className="font-semibold">{t("bulk.selected", { count: picked })}</span>
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="h-7 cursor-pointer rounded-sm border border-danger-solid px-2.5 text-xs font-semibold text-[#FFB4B4] outline-none focus-visible:focus-ring disabled:cursor-default disabled:opacity-60"
          >
            {t("bulk.reject", { count: picked })}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onApprove}
            className="h-7 cursor-pointer rounded-sm border border-white/30 px-2.5 text-xs font-semibold outline-none hover:bg-white/10 focus-visible:focus-ring disabled:cursor-default disabled:opacity-60"
          >
            {t("bulk.approve", { count: picked })}
          </button>
          <button type="button" disabled={busy} onClick={onClear} className="h-7 cursor-pointer rounded-sm px-2 text-xs underline disabled:cursor-default">
            {t("bulk.clear")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** "Đã duyệt 3, bỏ qua 1 (xung đột): #12 docs/x" plus the ones that failed and why. */
export function bulkSummary<T>(t: TFunction, action: "approve" | "reject", r: BulkResult<T>, label: (item: T) => string): string {
  const parts = [t(action === "approve" ? "bulk.approved" : "bulk.rejected", { count: r.done.length })];
  if (r.conflicts.length) parts.push(t("bulk.skipped", { count: r.conflicts.length, items: r.conflicts.map(label).join(", ") }));
  if (r.failed.length) parts.push(t("bulk.failed", { count: r.failed.length, items: r.failed.map((f) => `${label(f.item)} (${errorMessage(f.error)})`).join(", ") }));
  return parts.join(", ");
}
