import dark from "@design/assets/logos/xdev-hive-dark.svg";
import icon from "@design/assets/logos/xdev-hive-icon.svg";
import light from "@design/assets/logos/xdev-hive-light.svg";
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

/** Biểu tượng X trên ô lục giác navy, dùng khi AppNav thu gọn. */
export function LogoIcon({ className }: { className?: string }) {
  return <img src={icon} alt="xDev Hive" className={cn("size-8", className)} />;
}
