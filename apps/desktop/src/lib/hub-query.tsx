import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { hub } from "@/lib/hub-rpc.ts";

/**
 * Một client cho mọi màn gọi hub: dữ liệu giữ lại khi chuyển màn hay giữa danh sách và chi tiết. Mỗi lời gọi đi qua
 * Rust và mạng, nên dữ liệu dưới 30 giây coi là còn mới: quay lại màn không gọi lại. Ghi xong thì các màn đã
 * invalidate, còn màn cần số liệu sống tự đặt refetchInterval.
 */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
export const api = createTanstackQueryUtils(hub);
