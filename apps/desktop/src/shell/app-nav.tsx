import { Menu } from "@base-ui/react/menu";
import { ChevronsUpDownIcon, ChevronUpIcon, CloudOffIcon, LogOutIcon, UserRoundIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogoIcon, Wordmark } from "@/components/logo.tsx";
import { type Account, initials } from "@/lib/account.ts";
import { formatBuiltAt, useBuildInfo } from "@/lib/build-info.ts";
import { folderName, pickFolder, shortPath, useFolder } from "@/lib/folder.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { type HubFeatures, navGroups, type Profile, type ScreenId } from "@/lib/nav.ts";
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
  signIn: string;
  needsHubTitle: string;
  profiles: Record<Profile, string>;
  build: string;
  devBuild: string;
  details: string;
  accountMenu: string;
  accountItem: string;
  signOut: string;
}> = {
  vi: {
    aria: "Điều hướng app",
    readOnly: "chỉ đọc",
    folder: "Thư mục làm việc",
    noFolder: "Chưa chọn thư mục",
    pick: "Chọn thư mục làm việc",
    notLinked: "Chưa đăng nhập",
    signIn: "Đăng nhập để kết nối Hive",
    needsHubTitle: "Cần kết nối Hive",
    profiles: { dev: "Dev", writer: "Viết tài liệu", lead: "Trưởng nhóm" },
    build: "Bản đang chạy",
    devBuild: "bản dựng tại máy",
    details: "Worker và phiên bản",
    accountMenu: "Tài khoản Hive",
    accountItem: "Tài khoản và vai trò",
    signOut: "Đăng xuất khỏi Hive",
  },
  en: {
    aria: "App navigation",
    readOnly: "read-only",
    folder: "Working folder",
    noFolder: "No folder chosen",
    pick: "Choose a working folder",
    notLinked: "Not signed in",
    signIn: "Sign in to connect to Hive",
    needsHubTitle: "Needs a Hive connection",
    profiles: { dev: "Dev", writer: "Writer", lead: "Lead" },
    build: "Running build",
    devBuild: "local build",
    details: "Worker and version",
    accountMenu: "Hive account",
    accountItem: "Account and roles",
    signOut: "Sign out of Hive",
  },
};

/** Dưới ngưỡng này menu không đủ chỗ cho khối chân đầy đủ; cùng ngưỡng 760px với biến `compact` của chiều rộng. */
const SHORT_QUERY = "(max-height: 760px)";

