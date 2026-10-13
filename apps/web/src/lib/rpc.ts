import rpcMethods from "virtual:rpc-methods";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";
import type { Contract } from "@xdev-hive/contracts";
import { methodOf } from "@/lib/rpc-methods.ts";

/** Header hub đọc để biết tổ chức đang làm việc. */
export const ORG_HEADER = "x-hive-org";

type HubClient = ContractRouterClient<Contract>;

function createClient(headers: Record<string, string> = {}): HubClient {
  const link = new RPCLink({
    url: () => `${window.location.origin}/rpc`,
    // Gọi đúng method khai báo trong hợp đồng: thủ tục chỉ đọc như me.get đi bằng GET thay vì POST mặc định.
    method: (_, path) => methodOf(rpcMethods, path),
    headers,
  });
  return createORPCClient(link);
}

/** Client không gắn tổ chức: chỉ dùng cho thủ tục không cần tổ chức (me, orgs.mine, orgs.create). */
export const client = createClient();
export const orpc = createTanstackQueryUtils(client);

export type OrgApi = RouterUtils<HubClient>;

const byOrg = new Map<string, OrgApi>();

/**
 * API trong một tổ chức. Mỗi tổ chức có client riêng gắn sẵn header và khoá cache riêng (tiền tố ["org", id]):
 * đổi tổ chức thì request còn đang chạy của tổ chức cũ vẫn ghi vào cache của tổ chức cũ, không lẫn sang trang mới.
 */
export function orgApi(orgId: string): OrgApi {
  let api = byOrg.get(orgId);
  if (!api) {
    api = createTanstackQueryUtils(createClient({ [ORG_HEADER]: orgId }), { path: ["org", orgId] });
    byOrg.set(orgId, api);
  }
  return api;
}
