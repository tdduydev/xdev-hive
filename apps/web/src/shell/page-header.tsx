import type { ReactNode } from "react";

/** Thanh tiêu đề đầu mỗi trang trong khung app: breadcrumb, tiêu đề, nút thao tác bên phải. */
export function PageHeader({ crumb, title, children }: { crumb?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-4">
      <div className="min-w-0">
        {crumb && <div className="text-sm text-muted">{crumb}</div>}
        <h1 className="font-display text-3xl font-semibold break-words text-ink">{title}</h1>
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-3">{children}</div>}
    </header>
  );
}

/** Nội dung trang. Cột `minmax(0, 1fr)` để bảng rộng cuộn trong khung của nó, không đẩy cả trang cuộn ngang. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 p-6">{children}</div>;
}
