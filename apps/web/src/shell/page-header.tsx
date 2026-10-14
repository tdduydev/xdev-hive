import { Tabs } from "@base-ui/react/tabs";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

/**
 * Bề rộng nội dung theo docs/design-system/admin-layout.md: bảng dùng hết chỗ, trang đọc và chi tiết giới hạn để dòng
 * chữ không quá dài trên màn 2K, form cài đặt hẹp hơn để mắt không phải đi xa giữa nhãn và ô.
 */
export type PageWidth = "full" | "wide" | "form";

const WIDTH: Record<PageWidth, string> = {
  full: "",
  wide: "max-w-[1360px]",
  form: "max-w-[1120px]",
};

/**
 * Tiêu đề đầu mỗi trang (admin-layout.md § Thanh tiêu đề): đường dẫn phụ, tiêu đề, một câu mô tả, dòng meta nhỏ và
 * nút thao tác bên phải. Đường dẫn chính ở Topbar. Nút chính đứng cuối hàng thao tác, nút phụ (outline/ghost) trước nó.
 */
export function PageHeader({
  crumb,
  title,
  description,
  meta,
  width = "full",
  children,
}: {
  crumb?: ReactNode;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  width?: PageWidth;
  children?: ReactNode;
}) {
  return (
    <header className="px-4 pt-5 pb-1 md:px-6 md:pt-6">
      <div className={cx("flex flex-wrap items-start gap-x-6 gap-y-3", WIDTH[width])}>
        <div className="grid min-w-0 flex-1 basis-80 gap-1">
          {crumb && <div className="text-xs text-muted-foreground">{crumb}</div>}
          <h1 className="font-heading text-xl font-semibold tracking-tight break-words text-foreground">{title}</h1>
          {description && <p className="max-w-3xl text-sm text-pretty text-muted-foreground">{description}</p>}
          {meta && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">{meta}</div>
          )}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{children}</div>}
      </div>
    </header>
  );
}

/**
 * Đầu trang chi tiết (admin-layout.md § Decisions 3): link ← về danh sách, tên đối tượng cùng huy hiệu trạng thái, nút
 * thao tác (nút phụ, nút chính, rồi ⋯) bên phải, một dòng số liệu/meta. Tab của trang (`PageTabList`) đặt ngay dưới.
 */
export function DetailHeader({
  back,
  title,
  leading,
  status,
  meta,
  width = "wide",
  children,
}: {
  /** Danh sách chứa đối tượng; tên danh sách là chữ của link. */
  back: { to: NonNullable<LinkProps["to"]>; label: string };
  title: string;
  /** Ô nhận diện trước tên (ô màu của đội, avatar). */
  leading?: ReactNode;
  /** Huy hiệu trạng thái (`Pill`) cạnh tên. */
  status?: ReactNode;
  meta?: ReactNode;
  width?: PageWidth;
  children?: ReactNode;
}) {
  return (
    <header className="px-4 pt-4 pb-1 md:px-6 md:pt-5">
      <div className={cx("grid gap-2", WIDTH[width])}>
        <Link
          to={back.to}
          className="-ml-1 flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          {back.label}
        </Link>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-80 items-center gap-3">
            {leading}
            <div className="grid min-w-0 gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <h1 className="font-heading text-xl font-semibold tracking-tight break-words text-foreground">
                  {title}
                </h1>
                {status}
              </div>
              {meta && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div>
              )}
            </div>
          </div>
          {children && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{children}</div>}
        </div>
      </div>
    </header>
  );
}

/** Nội dung trang. Cột `minmax(0, 1fr)` để bảng rộng cuộn trong khung của nó, không đẩy cả trang cuộn ngang. */
export function PageBody({
  width = "full",
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx("grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 p-4 md:p-6", WIDTH[width], className)}
    >
      {children}
    </div>
  );
}

/**
 * Tab cấp trang, nằm ngay dưới PageHeader và kéo viền dưới hết bề ngang. Dùng trong `<Tabs.Root>` của Base UI để
 * panel nằm trong PageBody; số đếm là huy hiệu cạnh nhãn, không ghép vào chữ.
 */
export function PageTabList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tabs.List
      aria-label={label}
      className="mt-3 flex gap-1 overflow-x-auto border-b border-border px-2 [scrollbar-width:none] md:px-4"
    >
      {children}
    </Tabs.List>
  );
}

export function PageTab({
  value,
  count,
  tone = "neutral",
  children,
}: {
  value: string;
  count?: number | undefined;
  /** `warning` khi số đếm là việc đang chờ người xử lý (chờ duyệt, lỗi gửi). */
  tone?: "neutral" | "warning";
  children: ReactNode;
}) {
  return (
    <Tabs.Tab
      value={value}
      className="-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-2.5 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-active:border-primary data-active:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-60"
    >
      {children}
      {count !== undefined && (
        <>
          {" "}
          <span
            className={cx(
              "min-w-5 rounded-full px-1.5 text-center text-xs leading-5 tabular-nums",
              tone === "warning" && count > 0 ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground",
            )}
          >
            {count}
          </span>
        </>
      )}
    </Tabs.Tab>
  );
}
