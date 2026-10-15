import type * as vscode from "vscode";
import { provideRpcTransport } from "@/webview-host/transport.ts";
import "@/webview-host/strings.ts";

export { attachBridge, type RpcReply, type RpcRequest, type RpcTransport } from "@/webview-host/bridge.ts";
export type { WebviewScreen } from "@/webview-host/html.ts";
export { createPanel } from "@/webview-host/panel.ts";
export { provideRpcTransport } from "@/webview-host/transport.ts";
export { registerView } from "@/webview-host/view.ts";

export function register(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push({
    dispose: () => {
      provideRpcTransport(undefined);
    },
  });
}
