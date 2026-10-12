import { Outlet } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar.tsx";
import { AppSidebar } from "@/shell/sidebar.tsx";
import { Topbar } from "@/shell/topbar.tsx";

/**
 * Khung app theo Sidebar.dc.html và Topbar.dc.html: sidebar nhóm thu gọn được (Ctrl/Cmd+B thu còn biểu tượng; trên
 * điện thoại là menu trượt), thanh trên có đường dẫn, ⌘K, VI/EN, sáng/tối, thông báo.
 */
export function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <Topbar />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
