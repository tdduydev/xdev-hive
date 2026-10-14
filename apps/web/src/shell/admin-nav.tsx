import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { activeNavItem, inAdminArea, NAV_ADMIN, type NavGroup, visibleGroups } from "@/lib/nav.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useOrgs } from "@/shell/org-context.ts";

const text: Dict<{ nav: string; back: string; pick: string }> = {
  vi: { nav: "Điều hướng quản trị", back: "Quay lại trang trước khi vào Quản trị", pick: "Chọn trang quản trị" },
  en: { nav: "Admin navigation", back: "Back to where you were before Admin", pick: "Choose an admin page" },
};

/*
 * Trang ngoài khu quản trị mở gần nhất, cho nút ← của menu. Giữ ở module: chỉ cần sống trong một phiên trang, tải lại
 * thì về Tổng quan là đủ.
 */
let lastAppHref = "/";

/**
 * Khung của khu quản trị (admin-layout.md § Decisions 1): đường dẫn thuộc menu Quản trị thì hiện menu trái thứ hai
 * (208 px, từ 1024 px) hoặc ô chọn trang (dưới 1024 px) cạnh nội dung; trang khác giữ nguyên.
 */
export function AdminFrame({ children }: { children: ReactNode }) {
  const { pathname, href } = useLocation();
  const { current } = useOrgs();
  const admin = current !== null && inAdminArea(pathname);
  useEffect(() => {
    if (!admin) lastAppHref = href;
  }, [admin, href]);
  if (!admin) return children;
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <AdminNav />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function useAdminGroups(): NavGroup[] {
  const { current } = useOrgs();
  const can = usePermissions();
  return visibleGroups(current !== null && isOrgAdmin(current.org.role), can).filter((g) => g.area === "admin");
}

function BackLink({ className }: { className?: string }) {
  const t = useT(text);
  const lang = useLang();
  const navigate = useNavigate();
  // Thẻ <a> thường vì đích là cả href đã lưu (có ?…), Link của router chỉ nhận đường dẫn theo route.
  return (
    <a
      href={lastAppHref}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        void navigate({ href: lastAppHref });
      }}
      aria-label={t.back}
      title={t.back}
      className={cx(
        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{NAV_ADMIN.label[lang]}</span>
    </a>
  );
}

function AdminNav() {
  const t = useT(text);
  const lang = useLang();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const groups = useAdminGroups();
  const active = activeNavItem(pathname);
  const pickId = useId();
  return (
    <>
      <aside className="hidden w-52 shrink-0 border-r border-border lg:block">
        <div className="sticky top-13 grid max-h-[calc(100svh-3.25rem)] content-start gap-4 overflow-y-auto px-3 py-4">
          <BackLink />
          <nav aria-label={t.nav} className="grid gap-4">
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`${pickId}-${group.id}`} className="grid gap-0.5">
                <h2 id={`${pickId}-${group.id}`} className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.label[lang]}
                </h2>
                {group.items.map((item) => {
                  const on = item.id === active?.id;
                  return (
                    <Link
                      key={item.id}
                      to={item.to}
                      aria-current={on ? "page" : undefined}
                      className={cx(
                        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4 [&_svg]:shrink-0",
                        on
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <item.icon aria-hidden="true" />
                      <span className="truncate">{item.label[lang]}</span>
                    </Link>
                  );
                })}
              </section>
            ))}
          </nav>
        </div>
      </aside>
      {/* Dưới 1024 px không đủ chỗ cho cột thứ hai: menu thành ô chọn trang ngay trên tiêu đề, vẫn đủ nhóm. */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-2 md:px-4 lg:hidden">
        <BackLink className="shrink-0" />
        <label htmlFor={pickId} className="sr-only">
          {t.pick}
        </label>
        <NativeSelect
          id={pickId}
          className="max-w-72"
          value={active?.id ?? ""}
          onChange={(e) => {
            const item = groups.flatMap((g) => g.items).find((i) => i.id === e.currentTarget.value);
            if (item) void navigate({ to: item.to });
          }}
        >
          {groups.map((group) => (
            <NativeSelectOptGroup key={group.id} label={group.label[lang]}>
              {group.items.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label[lang]}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          ))}
        </NativeSelect>
      </div>
    </>
  );
}
