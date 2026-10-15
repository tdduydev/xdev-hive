import * as vscode from "vscode";
import { redact } from "@/lib/redact.ts";

let channel: vscode.OutputChannel | undefined;

export function initLog(ctx: vscode.ExtensionContext): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("xDev Hive");
  ctx.subscriptions.push(channel);
  return channel;
}

// Mọi dòng qua redact: lỗi từ hub hay binary có thể kèm token mà người gọi không biết.
export function log(message: string): void {
  channel?.appendLine(`${new Date().toISOString()} ${redact(message)}`);
}

export function showLog(): void {
  channel?.show(true);
}
