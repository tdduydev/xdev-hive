import { Button } from "@xdev-hive/ui/button";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { OptimizePreviewDialog } from "@/components/optimize-preview-dialog.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import type { OptimizePolicies } from "@/lib/optimize-all.ts";

const text: Dict<{ label: string; hint: string }> = {
  vi: { label: "Tối ưu", hint: "Xem trước rồi tối ưu cả máy bằng một lần bấm" },
  en: { label: "Optimize", hint: "Preview, then optimize this whole machine in one click" },
};

/** Nút "Tối ưu" ở hàng đầu thẻ điểm (specs/029 US2). Bấm chỉ mở hộp xem trước, chưa ghi gì. */
export function OptimizeAllButton({
  policy,
  onDone,
  disabled,
}: {
  policy?: OptimizePolicies | null;
  /** Áp dụng hay hoàn tác xong thì gọi để thẻ điểm đọc lại số. */
  onDone?: () => void;
  disabled?: boolean;
}) {
  const t = useT(text);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" title={t.hint} disabled={disabled} onClick={() => setOpen(true)}>
        <SparklesIcon aria-hidden="true" />
        {t.label}
      </Button>
      <OptimizePreviewDialog open={open} onOpenChange={setOpen} policy={policy} onDone={onDone} />
    </>
  );
}
