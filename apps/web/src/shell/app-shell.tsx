import { Outlet, useLocation } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar.tsx";
import { inAdminArea } from "@/lib/nav.ts";
import { AdminFrame } from "@/shell/admin-nav.tsx";
import { AppSidebar } from "@/shell/sidebar.tsx";
import { Topbar } from "@/shell/topbar.tsx";

/**
 * Khung app theo Sidebar.dc.html và Topbar.dc.html: sidebar nhóm thu gọn được (Ctrl/Cmd+B thu còn biểu tượng; trên
 * điện thoại là menu trượt), thanh trên có đường dẫn, ⌘K, VI/EN, sáng/tối, thông báo. Trang quản trị có thêm menu
 * Quản trị bên trái nội dung (AdminFrame).
 */
export function AppShell() {
  const { pathname } = useLocation();
  const inAdmin = inAdminArea(pathname);
  const [workOpen, setWorkOpen] = useState(true);
  const [adminOpen, setAdminOpen] = useState(() => {
    try {
      return localStorage.getItem("hive.nav.admin-expanded") === "true";
    } catch {
      return false;
    }
  });
  function setOpen(open: boolean) {
    if (!inAdmin) return setWorkOpen(open);
    setAdminOpen(open);
    try {
      localStorage.setItem("hive.nav.admin-expanded", String(open));
    } catch {
      // Chặn lưu trữ không được làm mất khả năng mở menu trong phiên này.
    }
  }
  return (
    <SidebarProvider
      open={inAdmin ? adminOpen : workOpen}
      onOpenChange={setOpen}
      style={{ "--sidebar-width-icon": inAdmin ? "3.5rem" : "3rem" } as CSSProperties}
    >
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
