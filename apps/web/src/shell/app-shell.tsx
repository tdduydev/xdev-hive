import { Outlet } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../components/ui/sidebar.tsx";
import { AppSidebar } from "./sidebar.tsx";

/**
 * Khung app: sidebar shadcn (thu gọn còn biểu tượng trên máy tính, Ctrl/Cmd+B), nội dung trang bên phải. Trên điện
 * thoại sidebar thành menu trượt, mở bằng nút ở thanh trên.
 */
export function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur md:hidden">
          <SidebarTrigger />
          <img src="/xdev-hive-icon.svg" alt="" className="size-6" />
          <span className="font-heading text-sm font-semibold text-foreground">xDev Hive</span>
        </div>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
