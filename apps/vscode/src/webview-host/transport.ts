import type { RpcTransport } from "@/webview-host/types.ts";

let transport: RpcTransport | undefined;

/** Hub đăng ký transport đã xác thực; token chỉ tồn tại ở extension host. */
export function provideRpcTransport(next: RpcTransport | undefined): { dispose(): void } {
  transport = next;
  return {
    dispose() {
      if (transport === next) transport = undefined;
    },
  };
}

export function getRpcTransport(): RpcTransport | undefined {
  return transport;
}
