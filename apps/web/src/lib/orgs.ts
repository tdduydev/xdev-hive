import { orpc } from "./rpc.ts";

/** Tổ chức của người đang đăng nhập và quyền tạo tổ chức. Không cần header tổ chức. */
export const orgsMineQuery = orpc.orgs.mine.queryOptions({ staleTime: 60_000 });
