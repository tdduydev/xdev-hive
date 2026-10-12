import { ConstructionIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { LangToggle } from "../components/lang-toggle.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { type Dict, useLang, useT } from "../lib/i18n.ts";
import { NAV_ITEMS, type Profile, screenFromHash } from "../lib/nav.ts";
import { SCREENS } from "../screens/index.ts";
import { AppNav } from "./app-nav.tsx";

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
 * Cửa sổ app cục bộ: AppNav bên trái, màn theo `#/<id>` bên phải. Chưa có danh tính người dùng (token cá nhân,
 * specs/008-desktop-v2 T023) nên hồ sơ mặc định là dev; hồ sơ chỉ quyết định menu.
 */
export function AppShell({ profile = "dev" }: { profile?: Profile }) {
  const t = useT(text);
  const lang = useLang();
  const active = useSyncExternalStore(
    subscribe,
    () => screenFromHash(location.hash),
    () => "home" as const,
  );
  const item = NAV_ITEMS.find((i) => i.id === active) ?? NAV_ITEMS[0];
  const Screen = SCREENS[active];
  return (
    <div className="flex h-svh">
      <AppNav profile={profile} active={active} />
      <main className="flex min-w-0 flex-1 flex-col overflow-auto">
        <header className="flex h-13 items-center gap-3 border-b px-5">
          <h1 className="flex-1 truncate font-heading text-base font-semibold">{item?.label[lang]}</h1>
          <LangToggle />
        </header>
        <div className="p-5">
          {Screen ? (
            <Screen />
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
