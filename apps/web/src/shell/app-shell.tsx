import { Outlet } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar.tsx";
import { AdminFrame } from "@/shell/admin-nav.tsx";
import { AppSidebar } from "@/shell/sidebar.tsx";
import { Topbar } from "@/shell/topbar.tsx";

/**
 * Khung app theo Sidebar.dc.html và Topbar.dc.html: sidebar nhóm thu gọn được (Ctrl/Cmd+B thu còn biểu tượng; trên
 * điện thoại là menu trượt), thanh trên có đường dẫn, ⌘K, VI/EN, sáng/tối, thông báo. Trang quản trị có thêm menu
 * Quản trị bên trái nội dung (AdminFrame).
 */
export function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <Topbar />
        <AdminFrame>
          <Outlet />
        </AdminFrame>
      </SidebarInset>
    </SidebarProvider>
  );
}
