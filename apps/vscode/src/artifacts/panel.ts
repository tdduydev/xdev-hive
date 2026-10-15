import { buildCsp, type FrameMessage, parseFrameMessage } from "@xdev-hive/artifacts-runtime";
import * as vscode from "vscode";
import { log } from "@/lib/log.ts";

const LIB_BASE = "hive-artifact://localhost/lib/";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const artifactPanelOptions = (root: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions => ({
  enableScripts: true,
  enableCommandUris: false,
  enableForms: false,
  localResourceRoots: [root],
});

export function artifactHtml(html: string, libBase: string, cspLibBase = libBase): string {
  if (!/^<!doctype html>\s*<html[^>]*>\s*<head>/i.test(html)) throw new Error("Tài liệu artifact không hợp lệ.");
  const policy = buildCsp({ libBase: cspLibBase });
  // Thu API vào closure trước mã artifact; host chỉ nhận thông điệp runtime và không đăng ký transport hub.
  return html
    .replace(
      /<head(?:\s[^>]*)?>/i,
      (head) =>
        `${head}<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}"><script>(()=>{const api=acquireVsCodeApi();window.addEventListener("message",event=>{if(event.source===window)api.postMessage(event.data);});})();</script>`,
    )
    .split(LIB_BASE)
    .join(libBase)
    .replaceAll("window.parent.postMessage", "window.postMessage");
}

export function openArtifactPanel(
  html: string,
  libraryDir: string,
  onMessage: (message: FrameMessage) => void = () => {},
): vscode.WebviewPanel {
  const root = vscode.Uri.file(libraryDir);
  const panel = vscode.window.createWebviewPanel(
    "xdev-hive.artifact-frame",
    "Artifact",
    vscode.ViewColumn.Beside,
    artifactPanelOptions(root),
  );
  const base = `${panel.webview.asWebviewUri(root).toString().replace(/\/$/, "")}/`;
  const listener = panel.webview.onDidReceiveMessage((data: unknown) => {
    const message = parseFrameMessage(data);
    if (message) onMessage(message);
    else log("Đã bỏ qua thông điệp artifact không hợp lệ.");
  });
  panel.onDidDispose(() => listener.dispose());
  // Host tài nguyên của VS Code có dấu +; CSP dùng wildcard chính thức để Chromium chấp nhận nguồn.
  const source = panel.webview.cspSource.split(/\s+/).find((value) => value.startsWith("https://"));
  if (!source) {
    panel.dispose();
    throw new Error("Nguồn tài nguyên VS Code không hợp lệ.");
  }
  const cspBase = `${source}${new URL(base).pathname}`;
  panel.webview.html = artifactHtml(html, base, cspBase);
  return panel;
}
