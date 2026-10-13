import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { AccountDialog } from "@/components/account-dialog.tsx";
import { LangToggle } from "@/components/lang-toggle.tsx";
import { UpdateBanner } from "@/components/update-banner.tsx";
import { AccountContext, profileOf, useAccount } from "@/lib/account.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { NAV_ITEMS, type Profile, screenFromHash } from "@/lib/nav.ts";
import { setNavCollapsed, useNavCollapsed } from "@/lib/nav-collapsed.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState } from "@/lib/worker.ts";
import { FULL_BLEED, SCREENS } from "@/screens/index.ts";
import { AppNav } from "@/shell/app-nav.tsx";

const text: Dict<{ collapse: string; expand: string }> = {
  vi: { collapse: "Thu gọn menu", expand: "Mở rộng menu" },
  en: { collapse: "Collapse menu", expand: "Expand menu" },
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/**
 * Cửa sổ app cục bộ: AppNav bên trái, màn theo `#/<id>` bên phải. Hồ sơ menu tính từ vai trò của tài khoản đã liên kết
 * (token cá nhân trong keychain); chưa liên kết thì dev. Hồ sơ chỉ quyết định menu, hub kiểm từng thao tác.
 */
export function AppShell({ profile: forced }: { profile?: Profile }) {
  const { status, setStatus } = useAccount();
  const [accountOpen, setAccountOpen] = useState(false);
  const account = status?.account ?? null;
  const profile = forced ?? profileOf(account);
  const lang = useLang();
  const t = useT(text);
  const worker = useWorkerState();
  const active = useSyncExternalStore(
    subscribe,
    () => screenFromHash(location.hash),
    () => "home" as const,
  );
  const item = NAV_ITEMS.find((i) => i.id === active) ?? NAV_ITEMS[0];
  const Screen = SCREENS[active];
  const bleed = !!Screen && FULL_BLEED.has(active);
  // Người dùng chưa chọn thì menu tự thu gọn ở màn cần chỗ; đã chọn thì giữ lựa chọn ở mọi màn.
  const collapsed = useNavCollapsed() ?? bleed;
  return (
    <div className="flex h-svh flex-col">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <AppNav
          profile={profile}
          active={active}
          account={account}
          onAccount={() => setAccountOpen(true)}
          worker={worker}
          compact={collapsed}
        />
        <AccountDialog open={accountOpen} status={status} onOpenChange={setAccountOpen} onChanged={setStatus} />
        <main className={cn("flex min-w-0 flex-1 flex-col", bleed ? "overflow-hidden" : "overflow-auto")}>
          <header className="flex h-13 items-center gap-3 border-b px-5">
            <button
              type="button"
              aria-label={collapsed ? t.expand : t.collapse}
              title={collapsed ? t.expand : t.collapse}
              aria-expanded={!collapsed}
              onClick={() => setNavCollapsed(!collapsed)}
              className="-ml-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
              ) : (
                <PanelLeftCloseIcon aria-hidden="true" className="size-4" />
              )}
            </button>
            <h1 className="flex-1 truncate font-heading text-base font-semibold">{item?.label[lang]}</h1>
            <LangToggle />
          </header>
          <div className={bleed ? "flex min-h-0 flex-1" : "p-5"}>
            <AccountContext.Provider value={account}>
              <Screen />
            </AccountContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
