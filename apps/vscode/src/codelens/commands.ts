import { basename } from "node:path";
import * as vscode from "vscode";
import { t } from "@/lib/i18n.ts";
import "@/codelens/strings.ts";

export type AssignTaskArg = { uri: string; code: string; spec: string; title: string };
export type AssignSymbolArg = { uri: string; name: string; kind: string; startLine: number; endLine: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function taskArg(value: unknown): AssignTaskArg | undefined {
  if (isObject(value) && text(value.uri) && text(value.code) && text(value.spec) && typeof value.title === "string")
    return { uri: value.uri, code: value.code, spec: value.spec, title: value.title };
  return undefined;
}

export function symbolArg(value: unknown): AssignSymbolArg | undefined {
  if (
    isObject(value) &&
    text(value.uri) &&
    text(value.name) &&
    text(value.kind) &&
    Number.isInteger(value.startLine) &&
    Number.isInteger(value.endLine)
  )
    return value as AssignSymbolArg;
  return undefined;
}

/** Khung Chat `@hive /giao` nếu có; không thì màn chat dự phòng. Cả hai nhận cùng lời nhắc làm bản nháp, chưa gửi. */
async function openDraft(prompt: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: `@hive /giao ${prompt}`,
      isPartialQuery: true,
    });
  } catch {
    await vscode.commands.executeCommand("xdevHive.openChat", { draft: prompt });
  }
}

export function registerCommands(ctx: vscode.ExtensionContext): void {
  const guard = (): boolean => {
    // Lens đã ẩn ở Restricted Mode; chặn thêm ở lệnh vì lệnh gọi được từ nơi khác.
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showInformationMessage(t("codelens.untrusted"));
    return false;
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand("xdevHive.codelens.assignTask", async (value: unknown) => {
      const arg = taskArg(value);
      if (!arg || !guard()) return;
      await openDraft(t("codelens.promptTask", { code: arg.code, spec: arg.spec, title: arg.title }));
    }),
    vscode.commands.registerCommand("xdevHive.codelens.assignSymbol", async (value: unknown) => {
      const arg = symbolArg(value);
      if (!arg || !guard()) return;
      const uri = vscode.Uri.parse(arg.uri);
      await openDraft(
        t("codelens.promptSymbol", {
          kind: arg.kind,
          name: arg.name,
          file: vscode.workspace.asRelativePath(uri, false) || basename(uri.fsPath),
          start: arg.startLine + 1,
          end: arg.endLine + 1,
        }),
      );
    }),
  );
}