function useShortWindow() {
  const [short, setShort] = useState(() => window.matchMedia?.(SHORT_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(SHORT_QUERY);
    if (!query) return;
    const sync = () => setShort(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return short;
}

/** Biết danh sách còn mục bị cắt ở đầu hoặc cuối để vẽ bóng mờ, vì thanh cuộn của hệ điều hành thường ẩn. */
function useScrollEdges(ref: React.RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref, measure]);
  return { ...edges, measure };
}

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
 * Chưa đăng nhập (`connected` false) thì mục cần hub vẫn hiện, chỉ mờ đi kèm biểu tượng mất kết nối: người dùng biết mục có đó
 * và vào được để thấy lời mời kết nối.
 */
export function AppNav({
  profile,
  active,
  account,
  onAccount,
  onSignOut,
  worker,
  compact = false,
  connected = true,
  features = {},
}: {
  profile: Profile;
  active: ScreenId;
  account?: Account | null;
  onAccount?: () => void;
  /** Đã đăng nhập: thẻ người dùng mở menu có "Đăng xuất khỏi Hive" thay vì mở thẳng hộp thoại tài khoản. */
  onSignOut?: (() => void) | undefined;
  worker?: WorkerView | null;
  /** Luôn chỉ còn icon (màn cần chỗ như Tài liệu từ code), không chỉ khi cửa sổ hẹp. */
  compact?: boolean;
  /** Đã đăng nhập Hive; chưa thì mục cần hub mờ đi kèm nhãn. */
  connected?: boolean;
  /** Tính năng hub đã dò được; mục của tính năng hub không có thì ẩn. */
  features?: HubFeatures;
}) {
  const t = useT(text);
  const lang = useLang();
  const [folder, setFolder] = useFolder();
  const short = useShortWindow();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(listRef);
  // Cửa sổ thấp mới gộp khối chân; thu gọn icon thì khối chân vốn chỉ còn một chấm và một avatar.
  const foldFooter = short && !compact;
  // Mục đang chọn có thể nằm dưới nếp cuộn (mở app ở màn cuối nhóm "Máy này"): cuộn vào tầm nhìn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chạy lại khi đổi màn hoặc đổi chiều cao còn lại của menu
  useEffect(() => {
    listRef.current?.querySelector("[aria-current=page]")?.scrollIntoView?.({ block: "nearest" });
  }, [active, foldFooter]);
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
      {/* Tiêu đề nhóm làm menu cao hơn; cửa sổ thấp thì cuộn danh sách thay vì đẩy nút tài khoản ra khỏi cửa sổ.
          Bóng mờ ở mép báo còn mục bị cắt, nếu không người dùng không biết bên dưới còn gì. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={edges.measure}
          className="flex h-full flex-col gap-1 overflow-y-auto overscroll-contain"
        >
          {navGroups(profile, undefined, features).map((group, index) => (
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
                const offline = !connected && !!item.hub;
                return (
                  <a
                    key={item.id}
                    href={`#/${item.id}`}
                    aria-current={current ? "page" : undefined}
                    title={offline ? `${item.label[lang]} · ${t.needsHubTitle}` : item.label[lang]}
                    data-offline={offline || undefined}
                    className={cn(
                      "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-foreground no-underline hover:bg-muted",
                      "compact:mx-auto compact:w-9 compact:justify-center compact:px-0",
                      offline && "text-muted-foreground",
                      current && "bg-accent font-semibold text-accent-foreground hover:bg-accent",
                    )}
                  >
                    <item.icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="flex-1 compact:sr-only">{item.label[lang]}</span>
                    {offline ? (
                      // Biểu tượng chứ không phải chữ, để tên mục cho trình đọc màn hình vẫn đúng tên màn.
                      <CloudOffIcon aria-hidden="true" className="size-3.5 text-muted-foreground compact:hidden" />
                    ) : (
                      item.readOnly && (
                        <span className="text-xs text-muted-foreground compact:hidden">{t.readOnly}</span>
                      )
                    )}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
        <div
          aria-hidden="true"
          data-edge="top"
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-5 border-t bg-gradient-to-b from-sidebar to-transparent transition-opacity",
            edges.top ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          aria-hidden="true"
          data-edge="bottom"
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-6 border-b bg-gradient-to-t from-sidebar to-transparent transition-opacity",
            edges.bottom ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      {foldFooter && (
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
        >
          {worker && (
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", WORKER_DOT[worker.kind])} />
          )}
          <span className="flex-1">{t.details}</span>
          <ChevronUpIcon
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", !detailsOpen && "rotate-180")}
          />
        </button>
      )}
      {(!foldFooter || detailsOpen) && (
        <>
          {worker && (
            <div
              role="status"
              title={worker.detail ?? undefined}
              className="flex flex-col gap-0.5 rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted-foreground compact:mx-auto compact:border-0 compact:p-0"
            >
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", WORKER_DOT[worker.kind])} />
                <span className="compact:sr-only">{workerSentence(worker.label)}</span>
              </span>
              {worker.hub && <span className="truncate font-mono compact:hidden">{new URL(worker.hub).host}</span>}
            </div>
          )}
          <BuildLine />
        </>
      )}
      <AccountFooter account={account ?? null} roleLine={roleLine} onAccount={onAccount} onSignOut={onSignOut} />
    </nav>
  );
}

const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground";

/**
 * Người đang dùng ở đáy menu. Đăng xuất nằm ngay ở đây, không chỉ trong hộp thoại tài khoản: người dùng tìm nút đăng
 * xuất ở thẻ người dùng như mọi app khác. Chưa có token thì không có gì để đăng xuất, bấm là mở thẳng hộp thoại.
 */
function AccountFooter({
  account,
  roleLine,
  onAccount,
  onSignOut,
}: {
  account: Account | null;
  roleLine: string;
  onAccount?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
}) {
  const t = useT(text);
  const body = (
    <>
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
        <span className="truncate text-xs text-muted-foreground">{account ? roleLine : t.signIn}</span>
      </span>
    </>
  );
  const title = account ? `${account.name} · ${roleLine}` : t.notLinked;
  // Vùng menu đã chiếm hết chỗ còn lại nên khối chân tự nằm ở đáy.
  const className =
    "mt-1 flex cursor-pointer items-center gap-2 border-t px-1 pt-2 text-left compact:justify-center compact:px-0";
  if (!onSignOut) {
    return (
      <button type="button" onClick={onAccount} title={title} className={className}>
        {body}
      </button>
    );
  }
  return (
    <Menu.Root>
      <Menu.Trigger title={title} className={className}>
        {body}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="isolate z-50 outline-none">
          <Menu.Popup
            aria-label={t.accountMenu}
            className="min-w-52 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <Menu.Item className={MENU_ITEM} onClick={onAccount}>
              <UserRoundIcon aria-hidden="true" className="size-4" />
              {t.accountItem}
            </Menu.Item>
            <Menu.Item
              className={cn(MENU_ITEM, "text-destructive data-highlighted:text-destructive")}
              onClick={onSignOut}
            >
              <LogOutIcon aria-hidden="true" className="size-4" />
              {t.signOut}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
