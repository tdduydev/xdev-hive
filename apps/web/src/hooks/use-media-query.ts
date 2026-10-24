import { useSyncExternalStore } from "react";

/** Khớp `max-sm:` của Tailwind (dưới 40rem): màn điện thoại. */
export const PHONE = "(width < 40rem)";

/** Đọc thẳng matchMedia lúc render để lần vẽ đầu đã đúng bố cục, không nháy từ bảng sang thẻ như useIsMobile. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
