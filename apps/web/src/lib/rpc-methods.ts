import { type AnyContractRouter, inferRPCMethodFromContractRouter, isContractProcedure } from "@orpc/contract";

export type RpcMethod = ReturnType<ReturnType<typeof inferRPCMethodFromContractRouter>>;

/**
 * Method HTTP khác POST của từng thủ tục ("me.get" -> "GET"). vite.config.ts tính bảng này từ hợp đồng lúc build và
 * đưa vào `virtual:rpc-methods`: client chỉ cần biết method, import cả hợp đồng vào trình duyệt thì bundle đầu kéo theo
 * zod và mọi schema (~170 KB). Thủ tục không có trong bảng là POST, mặc định của oRPC.
 */
export function contractMethods(contract: AnyContractRouter): Record<string, RpcMethod> {
  const infer = inferRPCMethodFromContractRouter(contract);
  const methods: Record<string, RpcMethod> = {};
  const walk = (node: unknown, path: string[]) => {
    if (isContractProcedure(node)) {
      const method = infer({}, path);
      if (method !== "POST") methods[path.join(".")] = method;
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    }
  };
  walk(contract, []);
  return methods;
}

export const methodOf = (methods: Record<string, RpcMethod>, path: readonly string[]): RpcMethod =>
  methods[path.join(".")] ?? "POST";
