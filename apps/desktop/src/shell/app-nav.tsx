import { ChevronsUpDownIcon, UserRoundIcon } from "lucide-react";
import { LogoIcon, Wordmark } from "@/components/logo.tsx";
import { type Account, initials } from "@/lib/account.ts";
import { folderName, pickFolder, shortPath, useFolder } from "@/lib/folder.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { navItems, type Profile, type ScreenId } from "@/lib/nav.ts";
import type { WorkerView } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";
import { WORKER_DOT, workerSentence } from "@/lib/worker.ts";

const text: Dict<{
  aria: string;
  readOnly: string;
  folder: string;
  noFolder: string;
  pick: string;
  notLinked: string;
  profiles: Record<Profile, string>;
}> = {
  vi: {
    aria: "Điều hướng app",
    readOnly: "chỉ đọc",
    folder: "Thư mục làm việc",
    noFolder: "Chưa chọn thư mục",
    pick: "Chọn thư mục làm việc",
    notLinked: "Chưa liên kết tài khoản",
    profiles: { dev: "Dev", writer: "Viết tài liệu", lead: "Trưởng nhóm" },
  },
  en: {
    aria: "App navigation",
    readOnly: "read-only",
    folder: "Working folder",
    noFolder: "No folder chosen",
    pick: "Choose a working folder",
    notLinked: "Account not linked",
    profiles: { dev: "Dev", writer: "Writer", lead: "Lead" },
  },
};

/**
 * Thanh điều hướng của app (AppNav.dc.html): logo, thư mục làm việc, mục theo quyền, người đang dùng. Cửa sổ hẹp
 * hơn 760px, hoặc màn cần chỗ (`compact`), thì chỉ còn icon như bản `compact` của thiết kế (biến thể `compact:` trong
 * styles.css).
 * Thư mục làm việc, trạng thái worker và người dùng chưa có nguồn dữ liệu (specs/008-desktop-v2 T004, T008, T023):
 * hiện trạng thái trống thay vì số liệu mẫu.
 */
export function AppNav({
  profile,
  active,
  account,
  onAccount,
  worker,
  compact = false,
}: {
  profile: Profile;
  active: ScreenId;
  account?: Account | null;
  onAccount?: () => void;
  worker?: WorkerView | null;
  /** Luôn chỉ còn icon (màn cần chỗ như Tài liệu), không chỉ khi cửa sổ hẹp. */
  compact?: boolean;
}) {
  const t = useT(text);
  const lang = useLang();
  const [folder, setFolder] = useFolder();
  const roleLine = account ? `${t.profiles[profile]} · ${account.teams[0]?.name ?? account.orgName}` : "";
  return (
    <nav
      aria-label={t.aria}
      data-compact={compact || undefined}
      className="flex h-svh w-[220px] shrink-0 flex-col gap-1 border-r bg-sidebar px-2.5 py-3 text-sidebar-foreground compact:w-[60px] compact:px-2"
    >
      <div className="px-1.5 pb-2 compact:hidden">
        <Wordmark className="h-[34px]" />
      </div>
      <LogoIcon className="mx-auto mb-2.5 hidden compact:block" />
      <button
        type="button"
        title={folder || t.folder}
        aria-label={`${t.folder}: ${folder ? folderName(folder) : t.noFolder}`}
        onClick={async () => {
          try {
            const picked = await pickFolder(t.pick);
            if (picked) setFolder(picked);
          } catch {
            /* Ngoài Tauri không có bộ chọn thư mục; các màn vẫn cho nhập tay. */
          }
        }}
        className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg border bg-card px-2 py-1.5 text-left hover:bg-muted compact:hidden"
      >
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-mono text-[12.5px] font-semibold">
            {folder ? folderName(folder) : t.noFolder}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {folder ? shortPath(folder) : t.folder}
          </span>
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
              "compact:mx-auto compact:w-9 compact:justify-center compact:px-0",
              current && "bg-accent font-semibold text-accent-foreground hover:bg-accent",
            )}
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="flex-1 compact:sr-only">{item.label[lang]}</span>
            {item.readOnly && <span className="text-[10.5px] text-muted-foreground compact:hidden">{t.readOnly}</span>}
          </a>
        );
      })}
      {worker && (
        <div
          role="status"
          title={worker.detail ?? undefined}
          className="mt-auto flex flex-col gap-0.5 rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted-foreground compact:mx-auto compact:border-0 compact:p-0"
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", WORKER_DOT[worker.kind])} />
            <span className="compact:sr-only">{workerSentence(worker.label)}</span>
          </span>
          {worker.hub && <span className="truncate font-mono compact:hidden">{new URL(worker.hub).host}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onAccount}
        title={account ? `${account.name} · ${roleLine}` : t.notLinked}
        className={cn(
          "flex cursor-pointer items-center gap-2 border-t px-1 pt-2 text-left compact:justify-center compact:px-0",
          // Thẻ worker đã đẩy khối cuối xuống đáy; hai mt-auto sẽ chia đôi khoảng trống.
          worker ? "mt-2" : "mt-auto",
        )}
      >
        {account ? (
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
            {initials(account.name || account.email)}
          </span>
        ) : (
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserRoundIcon aria-hidden="true" className="size-4" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col leading-tight compact:sr-only">
          <span className={cn("truncate text-[13px]", account ? "font-medium" : "text-muted-foreground")}>
            {account ? account.name || account.email : t.notLinked}
          </span>
          {account && <span className="truncate text-[11.5px] text-muted-foreground">{roleLine}</span>}
        </span>
      </button>
    </nav>
  );
}
