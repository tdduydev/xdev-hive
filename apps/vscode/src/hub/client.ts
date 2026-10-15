import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { type ContractRouterClient, inferRPCMethodFromContractRouter } from "@orpc/contract";
import { type Contract, contract } from "@xdev-hive/contracts";
import { HubError } from "@/hub/errors.ts";

export interface HubAuth {
  token(): Promise<string | undefined>;
  invalidate(): void | Promise<void>;
}
export interface HubOptions {
  hubUrl(): string;
  auth: HubAuth;
  fetch?: typeof globalThis.fetch;
}

export function orgFromToken(token: string): string {
  const org = /^hive_pat_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_\S+$/i.exec(token)?.[1];
  if (!org) throw new HubError(401);
  return org;
}

export function createHubClient(options: HubOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  let invalidatedToken: string | undefined;
  let invalidating: Promise<void> | undefined;
  // Mỗi token chỉ vô hiệu hoá một lần, kể cả khi nhiều view cùng nhận 401.
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const base = options.hubUrl().replace(/\/+$/, "");
    if (!base) throw new HubError(0);
    const token = await options.auth.token();
    if (!token) throw new HubError(401);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-hive-org", orgFromToken(token));
    if (!path.startsWith("/") || path.startsWith("//")) throw new HubError(400);
    const response = await transport(`${base}${path}`, { ...init, headers, redirect: "error" });
    if (response.status === 401) {
      if (invalidatedToken !== token) {
        invalidatedToken = token;
        invalidating = Promise.resolve().then(() => options.auth.invalidate());
      }
      await invalidating;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HubError(response.status);
    }
    return response;
  };
  const rpc: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({
      url: "http://hive.invalid/rpc",
      method: inferRPCMethodFromContractRouter(contract),
      fetch: async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        return request(url.pathname + url.search, {
          method: req.method,
          headers: req.headers,
          signal: req.signal,
          ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: await req.text() }),
        });
      },
    }),
  );
  return { rpc, request };
}
export type HubClient = ReturnType<typeof createHubClient>;
