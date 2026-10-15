import * as vscode from "vscode";
import { t } from "@/lib/i18n.ts";
import { attachBridge } from "@/webview-host/bridge.ts";
import { renderHtml, type WebviewScreen, webviewOptions } from "@/webview-host/html.ts";

export function createPanel(ctx: vscode.ExtensionContext, screen: WebviewScreen): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    `xdev-hive.${screen}`,
    t(`webview.${screen}`),
    vscode.ViewColumn.Active,
    webviewOptions(ctx.extensionUri),
  );
  const bridge = attachBridge(panel.webview, screen);
  const closed = panel.onDidDispose(() => {
    bridge.dispose();
    closed.dispose();
  });
  ctx.subscriptions.push(panel, bridge, closed);
  panel.webview.html = renderHtml(panel.webview, ctx.extensionUri, screen);
  return panel;
}
