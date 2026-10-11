import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { Brand } from "../components/icons.tsx";
import { meQuery } from "../lib/me.ts";
import { MeContext } from "./me-context.ts";
import { Sidebar } from "./sidebar.tsx";
import { SignOutButton } from "./sign-out-button.tsx";

/** Khung app theo mockup màn 3–5: sidebar bên trái, nội dung trang bên phải. Dưới 900px sidebar ẩn như mockup. */
export function AppShell() {
  const { data: me } = useSuspenseQuery(meQuery);
  const router = useRouter();
  // Phiên hết hạn (me tải lại ra null) thì chạy lại guard ở route gốc để về trang đăng nhập.
  useEffect(() => {
    if (!me) void router.invalidate();
  }, [me, router]);
  if (!me) return null;

  return (
    <MeContext value={me}>
      <div className="grid min-h-dvh app:grid-cols-[248px_minmax(0,1fr)]">
        <Sidebar className="hidden app:flex" />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 app:hidden">
            <Brand />
            <span className="ml-auto">
              <SignOutButton />
            </span>
          </div>
          <Outlet />
        </div>
      </div>
    </MeContext>
  );
}
