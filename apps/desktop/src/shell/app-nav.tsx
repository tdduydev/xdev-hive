import { ChevronsUpDownIcon, UserRoundIcon } from "lucide-react";
import { LogoIcon, Wordmark } from "@/components/logo.tsx";
import { type Account, initials } from "@/lib/account.ts";
import { formatBuiltAt, useBuildInfo } from "@/lib/build-info.ts";
import { folderName, pickFolder, shortPath, useFolder } from "@/lib/folder.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { navGroups, type Profile, type ScreenId } from "@/lib/nav.ts";
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
  build: string;
  devBuild: string;
}> = {
  vi: {
    aria: "Điều hướng app",
    readOnly: "chỉ đọc",
    folder: "Thư mục làm việc",
    noFolder: "Chưa chọn thư mục",
    pick: "Chọn thư mục làm việc",
    notLinked: "Chưa liên kết tài khoản",
    profiles: { dev: "Dev", writer: "Viết tài liệu", lead: "Trưởng nhóm" },
    build: "Bản đang chạy",
    devBuild: "bản dựng tại máy",
  },
  en: {
    aria: "App navigation",
    readOnly: "read-only",
    folder: "Working folder",
    noFolder: "No folder chosen",
    pick: "Choose a working folder",
    notLinked: "Account not linked",
    profiles: { dev: "Dev", writer: "Writer", lead: "Lead" },
    build: "Running build",
    devBuild: "local build",
  },
};

/** Phiên bản, mã commit và ngày build ở đáy menu; thu gọn thì chỉ còn trong tooltip của dòng. */
function BuildLine() {
  const t = useT(text);
  const build = useBuildInfo();
  const built = formatBuiltAt(build.builtAt);
  const label = `${build.version ? `v${build.version}` : t.devBuild} · ${build.sha} · ${built}`;
  return (
    <p title={`${t.build}: ${label}`} className="px-1 pt-1.5 text-xs text-muted-foreground compact:hidden">
      {label}
    </p>
  );
}

/**
 * Thanh điều hướng của app (AppNav.dc.html): logo, thư mục làm việc, mục theo quyền chia nhóm, người đang dùng. Cửa sổ
 * hẹp hơn 760px, hoặc màn cần chỗ (`compact`), thì chỉ còn icon như bản `compact` của thiết kế (biến thể `compact:`
 * trong styles.css); tiêu đề nhóm thành vạch ngăn.
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
  /** Luôn chỉ còn icon (màn cần chỗ như Tài liệu từ code), không chỉ khi cửa sổ hẹp. */
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
      className="flex h-full w-[220px] shrink-0 flex-col gap-1 border-r bg-sidebar px-2.5 py-3 text-sidebar-foreground compact:w-[60px] compact:px-2"
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
          <span className="truncate text-sm font-semibold">{folder ? folderName(folder) : t.noFolder}</span>
          <span className={cn("truncate text-xs text-muted-foreground", folder && "font-mono")}>
            {folder ? shortPath(folder) : t.folder}
          </span>
        </span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
      {/* Tiêu đề nhóm làm menu cao hơn; cửa sổ thấp thì cuộn danh sách thay vì đẩy nút tài khoản ra khỏi cửa sổ. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {navGroups(profile).map((group, index) => (
          // Tên nhóm nằm ở aria-label để trình đọc màn hình vẫn nghe được khi menu thu gọn mất tiêu đề.
          // biome-ignore lint/a11y/useSemanticElements: nhóm liên kết điều hướng, không phải ô nhập của form như fieldset
          <div
            key={group.id}
            role="group"
            aria-label={group.label[lang]}
            className={cn("flex flex-col gap-1", index > 0 && "compact:mt-1 compact:border-t compact:pt-2")}
          >
            {!compact && (
              <div
                aria-hidden="true"
                className={cn(
                  "px-2.5 pb-0.5 text-xs font-medium text-muted-foreground compact:hidden",
                  index > 0 && "pt-2.5",
                )}
              >
                {group.label[lang]}
              </div>
            )}
            {group.items.map((item) => {
              const current = item.id === active;
              return (
                <a
                  key={item.id}
                  href={`#/${item.id}`}
                  aria-current={current ? "page" : undefined}
                  title={item.label[lang]}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-foreground no-underline hover:bg-muted",
                    "compact:mx-auto compact:w-9 compact:justify-center compact:px-0",
                    current && "bg-accent font-semibold text-accent-foreground hover:bg-accent",
                  )}
                >
                  <item.icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="flex-1 compact:sr-only">{item.label[lang]}</span>
                  {item.readOnly && <span className="text-xs text-muted-foreground compact:hidden">{t.readOnly}</span>}
                </a>
              );
            })}
          </div>
        ))}
      </div>
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
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {initials(account.name || account.email)}
          </span>
        ) : (
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserRoundIcon aria-hidden="true" className="size-4" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col leading-tight compact:sr-only">
          <span className={cn("truncate text-sm", account ? "font-medium" : "text-muted-foreground")}>
            {account ? account.name || account.email : t.notLinked}
          </span>
          {account && <span className="truncate text-xs text-muted-foreground">{roleLine}</span>}
        </span>
      </button>
      <BuildLine />
    </nav>
  );
}
