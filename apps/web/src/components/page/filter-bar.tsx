import { Input } from "@xdev-hive/ui/input";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

/**
 * Thanh lọc trên bảng hoặc danh sách (admin-layout.md § Thanh lọc): ô tìm bên trái, các bộ lọc ngay sau, thao tác của
 * bảng (cột, xuất) đẩy sang phải. Trên điện thoại ô tìm chiếm cả hàng, phần còn lại xuống dòng.
 */
export function FilterBar({
  label,
  actions,
  className,
  children,
}: {
  /** Tên vùng cho trình đọc màn hình, ví dụ "Lọc nhật ký". */
  label?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset kéo theo legend và min-width riêng, phá hàng flex-wrap.
    <div role="group" aria-label={label} className={cx("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{actions}</div>}
    </div>
  );
}

/** Ô tìm của thanh lọc. Nhãn là placeholder vì ô đứng một mình, biểu tượng kính lúp đã nói nó là gì. */
export function FilterSearch({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cx("relative w-full sm:w-64", className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
      <Input
        className="pl-8"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}
