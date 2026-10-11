import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { type ContractRouterClient, inferRPCMethodFromContractRouter } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { type Contract, contract } from "@xdev-hive/contracts";

const link = new RPCLink({
  url: () => `${window.location.origin}/rpc`,
  // Gọi đúng method khai báo trong hợp đồng: thủ tục chỉ đọc như me.get đi bằng GET thay vì POST mặc định.
  method: inferRPCMethodFromContractRouter(contract),
});
export const client: ContractRouterClient<Contract> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);
