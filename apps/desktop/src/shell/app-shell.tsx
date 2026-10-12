import { ConstructionIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { AccountDialog } from "@/components/account-dialog.tsx";
import { LangToggle } from "@/components/lang-toggle.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty.tsx";
import { AccountContext, profileOf, useAccount } from "@/lib/account.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { NAV_ITEMS, type Profile, screenFromHash } from "@/lib/nav.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState } from "@/lib/worker.ts";
import { FULL_BLEED, SCREENS } from "@/screens/index.ts";
import { AppNav } from "@/shell/app-nav.tsx";

const text: Dict<{ soon: string; body: (design: string) => string }> = {
  vi: {
    soon: "Sắp có",
    body: (design) => `Màn này đã có thiết kế (docs/design-system/screens/${design}) và đang được làm.`,
  },
  en: {
    soon: "Coming soon",
    body: (design) => `This screen is designed (docs/design-system/screens/${design}) and in progress.`,
  },
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
  const t = useT(text);
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
          {Screen ? (
            <AccountContext.Provider value={account}>
              <Screen />
            </AccountContext.Provider>
          ) : (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ConstructionIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle role="heading" aria-level={2}>
                  {t.soon}
                </EmptyTitle>
                <EmptyDescription>{item && t.body(item.design)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </main>
    </div>
  );
}
