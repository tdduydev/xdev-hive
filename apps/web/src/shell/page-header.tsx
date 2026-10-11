import type { ReactNode } from "react";

/** Thanh tiêu đề đầu mỗi trang trong khung app: breadcrumb, tiêu đề, nút thao tác bên phải. */
export function PageHeader({ crumb, title, children }: { crumb?: string; title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-4">
      <div>
        {crumb && <div className="text-sm text-muted">{crumb}</div>}
        <h1 className="font-display text-3xl font-semibold text-ink">{title}</h1>
      </div>
      {children && <div className="ml-auto flex items-center gap-3">{children}</div>}
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="grid content-start gap-4 p-6">{children}</div>;
}
