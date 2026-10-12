import { useState, useSyncExternalStore } from "react";
import { AccountDialog } from "@/components/account-dialog.tsx";
import { LangToggle } from "@/components/lang-toggle.tsx";
import { AccountContext, profileOf, useAccount } from "@/lib/account.ts";
import { useLang } from "@/lib/i18n.ts";
import { NAV_ITEMS, type Profile, screenFromHash } from "@/lib/nav.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState } from "@/lib/worker.ts";
import { FULL_BLEED, SCREENS } from "@/screens/index.ts";
import { AppNav } from "@/shell/app-nav.tsx";

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
  const worker = useWorkerState();
  const active = useSyncExternalStore(
    subscribe,
    () => screenFromHash(location.hash),
    () => "home" as const,
  );
  const item = NAV_ITEMS.find((i) => i.id === active) ?? NAV_ITEMS[0];
  const Screen = SCREENS[active];
  const bleed = !!Screen && FULL_BLEED.has(active);
  return (
    <div className="flex h-svh">
      <AppNav
        profile={profile}
        active={active}
        account={account}
        onAccount={() => setAccountOpen(true)}
        worker={worker}
        compact={bleed}
      />
      <AccountDialog open={accountOpen} status={status} onOpenChange={setAccountOpen} onChanged={setStatus} />
      <main className={cn("flex min-w-0 flex-1 flex-col", bleed ? "overflow-hidden" : "overflow-auto")}>
        <header className="flex h-13 items-center gap-3 border-b px-5">
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
  );
}
