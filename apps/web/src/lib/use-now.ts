import { useEffect, useState } from "react";

/** Giờ hiện tại, cập nhật mỗi `intervalMs` khi `active` (vd. run đang chạy cần đồng hồ chạy); tắt thì đứng yên. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
