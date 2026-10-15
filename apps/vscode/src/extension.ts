import * as vscode from "vscode";
import { register as registerAuth } from "@/auth/index.ts";
import { register as registerChatFallback } from "@/chat/fallback/index.ts";
import { register as registerChatParticipant } from "@/chat/participant/index.ts";
import { register as registerCodelens } from "@/codelens/index.ts";
import { register as registerHub } from "@/hub/index.ts";
import { initLog, log, showLog } from "@/lib/log.ts";
import { register as registerLocal } from "@/local/index.ts";
import { register as registerMcp } from "@/mcp/index.ts";
import { register as registerReview } from "@/review/index.ts";
import { register as registerTerminal } from "@/terminal/index.ts";
import { register as registerViews } from "@/views/index.ts";
import { register as registerWebviewHost } from "@/webview-host/index.ts";
import { register as registerWorker } from "@/worker/index.ts";

// Mỗi phần một dòng; thứ tự: nền (hub, auth, worker, webview-host) rồi phần dùng nền.
const SECTIONS = [
  registerHub,
  registerAuth,
  registerWorker,
  registerWebviewHost,
  registerViews,
  registerReview,
  registerChatParticipant,
  registerChatFallback,
  registerMcp,
  registerTerminal,
  registerCodelens,
  registerLocal,
];

export function activate(ctx: vscode.ExtensionContext): void {
  initLog(ctx);
  ctx.subscriptions.push(vscode.commands.registerCommand("xdevHive.showLog", showLog));
  // Một phần lỗi không được kéo cả extension chết: các phần còn lại vẫn dùng được.
  for (const register of SECTIONS) {
    try {
      register(ctx);
    } catch (error) {
      log(`Không khởi tạo được một phần: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
}

export function deactivate(): void {}
