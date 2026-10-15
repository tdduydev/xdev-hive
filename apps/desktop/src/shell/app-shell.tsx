import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AccountDialog } from "@/components/account-dialog.tsx";
import { ConnectHive } from "@/components/connect-hive.tsx";
import { LangToggle } from "@/components/lang-toggle.tsx";
import { UpdateBanner } from "@/components/update-banner.tsx";
import { AccountContext, ConnectContext, profileOf, useAccount } from "@/lib/account.ts";
import { useArtifactsCapability } from "@/lib/artifacts-env.tsx";
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
 * Cửa sổ app cục bộ: AppNav bên trái, màn theo `#/<id>` bên phải. App là client, không bắt đăng nhập: mở thẳng giao
 * diện chính, màn tại máy dùng đủ; màn chỉ có dữ liệu trên hub thì mời kết nối Hive khi chưa liên kết tài khoản. Hồ sơ
 * menu tính từ vai trò của tài khoản đã liên kết (token cá nhân trong keychain); chưa liên kết thì dev. Hồ sơ chỉ quyết
 * định menu, hub kiểm từng thao tác.
 */
export function AppShell({ profile: forced }: { profile?: Profile }) {
  const { status, error, refresh, setStatus } = useAccount();
  const [accountOpen, setAccountOpen] = useState(false);
  const account = status?.account ?? null;
  const profile = forced ?? profileOf(account);
  const lang = useLang();
  const t = useT(text);
  const worker = useWorkerState();
  const artifacts = useArtifactsCapability(!!account);
  // Máy vừa đăng ký ở cửa sổ khác (khay → Bật worker): hub của worker đổi thì đọc lại tài khoản, không bắt mở lại app.
  const workerHub = worker?.hub ?? null;
  useEffect(() => {
    if (workerHub && status && status.hub !== workerHub) void refresh();
  }, [workerHub, status, refresh]);
  const active = useSyncExternalStore(
    subscribe,
    () => screenFromHash(location.hash),
    () => "home" as const,
  );
  const item = NAV_ITEMS.find((i) => i.id === active) ?? NAV_ITEMS[0];
  // Đang đọc trạng thái tài khoản thì chưa vẽ màn hub, để không loé lời mời kết nối với người đã đăng nhập.
  const checked = status !== null || error !== null;
  const needsHub = !!item?.hub && !account;
  const Screen = needsHub ? (checked ? ConnectHive : Pending) : SCREENS[active];
  const bleed = !!Screen && !needsHub && FULL_BLEED.has(active);
  // Người dùng chưa chọn thì menu tự thu gọn ở màn cần chỗ; đã chọn thì giữ lựa chọn ở mọi màn.
  const collapsed = useNavCollapsed() ?? bleed;
  const openAccount = () => setAccountOpen(true);
  return (
    <div className="flex h-svh flex-col">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <AppNav
          profile={profile}
          active={active}
          account={account}
          onAccount={openAccount}
          connected={!!account}
          worker={worker}
          compact={collapsed}
          features={artifacts === undefined ? {} : { artifacts }}
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
              <ConnectContext.Provider value={openAccount}>
                <Screen />
              </ConnectContext.Provider>
            </AccountContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}

function Pending() {
  return null;
}
