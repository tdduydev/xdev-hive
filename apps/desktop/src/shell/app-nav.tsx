import { ChevronsUpDownIcon, UserRoundIcon } from "lucide-react";
import { LogoIcon, Wordmark } from "@/components/logo.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { navItems, type Profile, type ScreenId } from "@/lib/nav.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{ aria: string; readOnly: string; folder: string; noFolder: string; notLinked: string }> = {
  vi: {
    aria: "Điều hướng app",
    readOnly: "chỉ đọc",
    folder: "Thư mục làm việc",
    noFolder: "Chưa chọn thư mục",
    notLinked: "Chưa liên kết tài khoản",
  },
  en: {
    aria: "App navigation",
    readOnly: "read-only",
    folder: "Working folder",
    noFolder: "No folder chosen",
    notLinked: "Account not linked",
  },
};

/**
 * Thanh điều hướng của app (AppNav.dc.html): logo, thư mục làm việc, mục theo quyền, người đang dùng. Cửa sổ hẹp
 * hơn 760px thì chỉ còn icon như bản `compact` của thiết kế.
 * Thư mục làm việc, trạng thái worker và người dùng chưa có nguồn dữ liệu (specs/008-desktop-v2 T004, T008, T023):
 * hiện trạng thái trống thay vì số liệu mẫu.
 */
export function AppNav({ profile, active }: { profile: Profile; active: ScreenId }) {
  const t = useT(text);
  const lang = useLang();
  return (
    <nav
      aria-label={t.aria}
      className="flex h-svh w-[220px] shrink-0 flex-col gap-1 border-r bg-sidebar px-2.5 py-3 text-sidebar-foreground max-[760px]:w-[60px] max-[760px]:px-2"
    >
      <div className="px-1.5 pb-2 max-[760px]:hidden">
        <Wordmark className="h-[34px]" />
      </div>
      <LogoIcon className="mx-auto mb-2.5 hidden max-[760px]:block" />
      <button
        type="button"
        disabled
        title={t.folder}
        className="mb-2 flex items-center gap-2 rounded-lg border bg-card px-2 py-1.5 text-left disabled:cursor-not-allowed max-[760px]:hidden"
      >
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-[11px] text-muted-foreground">{t.folder}</span>
          <span className="truncate font-mono text-xs">{t.noFolder}</span>
        </span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
      {navItems(profile).map((item) => {
        const current = item.id === active;
        return (
          <a
            key={item.id}
            href={`#/${item.id}`}
            aria-current={current ? "page" : undefined}
            title={item.label[lang]}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-foreground no-underline hover:bg-muted",
              "max-[760px]:mx-auto max-[760px]:w-9 max-[760px]:justify-center max-[760px]:px-0",
              current && "bg-accent font-semibold text-accent-foreground hover:bg-accent",
            )}
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="flex-1 max-[760px]:sr-only">{item.label[lang]}</span>
            {item.readOnly && (
              <span className="text-[10.5px] text-muted-foreground max-[760px]:hidden">{t.readOnly}</span>
            )}
          </a>
        );
      })}
      <div className="mt-auto flex items-center gap-2 border-t px-1 pt-2 max-[760px]:justify-center max-[760px]:px-0">
        <span
          title={t.notLinked}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <UserRoundIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="text-xs text-muted-foreground max-[760px]:sr-only">{t.notLinked}</span>
      </div>
    </nav>
  );
}
