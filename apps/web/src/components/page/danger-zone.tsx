import { type ReactNode, useId } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ title: string }> = { vi: { title: "Vùng nguy hiểm" }, en: { title: "Danger zone" } };

/**
 * Khối cuối trang chi tiết hay trang cài đặt cho thao tác phá huỷ (xoá, thu hồi, gỡ), admin-layout.md § Thanh tiêu đề:
 * tách khỏi các ô sửa thường ngày và viền đỏ để người dùng biết trước khi bấm. Nút bên trong mở hộp xác nhận nêu tên
 * đối tượng, khối không tự hỏi.
 */
export function DangerZone({
  title,
  description,
  children,
}: {
  /** Mặc định "Vùng nguy hiểm". */
  title?: string;
  description?: ReactNode;
  /** Nút thao tác (`variant="destructive"`). */
  children: ReactNode;
}) {
  const t = useT(text);
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-card px-4 py-3.5 text-sm ring-1 ring-destructive/60 sm:px-5"
    >
      <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title ?? t.title}
        </h2>
        {description && <p className="text-xs text-pretty text-muted-foreground">{description}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}
