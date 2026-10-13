declare module "virtual:rpc-methods" {
  /** Method HTTP khác POST của thủ tục trong hợp đồng, khoá là đường dẫn nối bằng dấu chấm (src/lib/rpc-methods.ts). */
  const methods: Record<string, import("@/lib/rpc-methods.ts").RpcMethod>;
  export default methods;
}
