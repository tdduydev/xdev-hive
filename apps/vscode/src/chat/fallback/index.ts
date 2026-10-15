import * as vscode from "vscode";
import { createPanel } from "@/webview-host/index.ts";

// Lệnh luôn có, kể cả khi editor có khung Chat: người dùng không phụ thuộc vào `vscode.chat` (Cursor, Windsurf, bản cũ).
export function register(ctx: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  ctx.subscriptions.push(
    vscode.commands.registerCommand("xdevHive.openChat", () => {
      // Một tab chat: bấm lại thì đưa tab đang mở lên thay vì mở thêm bản có cuộc trò chuyện lệch nhau.
      if (panel) {
        panel.reveal();
        return;
      }
      const created = createPanel(ctx, "chat");
      panel = created;
      created.onDidDispose(() => {
        if (panel === created) panel = undefined;
      });
    }),
  );
}
