import type { ReactNode } from "react";

/** Tiêu đề đầu mỗi trang (Main.dc.html): đường dẫn phụ, tiêu đề, nút thao tác bên phải. Đường dẫn chính ở Topbar. */
export function PageHeader({ crumb, title, children }: { crumb?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end gap-3 px-4 pt-5 pb-1 md:px-6">
      <div className="min-w-0">
        {crumb && <div className="text-xs text-muted-foreground">{crumb}</div>}
        <h1 className="font-heading text-xl font-semibold break-words text-foreground">{title}</h1>
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** Nội dung trang. Cột `minmax(0, 1fr)` để bảng rộng cuộn trong khung của nó, không đẩy cả trang cuộn ngang. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 p-4 md:p-6">{children}</div>;
}
