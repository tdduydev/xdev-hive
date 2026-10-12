import { Outlet } from "@tanstack/react-router";
import { Brand } from "../components/icons.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Sidebar } from "./sidebar.tsx";
import { SignOutButton } from "./sign-out-button.tsx";

/** Khung app theo mockup màn 3–5: sidebar bên trái, nội dung trang bên phải. Dưới 900px sidebar ẩn như mockup. */
export function AppShell() {
  return (
    <div className="grid min-h-dvh app:grid-cols-[248px_minmax(0,1fr)]">
      <Sidebar className="hidden app:flex" />
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 app:hidden">
          <Brand />
          <span className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <SignOutButton />
          </span>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
