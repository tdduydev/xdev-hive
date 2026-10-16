import dark from "@design/assets/logos/xdev-hive-dark.svg";
import light from "@design/assets/logos/xdev-hive-light.svg";
import mark from "@design/assets/logos/xdev-hive-mark-navy.svg";
import { cn } from "@/lib/utils.ts";

/** Logo chữ theo sáng/tối (Logo.dc.html). Lấy file từ docs/design-system để app và web cùng một nguồn. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      <img src={light} alt="xDev Hive" className={cn("h-11 w-auto dark:hidden", className)} />
      <img src={dark} alt="xDev Hive" className={cn("hidden h-11 w-auto dark:block", className)} />
    </>
  );
}

/**
 * Biểu tượng X trên ô lục giác cho nền navy của AppNav: ô lục giác sáng hơn nền một bậc để vẫn thấy hình ô tổ ong. Tên
 * app luôn nằm cạnh (chữ hoặc sr-only) nên ảnh không đọc tên lần nữa.
 */
export function LogoIcon({ className }: { className?: string }) {
  return <img src={mark} alt="" className={cn("size-8", className)} />;
}
