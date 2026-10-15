import * as vscode from "vscode";
import { attachBridge } from "@/webview-host/bridge.ts";
import { renderHtml, type WebviewScreen, webviewOptions } from "@/webview-host/html.ts";

export function registerView(ctx: vscode.ExtensionContext, viewId: string, screen: WebviewScreen): vscode.Disposable {
  const active = new Set<vscode.Disposable>();
  const provider = vscode.window.registerWebviewViewProvider(viewId, {
    resolveWebviewView(view) {
      view.webview.options = webviewOptions(ctx.extensionUri);
      const bridge = attachBridge(view.webview, screen);
      const closed = view.onDidDispose(() => {
        bridge.dispose();
        active.delete(bridge);
        active.delete(closed);
        closed.dispose();
      });
      active.add(bridge);
      active.add(closed);
      view.webview.html = renderHtml(view.webview, ctx.extensionUri, screen);
    },
  });
  const registration = new vscode.Disposable(() => {
    provider.dispose();
    for (const item of active) item.dispose();
    active.clear();
  });
  ctx.subscriptions.push(registration);
  return registration;
}
