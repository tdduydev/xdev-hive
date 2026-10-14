import { type ReactNode, useId } from "react";
import { cx } from "@/lib/cx.ts";

/**
 * Một khối nội dung có tiêu đề trong PageBody (admin-layout.md § Khối trang): tiêu đề h2, một câu mô tả, nút của riêng
 * khối bên phải. Khối không tự vẽ card; bảng hay card bên trong tự có viền, để hai lớp viền không lồng nhau.
 */
export function PageSection({
  id,
  title,
  description,
  actions,
  className,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={cx("grid min-w-0 scroll-mt-20 gap-3", className)}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
