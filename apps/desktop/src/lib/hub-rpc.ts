import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { type ContractRouterClient, inferRPCMethodFromContractRouter } from "@orpc/contract";
import { type Contract, contract } from "@xdev-hive/contracts";
import { invoke } from "@/lib/tauri.ts";

interface RpcReply {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Gửi request RPC qua lệnh Rust `hub_rpc`: Rust gắn token cá nhân trong keychain và tổ chức của token, nên giao diện
 * không bao giờ thấy token. Địa chỉ trong `request.url` chỉ để lấy đường dẫn; Rust gọi đúng hub máy đã đăng ký.
 */
async function viaRust(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const reply = await invoke<RpcReply>("hub_rpc", {
    method: request.method,
    path: url.pathname + url.search,
    body: request.method === "GET" ? null : await request.text(),
    contentType: request.headers.get("content-type"),
  });
  return new Response(reply.body, { status: reply.status, headers: { "content-type": reply.contentType } });
}

/** Client có kiểu của hub, cùng hợp đồng với web (spec 008 FR-026, FR-027). */
export const hub: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "http://hub.local/rpc",
    method: inferRPCMethodFromContractRouter(contract),
    fetch: viaRust,
  }),
);
