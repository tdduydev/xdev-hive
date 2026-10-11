import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

/** Bảng theo mockup; cuộn ngang trên màn hẹp thay vì bóp cột. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className={cx("w-full min-w-130 border-collapse text-label", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cx(
        "border-b border-line px-3 py-2 text-left text-2xs font-semibold tracking-caps text-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cx("border-b border-line px-3 py-2.5 align-middle [tr:last-child>&]:border-b-0", className)}
      {...props}
    />
  );
}
