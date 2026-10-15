import * as vscode from "vscode";
import { lang, t } from "@/lib/i18n.ts";
import { createCsp } from "@/webview-host/csp.ts";
import type { Screen } from "../../shared/index.ts";
import "@/webview-host/strings.ts";

// Artifact tương tác cần CSP riêng, không đi qua host của các màn thông thường.
export type WebviewScreen = Exclude<Screen, "artifact-frame">;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function resourceRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "dist", "webview");
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [resourceRoot(extensionUri)] };
}

export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, screen: WebviewScreen): string {
  const { nonce, policy } = createCsp(webview.cspSource);
  const asset = (name: string) =>
    escapeHtml(webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot(extensionUri), name)).toString());
  const title = escapeHtml(t(`webview.${screen}`));
  return `<!doctype html>
<html lang="${lang()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="${asset("main.css")}">
</head>
<body data-screen="${escapeHtml(screen)}">
  <div id="root" data-title="${title}" data-empty="${escapeHtml(t("webview.empty"))}"></div>
  <script type="module" nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
}
