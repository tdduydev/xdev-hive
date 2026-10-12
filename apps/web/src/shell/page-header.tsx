import type { ReactNode } from "react";
import { Separator } from "../components/ui/separator.tsx";
import { SidebarTrigger, useSidebarOptional } from "../components/ui/sidebar.tsx";

/** Thanh tiêu đề đầu mỗi trang trong khung app: nút thu gọn sidebar, breadcrumb, tiêu đề, nút thao tác bên phải. */
export function PageHeader({ crumb, title, children }: { crumb?: ReactNode; title: string; children?: ReactNode }) {
  const sidebar = useSidebarOptional();
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3 md:px-6">
      {sidebar && (
        <div className="hidden items-center gap-2 self-stretch md:flex">
          <SidebarTrigger className="-ml-1.5" />
          <Separator orientation="vertical" className="my-1" />
        </div>
      )}
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
