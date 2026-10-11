import { ORPCError } from "@orpc/client";
import { queryOptions } from "@tanstack/react-query";
import type { Me } from "@xdev-hive/contracts";
import { client } from "./rpc.ts";

/** Người đang đăng nhập, hoặc null khi chưa đăng nhập. Lỗi khác (mất mạng, hub lỗi) vẫn ném ra để hiện màn lỗi. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await client.me.get();
    } catch (error) {
      if (error instanceof ORPCError && error.code === "UNAUTHORIZED") return null;
      throw error;
    }
  },
  staleTime: 5 * 60_000,
});
